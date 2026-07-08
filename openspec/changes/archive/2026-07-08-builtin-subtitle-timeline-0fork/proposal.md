## Why

内置 whisper.cpp 引擎对中文（CJK）经常把**整段音频只切出一条字幕**；而开启 VAD 时，addon 回报的 token 时间戳是「填满」的（段间静音被并进静音后首个 token 的时长里），导致即使切多条，时间轴也是**首尾相接、无停顿**的。此前的解法是 fork 上游 `addon.cpp`，带来「量化模型偶发崩成一条」与「每次同步上游都要重做补丁」的维护负担。

PR #341（已合入 `main`）已经提供了纯 TS 的音频能量分析与「全引擎尾部静音裁剪」的基础。本变更在该基础之上，用 **0-fork（不改 whisper.cpp，仅保留 AbortSignal 补丁）** 的方式，让内置引擎既能把 CJK 切成多条，又能得到 faster-whisper 式「带真实停顿空隙」的时间轴。

关键事实更新：**sherpa-onnx 原生库与 Silero VAD 模型（`silero_vad.onnx`）现已随安装包默认内置**（`electron-builder.yml` 打包整个 `extraResources/sherpa/`；VAD 模型已 git 提交，funasr/qwen/fireRed 共用）。因此神经 VAD 不再是「少数用户才有的可选件」，可作为**默认**的语音边界来源，能量法退居兜底。

## What Changes

- **内置引擎改用 `max_len=1`**：stock addon 在 `max_len>0` 时自动开启 token 级时间戳并「每 token 一段」输出（无需改 C++）。
- **新增「语音边界源」可插拔抽象**（混合策略）：
  - 主：**Silero VAD（经 sherpa-onnx）**——已随包内置；
  - 兜底：**能量法（RMS dB 阈值）**——复用 PR #341 的 `analyzePcm16WavEnergy`；
  - 都不可用时**优雅降级**：跳过贴齐/裁尾，退回（连续时间轴的）多段字幕，不报错。
- **新增 sherpa「只跑 VAD」入口**：`sherpa-worker.js` 现为 VAD+ASR 耦合（需 ASR 模型）。新增仅加载 `silero_vad.onnx`、对 WAV 返回语音段 `[{start,end}]` 的路径，**零 ASR 模型、零额外下载**。
- **新增 `retimeTokensToSpeech`**：用边界源把每个 token 的 `[start,end]` 收敛到其内部「真实有声」子窗口，使被「填满」的 token 时间戳重新表现出段间停顿。
- **新增 `groupTokenCues`**：按「真实停顿 / 句末标点 / 长度上限」把 token 聚合成多条字幕；纯标点 token 不被长度上限单独切出。
- **复用 PR #341 `trimSubtitleTrailingSilence`** 作为最终兜底裁尾（已在 `main`，行为不变）。

## Capabilities

### New Capabilities

- `speech-boundary-detection`: 面向 PCM16 WAV 的可插拔「语音边界源」，返回语音段 `[{start,end}]`。主用 Silero VAD（sherpa「只跑 VAD」入口，随包内置，零下载），不可用时回退能量法（PR #341），均不可用时返回空并由调用方优雅降级。
- `builtin-subtitle-timeline`: 内置 whisper.cpp 的 0-fork 细粒度分段 + VAD 对齐时间轴。`max_len=1` 取 per-token 输出 → 用 `speech-boundary-detection` 贴齐还原停顿 → 按停顿/标点/长度聚合成多条 → PR #341 裁尾兜底。

### Modified Capabilities

<!-- openspec/specs/ 下当前无既有 spec；PR #341 的全引擎裁尾已合入 main，本变更仅复用、不更改其 spec 级要求，故此处为空。 -->

## Impact

- **新增代码**：
  - `main/helpers/speechBoundary.ts`（语音边界源：Silero 主 + 能量兜底 + 降级）。
  - sherpa「只跑 VAD」入口：`extraResources/sherpa/worker/sherpa-worker.js` + `main/helpers/sherpaOnnx/`（新增 VAD-only 请求类型与运行时封装）。
  - `main/helpers/subtitleSegmentation.ts`（`retimeTokensToSpeech` + `groupTokenCues`）。
- **修改代码**：
  - `main/helpers/engines/builtinEngine.ts`（`max_len:0→1`；retime → group → trim 管道）。
  - 复用 PR #341 的 `main/helpers/subtitleTiming.ts`（按需导出 `analyzePcm16WavEnergy` / `AudioEnergy` 供能量兜底分支使用）。
- **依赖**：无新增三方依赖。sherpa-onnx 原生库与 `silero_vad.onnx` 已随安装包内置；**开发机需先 `yarn sherpa:fetch`** 落地原生 `.node`，缺失时自动回退能量法。
- **行为/兼容**：非破坏性。其它引擎（faster-whisper / funasr / qwen / fireRed）不变（裁尾已在 `main`）。内置引擎分段更细、时间轴带真实停顿。
- **性能**：`max_len=1` 强制开启 token 时间戳（DTW），超长音频略慢；Silero VAD 在 worker 线程多一次轻量前向；能量兜底成本低。均可接受。
