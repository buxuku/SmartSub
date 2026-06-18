## Why

三层多引擎设计（`docs/superpowers/specs/2026-06-16-three-layer-multi-engine-design.md` §P2）原计划把 Qwen-ASR 作为「Python sidecar + torch（~2–3GB、需 N 卡）」的重型可选引擎。但该设计成文后发生了两件改变地形的事：(1) P1 的 FunASR **主动从 Python 迁到 `sherpa-onnx-node` 原生 addon**（worker_thread），以根治 Windows「首个转写卡 0%」；(2) `sherpa-onnx` 上游（PR #3399，2026-03）**原生支持了 Qwen3-ASR（0.6B/1.7B int8 ONNX）**，且跑在 `sherpa-onnx-vad-with-offline-asr` 这条管线上——正是 `extraResources/sherpa/worker/sherpa-worker.js` 现已实现的 VAD→逐段 decode→段级时间戳→SRT 管线。

因此原「torch 路线」已过时：Qwen 可改为**复用 P1 刚建好的 sherpa 运行时**，做成一个 ~0.95GB（0.6B int8）、CPU 可跑、无 Python、无 torch 的中文高精度引擎，工作量从「中–高」降到「低–中」，并避开刚逃离的 Python 冷启动坑。

## What Changes

- 新增**第 5 个转写引擎 `qwen`**（Qwen3-ASR，本地、开源 Apache-2.0），与 builtin / fasterWhisper / funasr / localCli 平级。
- **运行时复用**：不引入任何新原生运行时，复用 P1 的 `sherpa-onnx-node`（`main/helpers/sherpaOnnx/*` + `extraResources/sherpa/worker/sherpa-worker.js` + vendored JS 封装 + 已下载到 `userData/sherpa-onnx/current` 的原生库）。
- **新增 `qwen3_asr` 识别器分支**：`sherpaConfig.ts` 与 `sherpa-worker.js` 的 `buildRecognizerConfig` 增加 `modelType: 'qwen3_asr'`，映射 sherpa 的 `qwen3Asr` 配置（`convFrontend / encoder / decoder / tokenizer` 四件套 + `maxNewTokens / temperature / topP / seed`）。silero VAD 分段与段级时间戳逻辑**原样复用**。
- **模型管理**：新增 Qwen3-ASR 模型清单与下载（默认 `Qwen3-ASR-0.6B-int8`，从 k2-fsa release / ModelScope 镜像下载到 `userData/models/qwen/`），仿 `funasrModelCatalog.ts` + `funasrModelDownloader.ts`，复用现有镜像回退/断点续传/SHA256。
- **引擎适配器**：新增 `qwenEngine.ts`（仿 `funasrEngine.ts`），复用 sherpa 运行时；`isAvailable` = sherpa 原生库已装 + qwen 模型已落盘。
- **范围边界（本期 Non-Goals）**：默认且仅交付 **0.6B + 仅 CPU + 段级时间戳**；1.7B 档位、GPU（需自定义 CUDA sherpa 库）、词级 ForcedAligner 一律留作未来项。
- 任务侧：`TranscriptionEngine` 类型加 `'qwen'`；混合队列并发钳制把 `qwen` 与 faster-whisper / funasr 同等视为「需钳为 1」（自回归更重）。

## Capabilities

### New Capabilities

- `qwen-asr-engine`: 基于复用的 sherpa-onnx-node 原生运行时的本地 Qwen3-ASR 转写引擎。覆盖：以 silero VAD 分段 + 逐段自回归 decode 产出段级时间戳 SRT；Qwen3-ASR-0.6B int8 ONNX 模型（conv_frontend / encoder / decoder / tokenizer 四件套）的清单、下载与就绪判断；引擎可用性（原生库 + 模型双就绪）与逐任务可选；CPU-only 设备与自回归解码参数（max_new_tokens / temperature / top_p / seed / language）；运行时缺失或失败时回退到 whisper.cpp 的保底语义。

### Modified Capabilities

<!-- openspec/specs/ 下暂无已归档的 live spec（unify-engine-model-management 完成但未归档），故无可正式修改的既有能力；与"逐任务引擎选择/并发钳制"的衔接点在 design.md 与 tasks.md 中处理。 -->

## Impact

- **主进程（复用为主，少量改/新增）**：
  - 改：`main/helpers/sherpaOnnx/sherpaConfig.ts`（加 `qwen3_asr` 配置映射 + 四件套路径 + 解码参数）、`extraResources/sherpa/worker/sherpa-worker.js`（与 `sherpaConfig.ts` 等价内联，加 `qwen3_asr` 分支）、`main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts`（泛化 `SherpaModelRequest` 支持四件套；运行时可改名为通用 `sherpaAsrRuntime` 或新增 qwen 入口，缓存 key 已含 modelType）。
  - 新增：`main/helpers/qwenModelCatalog.ts` + `main/helpers/qwenModelDownloader.ts`（仿 funasr 同名文件）、`main/helpers/engines/qwenEngine.ts`（适配器）、`main/helpers/engines/qwenParams.ts`（自回归解码 + 语言参数）。
  - 改：`main/helpers/engines/registry.ts`（注册 `qwenEngineAdapter`）、`types/engine.ts`（`TranscriptionEngine` 加 `'qwen'`）、`main/helpers/taskProcessor.ts`（`qwen` 并发钳制=1）、`ipcEngineHandlers.ts` / `systemInfoManager.ts`（qwen 模型下载 IPC、就绪字段）。
- **sherpa 原生库版本闸门**：现仓库 pin `SHERPA_VERSION = '1.13.2'`，但 vendored `extraResources/sherpa/vendor/non-streaming-asr.js` 尚未暴露 `qwen3Asr`。需确认 1.13.2 原生库 + JS 封装是否含 Qwen3-ASR；若否，re-vendor 新版 JS 封装 + 引擎仓 CI 重打含 qwen3 的 native lib（`buxuku/smartsub-py-engine` 的 sherpa 重打包流水线）。
- **模型分发**：~0.95GB（0.6B int8：conv 42M + encoder 174M + decoder 721M + tokenizer），走现有镜像下载器到 `userData/models/qwen/`；下载前体积二次确认。
- **渲染层**：资源中心「引擎与模型」视图新增 qwen 引擎条目 + 模型区（复用 `FunasrModelSection` / 引擎面板范式）；任务页「引擎 ▸ 模型」分组选择器自动多出 qwen 分组。
- **i18n**：`engines` / `models` 等 namespace 增 qwen 引擎与参数文案（中英双语，过 `check-i18n` 门禁）。
- **不变**：faster-whisper 的 Python 三层、FunASR 的 sherpa 运行时核心、whisper.cpp 内置引擎、翻译/加速/下载底层基建全部零回归。
