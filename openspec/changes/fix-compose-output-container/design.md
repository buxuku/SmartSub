## Context

合成引擎的每种成片形态都会写 H.264（硬烧必然重编码）或 AAC（配音替换/混音/双轨、`webm → mp4` 的原声转码）。但默认输出路径是「源文件名 + 源扩展名」，在 4 处各自实现：渲染层 `extension()`、主进程 `generateOutputPath()`（也是 `startMerge` 以及 CLI/MCP `compose.run` 未传 `outputPath` 时的回退）、流水线 `deriveComposeConfig`、配音导出 `resolveOutputPath`。

下载器（yt-dlp）产出的 `.webm` 是 VP9 + Opus。用 ffmpeg-static 5.2.0（ffmpeg 6.0）实测：同一个源写 `mp4` 或 `matroska` 退出码 0；常见 muxer 里只有 `webm / ogg / ogv` 在写文件头时拒绝 H.264/AAC。

错误可见性方面，`fluent-ffmpeg` 2.1.3 的 `utils.extractError` 遇到以 `[` 或空格开头的行就清空已收集内容；ffmpeg 6 的原因行都带 `[组件 @ 0x…]` 前缀。完整 stderr 作为 error 回调第 3 个参数传出，合成执行层没有使用。#370 已在音频提取路径上做过「把 stderr 最后一行补进空消息」（`ffmpegErrorUtils.ts`），合成引擎未覆盖。

## Goals / Non-Goals

**Goals:**

- 任何默认路径都不产生 WebM/Ogg 成品；显式给出 WebM/Ogg 输出时，在 ffmpeg 启动前给出可操作的错误。
- 不改变其它源扩展名与既有组合的默认命名、命令参数。
- 失败时用户和日志能看到 ffmpeg 的真实原因。
- 硬烧交给 libx264 的输入合法：只送真正的视频流（不含封面图），宽高为偶数。

**Non-Goals:**

- 硬烧模式的显式容器选择器（软封模式本来就有）。
- 在硬烧成品里保留内嵌封面图（硬烧本来就重编码，封面此前只会让作业失败）。
- `main/helpers/toolbox/videoTrimmer.ts` 精确重编码模式（libx264 + aac 写源扩展名）的同类缺陷。
- 合并 `ffmpegErrorUtils`（#370）与新的失败摘要逻辑。

## Decisions

**1. 容器可写性是共享的纯函数，用黑名单。** 新增 `types/composeContainer.ts`（不依赖 `node:path`，主进程与渲染层共用）：`.webm .ogv .ogg` 不可写，其余一律视为可写。
备选：白名单（只放行 mp4/mkv/mov）。否决：`avi/flv/ts/3gp/wmv` 等源今天能正常出片，白名单会无谓地改变它们的行为；黑名单只收录已验证会失败的容器，回归面最小。

**2. 回退容器是 `.mp4`，常量只有一个（`FALLBACK_COMPOSE_EXTENSION`）。** 硬烧产物本来就是 H.264，MP4 兼容性最好，且已有 faststart 处理；用户仍可手选 `.mkv`。
备选：`.mkv`。否决：Matroska 什么都收，但播放器、剪辑软件与投稿站的兼容性不如 MP4，不适合作为默认成品。

**3. 三层保护，而不是只改默认值。**
(a) 默认值不再产生 WebM/Ogg；(b) 引擎入口拒绝显式的 WebM/Ogg 输出（`enqueueCompose` 同步失败、`runComposeJob` 在建暂存目录与启动 ffmpeg 之前、`buildComposePlan` 兜底）；(c) 真实原因可见。
对显式路径选择「拒绝」而不是「悄悄改扩展名」：显式路径是调用方（CLI/MCP/界面）的契约，悄悄改写会让成品出现在调用方没想到的位置；拒绝可测试、可解释，且此前这类路径必然在 ffmpeg 里失败，没有可依赖的既有行为。

**4. 音频规则只覆盖「WebM/Ogg 源 → MP4 系输出」。** 硬烧 + 保留原声时，这个组合的原声（Opus/Vorbis）转 AAC 192k；其余组合保持 `-c:a copy`。
ffmpeg 6 能把 Opus 直拷进 MP4，但 QuickTime、剪辑软件和投稿站对 MP4 里的 Opus 支持不稳，`.mov/.m4v` 还会拒绝一部分。限定组合是为了不动其它既有行为；用户手选 `.mkv` 时仍是无损直拷。

