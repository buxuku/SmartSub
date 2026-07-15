# Design: 视频合成硬件加速编码

## Context

硬字幕烧录（`subtitleMerger.ts` 的 hardcode 分支）是全应用唯一重编码视频的路径，现固定 `-c:v libx264 -preset medium -crf N`（N 由画质档位 18/20/23 + 4K 偏移 +2 决定），音频 `-c:a copy`。软字幕封装与配音管线均为流复制，不涉及本变更。

打包的 `ffmpeg-static@5.2.0`（ffmpeg 6.0）各平台二进制来源不同，硬件编码器能力差异大：

| 平台            | 来源                  | 硬件编码器                             | 关键差异                                                                   |
| --------------- | --------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| macOS ARM/Intel | osxexperts / evermeet | `h264_videotoolbox`                    | 编码器在即基本可用；但恒定质量 `-q:v` 仅 Apple Silicon 支持                |
| Windows x64     | gyan.dev              | `h264_nvenc` / `h264_qsv` / `h264_amf` | 三者永远在 `-encoders` 列表里，能否真跑取决于用户显卡+驱动，必须运行时探测 |
| Linux           | johnvansickle         | 无                                     | 纯静态构建无法链接 CUDA/libva，本期不支持                                  |

已确认的产品决策：默认 CPU（opt-in）；第一期 Windows 只上 NVENC + QSV（AMF 二期）；Intel Mac 若成本可控则支持；硬件编码失败自动回退；`outputMode`/`videoQuality`/`encoderMode` 一起持久化；选择硬件加速时提示体积可能增大。

## Goals / Non-Goals

**Goals:**

- 硬字幕烧录支持硬件加速编码，用户可在合成行动条一键选择，合成速度显著提升（预期 2~10 倍）。
- 硬件能力真实探测（非仅看编码器列表），探测结果驱动 UI 可见性/禁用态。
- 画质档位语义在硬件路径下保持连续（original/high/standard 仍是画质承诺）。
- 硬件编码失败不让用户白等：自动回退 CPU 重跑并告知。
- 合成偏好持久化，下次打开面板恢复。

**Non-Goals:**

- Linux 硬件加速（打包 ffmpeg 不具备，选项整体隐藏）。
- AMD AMF 编码器（参数最不统一、覆盖最少，二期再评估）。
- HEVC/AV1 输出、硬件解码（`-hwaccel`）、全 GPU 滤镜管线（字幕滤镜必须在 CPU 侧，收益集中在编码端）。
- 约束质量模式（CQ + maxrate 封顶体积）：需要源码率探测，作为二期可选优化。
- libx264 现有行为的任何改动（CRF 档位、4K 偏移、faststart 均保持原样）。

## Decisions

### D1: 画质策略——恒定质量映射为主（路线 A），码率模式仅作 Intel VT 补充分支

对比过两条路线：A) 每编码器维护「档位 → 恒定质量参数」映射；B) 探测源码率、按档位系数设定目标码率。选 A，理由：

- 现有 UI 的画质档位是画质承诺，A 保持语义连续；B 把"原画质"偷换成"原体积"，对高效源（HEVC 等）同码率重编 H.264 会可见掉画质（信任级失败），对低效源（相机直出高码率）又会浪费几倍体积——两个方向都失手。
- 应用未打包 ffprobe，B 依赖的源码率探测链路脆弱（MKV 常拿不到视频流码率）；A 不需要任何源信息。
- A 的短板（体积不可预期）恰好由产品层的体积提示 + 校准表上调 CQ 值（相对 CRF +1~2）双重缓解。

码率模式仅在 VideoToolbox 恒定质量探测失败时（即 Intel Mac）作为该编码器的降级分支启用，不推广到其它编码器。

### D2: 能力探测——带目标参数的黑帧试编码，而非平台/架构嗅探

探测命令形如：`ffmpeg -f lavfi -i color=black:s=640x360:d=0.1 -c:v <encoder> <质量参数> -f null -`，成功即可用。要点：

- **带上正式合成将使用的质量参数**探测（如 VT 带 `-q:v`），把「编码器能跑」和「参数被支持」一次验清。VT 的 `-q:v` 探测失败 → 自动改用码率参数二次探测 → 通过则标记该编码器为码率模式。这样 Apple Silicon / Intel Mac / Rosetta 等情况全部自动分流，无需 `process.arch` 嗅探。
- 640×360 测试帧避开 NVENC 最小分辨率限制。
- Windows 候选按 `h264_nvenc` > `h264_qsv` 优先级探测，取第一个可用者；QSV 的 ICQ（`-global_quality`）探测失败即视为不可用，不为其开码率分支（控制第一期复杂度）。
- 探测在合成面板首次挂载时经 IPC 异步触发，主进程内存缓存整个会话（试编码单个约 0.3~1s，Windows 最坏 ~2s）；不持久化缓存，避免用户换显卡/升驱动后结果过期。

### D3: 画质参数映射初值（实现期需实测校准）

