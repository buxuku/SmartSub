## Why

上一轮（`add-qwen-asr-engine`）把 Qwen3-ASR 接入时复用了 P1 的 `sherpa-onnx-node` 原生运行时（worker_thread：silero VAD 分段 → 逐段 decode → 段级时间戳 → SRT），并验证了「新增一个识别器分支即可低成本接入一种本地引擎」的范式。FireRedASR-AED-L 正好跑在同一条 `sherpa-onnx-vad-with-offline-asr` 管线上，且 sherpa 上游（PR #1867）早已支持——vendored 封装 `extraResources/sherpa/vendor/types.js` 已声明 `OfflineFireRedAsrModelConfig`，`OfflineRecognizer` 为纯 pass-through，故**「版本闸门」天然已过**（无需 re-vendor / 无需 bump `SHERPA_VERSION` / 无需引擎仓重打原生库）。

FireRedASR 在**中英混说**与**中文方言（普通话/四川/河南/天津等）**场景的精度强于 SenseVoice/Qwen，作为本地高精度补充很有价值；复用刚建好的 sherpa 运行时即可接入，无 Python/torch、CPU 可跑，工作量为「低–中」。

## What Changes

- 新增**第 6 个转写引擎 `fireRedAsr`**（FireRedASR-AED-L，本地、开源），与 builtin / fasterWhisper / funasr / qwen / localCli 平级。
- **运行时复用**：不引入任何新原生运行时，复用 P1 的 `sherpa-onnx-node`（`main/helpers/sherpaOnnx/*` + `extraResources/sherpa/worker/sherpa-worker.js` + vendored JS 封装 + 已下载到 `userData/sherpa-onnx/current` 的原生库）。
- **新增 `fire_red_asr` 识别器分支**：`sherpaConfig.ts` 与 `sherpa-worker.js` 的识别器构造增加 `buildFireRedRecognizerConfig`，映射 sherpa 的 `modelConfig.fireRedAsr = { encoder, decoder }` + **顶层 `tokens`（tokens.txt，与 sense_voice/paraformer 同位）**。silero VAD 分段、段级时间戳、进度、取消逻辑**原样复用**。
- **模型管理**：新增 FireRedASR 模型清单与下载（`sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16`，解包后约 1.74GB：encoder.int8 ≈1.3GB + decoder.int8 ≈425MB + tokens.txt ≈70KB），落 `userData/models/firered/`。CN 首选 **ModelScope 官方镜像逐文件**（`csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16`），回退 **ghproxy → github** 整包 tar.bz2；复用现有镜像回退/断点续传/独立进程解包/共享 silero VAD。
- **引擎适配器**：新增 `fireRedEngine.ts`（仿 `qwenEngine.ts`），复用 sherpa 运行时；`isAvailable` = sherpa 原生库已装 + FireRedASR 模型（encoder/decoder/tokens）+ 共享 silero VAD 三就绪；无 `pyEngineId`（非 Python 引擎）。
- **VAD 段长安全闸（FireRedASR 特有）**：FireRedASR-AED 官方限制为 ≤60s（>60s 易幻觉、>200s 触发位置编码错误），官方长音频最佳实践为「VAD 切到每段 <60s」。故 fireRedAsr **不沿用 SmartSub「0=不限制」约定**，默认 `vad_max_speech_duration_s = 30`，并硬钳到 ≤60s。
- **范围边界（本期 Non-Goals）**：默认且仅交付 **AED-L + int8 + 仅 CPU + 段级时间戳**；fp16/GPU、FireRedASR-LLM 档位、词级时间戳一律留作未来项。
- 任务侧：`TranscriptionEngine` 类型加 `'fireRedAsr'`；混合队列并发钳制把 `fireRedAsr` 与 faster-whisper / funasr / qwen 同等视为「需钳为 1」（共享单 worker + AED 自回归解码重）。

## Capabilities

### New Capabilities

