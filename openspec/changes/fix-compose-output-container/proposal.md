## Why

issue #521：用户用下载器拿到 `.webm` 源视频（VP9 + Opus），在合成页选「硬烧字幕 + CPU + 原画质」，点击合成后界面只剩一句 `ffmpeg exited with code 1: Conversion failed!`。

根因有两个，且缺一不可：

1. **默认输出容器照抄源视频扩展名。** `.webm` 源得到 `.webm` 输出，而硬烧必然重编码为 H.264、配音导出写 AAC；WebM/Ogg 容器只接受 VP8/VP9/AV1 + Vorbis/Opus，muxer 在写文件头时就拒绝。这个默认值在渲染层、主进程默认路径（含 CLI/MCP 的回退）、流水线成品、配音导出共 4 处各抄了一遍，自首个合并提交起就存在。
2. **真实原因被吞。** fluent-ffmpeg 拼错误消息时，遇到以 `[` 或空格开头的行就清空已收集内容，而 ffmpeg 6 的原因行恰好都带 `[组件 @ 0x…]` 前缀；完整 stderr 其实传给了 error 回调，却被忽略。结果是不同原因给出逐字相同的报错（奇数宽度的 yuv420p 源经 libx264 同样只显示 `Conversion failed!`），用户与维护者都无从判断。

## What Changes

- 合成默认成品容器**永不是 WebM/Ogg**：源为 `.webm/.ogv/.ogg` 时，硬烧、配音导出、流水线成品默认输出 `.mp4`；软封字幕或双音轨仍是 `.mkv`；其余源扩展名的行为不变。
- 引擎**拒绝**写 WebM/Ogg 输出：在入队、作业执行（建暂存目录与启动 ffmpeg 之前）、命令构建三处给出可读的错误，并提示改用 `.mp4` 或 `.mkv`。
- 硬烧 + 保留原声时，**WebM/Ogg 源写入 MP4 系容器**（`.mp4/.m4v/.mov`）把原声转为 AAC 192k；其余组合（含用户手选 `.mkv`）仍流复制，不改变既有行为。
- **失败原因可见**：作业失败消息带上从 ffmpeg 输出里提炼出的真实原因，ffmpeg 输出末尾写入错误日志；合成页错误详情按换行显示。
- 不做：硬烧模式的显式容器选择器、奇数分辨率自动补偶数（见 design.md 的后续项）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `compose-engine`: 新增三项要求——输出容器可写性（默认不产出 WebM/Ogg、入口拒绝）、WebM/Ogg 源硬烧保留原声的音频规则、作业失败原因可见。
- `pipeline-compose-stage`: 「成品命名与容器」增加例外——源为 WebM/Ogg 时成品容器为 mp4（软封/双轨仍为 mkv）。

## Impact

- 主进程：`types/composeContainer.ts`（新增，主/渲染共用的纯函数）、`main/helpers/compose/{composeCommandBuilder,composeRunner,composeQueue,ffmpegFailure}.ts`、`main/helpers/subtitleMerger.ts`、`main/helpers/pipeline/deriveComposeConfig.ts`、`main/helpers/dubbing/dubbingProcessor.ts`。
- 渲染层：合成工作台默认输出扩展名（`useSubtitleMerge.ts`）、错误详情样式（`VideoPreview.tsx`）。
- 对外行为：CLI/MCP `compose.run` 未传 `outputPath` 时的回退路径同样改为 `.mp4`；显式传入 `.webm` 输出现在被拒绝（此前必然在 ffmpeg 里失败）。
- 无新依赖、无数据迁移；已有 `.mp4/.mkv/.mov/.avi` 等源的默认命名与参数逐项不变。