**5. 失败摘要取「失败簇」，原始英文行直接展示。** `main/helpers/compose/ffmpegFailure.ts`：去掉对象地址与缩进的结构行，丢弃包装行、进度与反复刷屏的良性告警，取最后一条关键词行及与它连续的关键词行（至多 8 行）；没有关键词行时回退展示末尾几行；找不到任何内容时原错误原样返回。
规则全部由真实 ffmpeg 6.0 输出驱动，9 个真实失败作为测试夹具入库（含「写到一半管道被关闭，原因行被 libass/CoreText 刷屏隔开、后面跟着 x264 统计」这种最难的形态）。
备选：(a) 沿用 #370 的「补最后一行」——否决，合成失败是连环报错，根因在最上面，最后一行往往只是后果或信息行；(b) 把整段 stderr 放进界面——否决，太吵；(c) 为每种原因写本地化映射——否决，覆盖面不可穷尽，而 ffmpeg 的原话可搜索、与日志一致。完整的末尾 40 行以 error 级别写进日志。
`withFfmpegFailureReason` 只改写 `ffmpeg exited with code N` 开头的错误，原错误挂在 `cause` 上；被信号杀死、启动失败、取消不受影响。

**6. 硬烧只映射真正的视频流：`-map 0:V`。** 硬烧要把被映射的每一路视频都过字幕滤镜并交给 libx264；`0:v` 会连内嵌封面（`Video: mjpeg … (attached pic)`）一起映射，封面被重编码成 h264 后 MP4 muxer 写不了（`Could not find tag for codec h264 in stream #1`）。ffmpeg 的 `V`（大写）语义就是「不含封面图、缩略图的视频流」，在 ffmpeg 6.0 上实测只选中真正的视频。只改 `keep`/`replace`/`addTrack` 三个重编码分支；软封装与无字幕是 `-c copy`，封面照常保留，仍用 `0:v`；hard+mix 用 filter_complex 的 `[0:v]` 标签，只取第一路视频流，在带封面的文件上实测不受影响。
备选：(a) 保留 `0:v`，给封面单独写 `-c:v:N copy`——否决：要在命令里知道封面的流序号（得先 ffprobe），而硬烧本来就不承诺保留封面；(b) `-map 0:v -map -0:v:1` 排除固定序号——否决：封面的位置不固定。

**7. 奇数宽/高用 `crop` 向下取偶，放在字幕滤镜之后。** 所有硬烧滤镜链为 `<字幕滤镜>,crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0[,format=nv12]`。表达式随画面自适应，构建器不需要知道分辨率；偶数宽高时是空操作；x/y 显式写 0，丢掉右/下多出的 1 像素，不依赖默认的居中取整。放在字幕滤镜之后，ASS 仍按原始画面渲染，字幕位置不变；放在 `format=nv12` 之前，硬件编码器的输入同样是偶数宽高。已在 `translatedAssFilter` 的 overlay 多链图（`overlay=…` 结尾）与 `format=nv12` 的组合上用真实 ffmpeg 验证。
备选：(a) `scale=trunc(iw/2)*2:trunc(ih/2)*2`——否决：为了 1 像素把每一帧重采样；(b) `pad=ceil(iw/2)*2:ceil(ih/2)*2`——否决：保住全部内容的代价是边缘多一条黑线；(c) 探测到奇数才加滤镜——否决：构建器是纯函数，不知道分辨率，而表达式本身已经是空操作，探测只会多一次 ffprobe。
说明：失败只在 libx264 上复现；`h264_videotoolbox` 自己能处理奇数尺寸，NVENC/QSV/AMF 没有条件验证，这一步只是让所有编码器拿到的都是偶数宽高。

## Risks / Trade-offs

- [摘要启发式在没见过的输出上选错行] → 消息始终保留 `ffmpeg exited with code N:` 前缀，完整末尾写入日志；无关键词时回退末尾行，什么也找不到时保持原错误；规则逐条做过变异检查，每条都有测试守着。
- [黑名单漏掉别的拒绝 H.264 的容器] → 这类失败现在会带着真实原因显示，下次补进 `UNWRITABLE_EXTENSIONS` 即可。
- [CLI/MCP 调用方此前显式传 `.webm` 输出] → 此前必然在 ffmpeg 里失败，现在得到明确的修复建议，没有可工作的流程被破坏。
- [`.ogv` 源配音导出的 `-c:v copy` 把 Theora 写进 MP4 仍会失败] → 罕见，且失败原因现在可见；不在本次范围。
- [`webm → avi/flv/3gp` 手选容器时 Opus 直拷仍可能失败] → 同上，原因可见。
- [奇数尺寸的源硬烧后少 1 像素（右/下边缘）] → 肉眼不可见，比重采样的整帧轻微模糊或边缘黑线都轻；此前这类源直接失败。
- [硬烧成品不再带封面] → 硬烧必然重编码，封面此前只会让作业失败；需要保留封面的用户可用软封装（`-c copy`）。
- [同一症状可能还有别的成因] → 真实原因现在可见，下次按它补规则即可。