- `firered-asr-engine`: 基于复用的 `sherpa-onnx-node` 原生运行时的本地 FireRedASR-AED-L 转写引擎。覆盖：以 silero VAD 分段 + 逐段 AED 解码产出段级时间戳 SRT；FireRedASR int8 ONNX 模型（encoder / decoder + tokens.txt）的清单、下载（ModelScope 优先、整包回退）与就绪判断；引擎可用性（原生库 + 模型 + 共享 VAD 三就绪）与逐任务可选；CPU-only 设备；AED 段长安全闸（默认 30s、硬上限 60s）；运行时缺失或失败时回退到 whisper.cpp 的保底语义。

### Modified Capabilities

<!-- openspec/specs/ 下暂无已归档的 live spec（unify-engine-model-management / add-qwen-asr-engine 均未归档），故无可正式修改的既有能力；与「逐任务引擎选择 / 并发钳制」的衔接点在 design.md 与 tasks.md 中处理。 -->

## Impact

- **主进程（复用为主，少量改/新增）**：
  - 改：`main/helpers/sherpaOnnx/sherpaConfig.ts`（加 `buildFireRedRecognizerConfig`：`fireRedAsr={encoder,decoder}` + 顶层 tokens；`buildVadConfig` 已结构化可共享）、`extraResources/sherpa/worker/sherpa-worker.js`（与 `sherpaConfig.ts` 等价内联，加 `fire_red_asr` 分支 + `buildKey`/`ensureLoaded` 分流）、`main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts`（`SherpaModelRequest.modelType` 加 `'fire_red_asr'`、新增 `fireRed?:{encoder,decoder}` 字段，复用既有可选 `tokens`/共享 VAD/缓存）。
  - 新增：`main/helpers/fireRedModelCatalog.ts` + `main/helpers/fireRedModelDownloader.ts`（仿 qwen 同名文件）、`main/helpers/engines/fireRedEngine.ts`（适配器）、`main/helpers/engines/fireRedParams.ts`（provider / num_threads + VAD，含 60s 段长安全闸；无解码超参、无 language）。
  - 改：`main/helpers/engines/registry.ts`（注册 `fireRedEngineAdapter`）、`types/engine.ts`（`TranscriptionEngine` 加 `'fireRedAsr'`）、`main/helpers/taskProcessor.ts`（`isRestrictiveEngine` 加 `fireRedAsr`）、`systemInfoManager.ts`（fireRed 模型下载/状态/删除 IPC、就绪字段）、`ipcEngineHandlers.ts`（`set-firered-settings`：provider/numThreads）、`main/helpers/store/types.ts`（fireRed 设置项）。
- **sherpa 原生库版本闸门**：**已满足**——vendored `types.js` 已声明 `fireRedAsr`，`non-streaming-asr.js` 为 pass-through，1.13.2 原生库含 FireRedASR（PR #1867 自 v1.10.x 起）。无需 re-vendor / bump / 引擎仓重打。
- **模型分发**：~1.74GB（int8）走现有镜像下载器到 `userData/models/firered/`；下载前体积二次确认（明显大于 Qwen 0.95GB，UI 需提示磁盘/带宽门槛）。
- **渲染层**：资源中心「引擎与模型」视图新增 fireRedAsr 引擎条目 + 模型区（复用 `QwenModelSection` / `QwenPanel` 范式 → `FireRedModelSection` / `FireRedPanel`）；任务页「引擎 ▸ 模型」分组选择器自动多出 fireRedAsr 分组；`renderer/lib/engineModels.ts` 跨引擎就绪/分组接入 fireRed。
- **i18n**：`resources.json` / `common.json` 增 fireRedAsr 引擎与参数文案（中英双语，过 `check-i18n` 门禁）。
- **不变**：faster-whisper 的 Python 三层、FunASR / Qwen 的 sherpa 运行时核心、whisper.cpp 内置引擎、翻译/加速/下载底层基建全部零回归。
