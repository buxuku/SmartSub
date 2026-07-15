# Proposal: 视频合成硬件加速编码

## Why

硬字幕烧录是全应用唯一重编码视频的路径，目前固定使用 `libx264`（CPU）编码，长视频/4K 合成耗时长、风扇狂转，而打包的 ffmpeg-static 在 macOS（VideoToolbox）与 Windows（NVENC/QSV）上已内置硬件编码器，硬件编码通常可带来 2~10 倍的合成提速。用户应能自主选择用速度换体积（硬件编码同等观感下体积通常为 CPU 编码的 1.3~2 倍）。

## What Changes

- 合成输出行动条新增「编码方式」选项：CPU（默认，体积更小）/ 硬件加速（速度更快），仅硬字幕烧录模式显示；Linux 平台隐藏（打包的 ffmpeg 静态构建无硬件编码器）；未检测到可用硬件时禁用并说明原因。
- 新增主进程硬件编码器探测模块：按平台候选（mac: `h264_videotoolbox`；win: `h264_nvenc` > `h264_qsv`，第一期不含 AMF）用黑帧试编码做真实能力探测（带目标画质参数），会话级缓存，IPC 暴露探测结果。
- 硬字幕烧录分支按所选编码方式选择编码器，画质档位（original/high/standard）映射为各编码器的恒定质量参数；Intel Mac VideoToolbox 不支持恒定质量，走源码率估算的码率模式分支。
- 硬件编码路径滤镜链追加 `format=nv12`，兜住 10-bit/4:2:2 源（硬件编码器仅接受 8-bit）。
- 硬件编码合成中途失败（非用户取消）时自动回退 `libx264` 从头重跑一次，并以日志+界面提示告知用户。
- 选择「硬件加速」时展示体积增大提示（tooltip 常驻说明 + 选中时内联提示），zh/en 文案。
- `outputMode`、`videoQuality`、`encoderMode` 三项合成偏好一起持久化，面板挂载时恢复。

## Capabilities

### New Capabilities

- `merge-encoder-selection`: 合成编码方式选择——硬件编码器运行时探测与缓存、编码方式 UI（默认 CPU、平台可见性、不可用禁用态）、体积增大提示、合成偏好持久化。

### Modified Capabilities

- `subtitle-burn-encoding`: 「显式编码器」要求从固定 `-c:v libx264` 改为按所选编码方式显式选定编码器；画质档位从 libx264 CRF 映射扩展为按编码器的质量参数映射（含 4K 自适应偏移的等价平移、Intel VT 码率分支）；新增硬件编码失败自动回退要求。

## Impact

- **主进程**：`main/helpers/subtitleMerger.ts`（编码分支）、新增 `main/helpers/hwEncoderDetector.ts`（探测与缓存）、`main/helpers/ipcSubtitleMergeHandlers.ts`（探测 IPC + 回退通知）、`main/helpers/store/`（合成偏好持久化）。
- **类型**：`types/subtitleMerge.ts`（`MergeConfig.encoderMode`、探测结果类型、质量映射表）。
- **渲染层**：`renderer/components/subtitleMerge/MergeButton.tsx`（编码方式控件 + 提示）、`hooks/useSubtitleMerge.ts`（状态 + 持久化读写）、`renderer/public/locales/{zh,en}/subtitleMerge.json`。
- **依赖**：无新增（复用 ffmpeg-static 内置编码器）；Linux/AMF 留待后续迭代。
- **兼容性**：`encoderMode` 缺省 `cpu`，未传时行为与现状完全一致，无破坏性变更。
