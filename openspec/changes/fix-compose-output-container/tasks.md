# Tasks: fix-compose-output-container

## 1. 容器可写性：共享纯函数与默认路径

- [x] 1.1 新增 `types/composeContainer.ts`（纯函数，不依赖 `node:path`，主进程与渲染层共用）：`isComposeContainerWritable`、`writableComposeExtension`、`assertComposeOutputWritable`、`sourceAudioNeedsAac`、常量 `FALLBACK_COMPOSE_EXTENSION`；黑名单只含 `.webm .ogv .ogg`
- [x] 1.2 4 处默认扩展名改用 `writableComposeExtension`：渲染层 `useSubtitleMerge.ts` 的 `extension()`、主进程 `subtitleMerger.ts` 的 `generateOutputPath()`（含 `startMerge` / CLI / MCP 的回退）、流水线 `deriveComposeConfig.ts`、配音导出 `dubbingProcessor.ts` 的 `resolveOutputPath`；软封字幕与双音轨仍为 `.mkv`
- [x] 1.3 `types/subtitleMerge.ts` 的 `ComposeConfig` 注释写明 WebM/Ogg 输出会被拒绝

## 2. 入口拒绝与音频规则

- [x] 2.1 `composeQueue.ts` 的 `enqueueCompose` 首行同步调用 `assertComposeOutputWritable`：入队与历史之前失败
- [x] 2.2 `composeRunner.ts` 的 `runComposeJob` 在创建暂存目录、启动 ffmpeg 之前拒绝；`composeCommandBuilder.ts` 的 `buildComposePlan` 兜底拒绝
- [x] 2.3 `composeCommandBuilder.ts` 的 hard+keep：仅当源为 WebM/Ogg 且输出为 `.mp4/.m4v/.mov` 时写 AAC 192k，其余保持 `-c:a copy`

## 3. 失败原因可见

- [x] 3.1 新增 `main/helpers/compose/ffmpegFailure.ts`：`summarizeFfmpegFailure`（失败簇提取）与 `withFfmpegFailureReason`（只改写 `ffmpeg exited with code N`，原错误挂 `cause`）
- [x] 3.2 `composeRunner.ts` 的 error 回调读取 `(err, stdout, stderr)`，改写消息并以 error 级别把 stderr 末尾约 40 行写入日志；取消分支不变
- [x] 3.3 `VideoPreview.tsx` 的错误详情加 `whitespace-pre-wrap`

## 4. 测试

- [x] 4.1 新增 `scripts/compose/test-compose-container.ts` 并串进 `test:compose-output`：容器表驱动、拒绝信息、AAC 规则，以及用 9 份真实 ffmpeg 6.0 失败输出（`scripts/compose/ffmpeg-failure-fixtures.ts`）校验失败原因提取；摘要规则逐条做过变异检查
- [x] 4.2 `test-compose-builder.ts`：hard/replace/mix 写 `.webm` 抛错、AAC 与 copy 矩阵；`test-compose-queue.cjs`：入队即失败；`test-pipeline-units.ts`：`clip.webm` 硬烧得 `-final.mp4`、软封仍为 `.mkv`、`.mp4` 不变
- [x] 4.3 `test-compose-runner.cjs`（真实 ffmpeg）：VP9+Opus 的 `.webm` 硬烧到 `.mp4` 得 H.264 + AAC；`.webm` 输出在 ffmpeg 启动前被拒绝且不留暂存目录；配音形态 `.webm` → `.mp4`；硬烧到 `.gif`（封装器拒绝 H.264）失败时消息、UI 事件与错误日志含真实原因（`Could not write header`，日志含 `GIF muxer supports only`；原先用 853x480 触发的失败在第 6 节修好后改用它）；硬件回退告警含 `Unknown encoder`
- [x] 4.4 `renderer/components/__tests__/SubtitleMergeState.test.tsx`：`/v/clip.webm` 默认得 `clip_subtitled.mp4`，软封切 mkv，切回 mp4
- [x] 4.5 把 `test:compose`（命令构建器）加入 `scripts/test-pro-baseline.mjs`

## 5. 验证

- [x] 5.1 `npm run typecheck` 通过
- [x] 5.2 相关测试通过：`test:pro-baseline`（42 条命令，含 `test:compose`、`test:compose-output`、`test:compose-queue`、`test:compose-presets`、`test:pipeline`）、`test:subtitle-output`、`test:automation:regressions`、`test:dubbing`、`test:engines`、`test:renderer`（64 个套件）、`test:parameter-persistence`
- [x] 5.3 端到端：真实 1280x720 VP9+Opus `.webm` 经 `runComposeJob` 默认命名为 `.mp4` 并硬烧，成品为 H.264 + AAC，抽帧可见字幕；显式 `.webm` 输出在 ffmpeg 启动前被拒绝；旧命令形状的真实报错能提炼出 `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio … supported for WebM`
- [x] 5.4 CI 的其余步骤：`check:i18n` 与 `build`（renderer + main + CLI/MCP 入口）通过

## 6. 后续：封面图与奇数宽/高

- [x] 6.1 `composeCommandBuilder.ts`：`keep`/`replace`/`addTrack` 三个重编码分支映射 `0:V`（常量 `REENCODED_VIDEO_MAP`）；软封装、无字幕与 hard+mix 不变
- [x] 6.2 `composeCommandBuilder.ts`：硬烧滤镜链为 `字幕滤镜 → crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0 → format=nv12（仅硬件）`（常量 `EVEN_DIMENSIONS_FILTER`）
- [x] 6.3 `test-compose-builder.ts`：5 处硬烧完整参数改为 `0:V`，外加「不映射 `0:v`」断言；滤镜链顺序矩阵（cpu/hw × keep/replace/addTrack/mix）与「流拷贝路径不插入裁剪」的防护断言；变异检查过（软封装分支误加裁剪、`format=nv12` 放到裁剪之前都会失败）
- [x] 6.4 `test-compose-runner.cjs`（真实 ffmpeg 6.0）：带 mjpeg 封面的 MP4 经 keep/replace/addTrack 硬烧只剩一路 H.264、无封面；853x480、640x361、853x481 的 yuv420p 源硬烧成功，成品为 852x480、640x360、852x480，640x360 的源保持不变
- [x] 6.5 验证：`npm run typecheck`、`test:compose`、`test:compose-output`、`test:compose-queue`、`test:compose-presets`、`test:compose-canvas`（含 `translatedAssFilter` overlay 图 + `format=nv12`）、`smoke:compose`、`test:pipeline` 通过，`test:pro-baseline` 的 42 条命令中除 `test:toolbox` 外都通过（它需要已安装的 Electron 二进制，验证环境没有，未改动的分支上同样失败）；与用户文件同构的样本（1920x1080 H.264 + AAC + 2×`mov_text` + 1280x720 mjpeg 封面）上，`-map 0:v` 复现 `Could not find tag for codec h264 in stream #1`，`-map 0:V` 成功；853x481 源去掉裁剪复现 `width not divisible by 2 (853x481)`，加上后输出 852x480（`h264_videotoolbox` 自己能处理奇数尺寸，NVENC/QSV/AMF 未验证）