| 编码器                               | original             | high  | standard | 4K 偏移（高度≥1800） | 附加参数                    |
| ------------------------------------ | -------------------- | ----- | -------- | -------------------- | --------------------------- |
| libx264（现状不动）                  | CRF 18               | 20    | 23       | +2                   | `-preset medium`            |
| h264_nvenc                           | `-cq 19`             | 21    | 24       | +2                   | `-rc vbr -b:v 0 -preset p5` |
| h264_qsv                             | `-global_quality 19` | 21    | 24       | +2                   | —                           |
| h264_videotoolbox（CQ 模式）         | `-q:v 65`            | 58    | 50       | -5（量纲反向）       | `-realtime 0`               |
| h264_videotoolbox（码率模式，Intel） | 源码率×1.0           | ×0.85 | ×0.65    | 不叠加               | `-maxrate 1.5x -bufsize 2x` |

- CQ 值相对 libx264 CRF 整体 +1（18→19 等）：牺牲少量画质换体积贴近，缓解硬件编码体积膨胀。
- 码率模式的源码率估算：总码率 = `VideoInfo.size × 8 / duration`（数据现成），视频码率 ≈ 总码率 × 0.85，按分辨率钳上下限（如 1080p 钳 [1, 20] Mbps 量级，实现期定）。
- 映射表集中定义在 `types/subtitleMerge.ts`，与 `VIDEO_QUALITY_CRF` 并列，便于校准调整。

### D4: 像素格式——硬件路径滤镜链末尾追加 `format=nv12`

硬件 H.264 编码器仅接受 8-bit 4:2:0；10-bit/4:2:2 源经字幕滤镜后直接送硬件编码器会失败。硬件路径在字幕滤镜后追加 `format=nv12` 统一转换。libx264 路径不动（现状对 10-bit 源编 high10 profile，行为保持）。

### D5: 自动回退——试编码前置拦截 + 合成中途失败重跑一次

- 探测通过后正式合成仍可能失败（驱动异常、ffmpeg 6.0 gyan 构建在老 N 卡上的已知 NVENC 特性报错等）。
- 回退条件：`encoderMode === 'hardware'` 且失败非用户取消（复用 `mergeCancelled` 哨兵）→ 记录 warning 日志 → 通过进度事件通知渲染层「已自动切换 CPU 编码重试」→ 以 libx264 参数从 0% 重跑，**仅重试一次**。
- 半成品输出文件按现有 `cleanupPartialOutput` 逻辑先清理再重跑。

### D6: UI 与持久化

- `MergeButton` 行动条新增「编码方式」分段控件（复用输出方式分段控件样式）：`CPU · 体积更小` / `硬件加速 · 速度更快`，仅 hardcode 模式显示（softmux 不编码）。
- 可见性/禁用态：Linux 隐藏整个控件；探测无可用编码器时硬件项禁用 + tooltip 说明；探测结果含编码器名（如 "NVIDIA NVENC"），可在 tooltip/说明中展示。
- 体积提示两层：分段控件 tooltip 常驻说明速度/体积权衡；选中硬件时行动条下方内联提示（复用 `outputPathRequiredHint` 的样式先例），文案大意"硬件加速大幅提升合成速度，但相同画质下输出体积可能比 CPU 编码大 30%~100%"。
- 命名避开「GPU 加速」字样（设置页已被 whisper 转录后端占用），统一用「编码方式 / 硬件加速」。
- 持久化：`{ outputMode, videoQuality, encoderMode }` 存入 electron-store（经现有 ipcStoreHandlers 通道），面板挂载时读取恢复，变更即写。`encoderMode` 持久化为 `'hardware'` 但当前会话探测不可用时，UI 回落 CPU 显示并禁用硬件项（不改写存储值，换回有硬件的环境自动恢复）。

### D7: 类型与 IPC 形状

- `MergeConfig` 新增 `encoderMode?: 'cpu' | 'hardware'`，缺省 `'cpu'`（未传时与现状完全一致，向后兼容）。
- 主进程按探测缓存把 `'hardware'` 解析为具体编码器与参数；渲染层不直接指定编码器 ID（避免渲染层持有过期探测结果）。
- 新增 IPC `subtitleMerge:getHwAccelInfo` → `{ available: boolean, encoderId?: string, encoderLabel?: string, rateMode?: 'cq' | 'bitrate', platformSupported: boolean }`。

## Risks / Trade-offs

- [硬件编码体积膨胀引发用户困惑] → 双层 UI 提示 + CQ 初值整体上调 1 档；默认 CPU，opt-in 才会遇到。
- [画质映射初值与 libx264 档位观感不一致] → 映射表标注为实现期校准项，集中定义便于调整；tasks 中含真实素材对比验证任务。
- [试编码通过但正式合成中途失败，重跑浪费时间] → 此类失败通常发生在编码启动阶段（秒级），且仅重试一次；回退过程有日志与界面提示，不静默。
- [码率估算误差（Intel VT 分支）] → 该分支仅覆盖 Intel Mac 且该硬件编码质量本就一般，估算含 0.85 音频扣除系数 + 分辨率钳位，误差可接受；估算失败（时长为 0 等）则该编码器视为不可用，走 CPU。
- [探测延迟阻塞 UI] → 探测异步进行，未返回前硬件项呈 loading/禁用态，不阻塞 CPU 路径合成。
- [多显卡机器探测到的编码器非用户预期] → 第一期按固定优先级（NVENC > QSV）取第一可用，tooltip 展示实际编码器名；自定义选择二期再议。

## Open Questions

- 画质映射初值（D3 表格）需在真实素材上校准：各档位与 libx264 对应档位做体积/观感对比，允许实现期微调 ±2。
- VT 码率模式的分辨率钳位区间在实现期用 720p/1080p/4K 样片定值。
