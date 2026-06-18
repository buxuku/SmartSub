## Context

仓库已有三套**已验证**的转写运行时，本变更复用其中第二套：

- **Python 三层（P0）**：`PythonRuntimeManager` + PBS 基座 + 下载式 `faster-whisper` site-packages，`fasterWhisperEngine.ts` 在用。
- **sherpa-onnx-node 原生 addon（P1）**：`main/helpers/sherpaOnnx/*` + `extraResources/sherpa/worker/sherpa-worker.js` + `extraResources/sherpa/vendor/*` vendored JS 封装。原生库按需下载到 `userData/sherpa-onnx/current`（绕开 asar），mac 走 `@loader_path` 改写 + ad-hoc 重签，worker 内 `readWave → silero VAD 分段 → 逐段 decodeAsync → 段级时间戳 → SRT`。FunASR（`sense_voice`/`paraformer`）与 Qwen（`qwen3_asr`）均用它。

`sherpa-onnx` 上游（PR #1867）新增了**离线 FireRedASR-AED**：模型为 `encoder` + `decoder`（两件 ONNX）+ `tokens.txt`，通过 `OfflineRecognizer` 的 `fireRedAsr` 配置 + 顶层 `tokens` 使用，官方示例即 `sherpa-onnx-vad-with-offline-asr`——与现有 worker 管线同构。int8 实测 encoder ≈1.3GB + decoder ≈425MB + tokens ≈70KB（解包后 ≈1.74GB，tar.bz2 ≈1.4GB）。

约束：Windows > macOS > Linux；主包 ≤200MB（模型/库一律下载）；无开发者证书（原生库 ad-hoc 即可）；whisper.cpp 永远是保底；无老用户、可零迁移。

## Goals / Non-Goals

**Goals:**

- 新增本地 `fireRedAsr` 引擎，**复用 P1 的 sherpa 运行时**，不引入任何新原生运行时或 Python/torch 依赖。
- 默认 **FireRedASR-AED-L int8 + 仅 CPU + 段级时间戳**，端到端出 SRT，进度/取消/预热与 FunASR/Qwen 一致。
- 模型与原生库全部按需下载，复用现有镜像回退/断点续传/独立进程解包/SHA 校验/共享 silero VAD。
- 落实 FireRedASR-AED 的 **≤60s 段长安全闸**（避免长段幻觉 / 位置编码错误）。
- 任务侧把 `fireRedAsr` 接入逐任务引擎选择与混合队列并发钳制。

**Non-Goals:**

- 不做 fp16 / GPU 加速（sherpa 预编译仅 CPU；CUDA 需自定义构建，与 FunASR/Qwen 同决策，留未来）。
- 不做 FireRedASR-LLM 档位（Encoder-Adapter-LLM，重、且 sherpa-onnx 暂未集成其离线识别器）。
- 不做词级时间戳（sherpa 未对 FireRedASR 暴露强制对齐；段级满足字幕）。
- 不暴露 language/ITN 旋钮（FireRedASR 内部处理中英，sherpa `fireRedAsr` 配置无 language 字段）。
- 不改 faster-whisper / whisper.cpp / FunASR / Qwen 的既有行为。

## Decisions

### D1：运行时走 sherpa-onnx-node（与 Qwen 同路线）

复用 P1 + Qwen 已跑通的 sherpa 运行时模板，新增一个 `fire_red_asr` 识别器分支即可。

- **为何**：(1) sherpa 上游已原生支持 FireRedASR-AED 且与现有 worker 管线同构；(2) int8 CPU 可跑、无 Python/torch；(3) 复用面极大（库管理/下载/mac 重签/VAD/SRT/缓存全现成）；(4) 与 Qwen 决策一致，维护心智统一。
- **备选**：① 接 FireRedASR 官方 Python 推理（重、需 torch、Windows 冷启动坑，否决）；② FireRedVAD + FireRedASR2S 全家桶（超出本期，且需新原生运行时，留未来）。

### D2：`fire_red_asr` 作为 `OfflineRecognizer` 的第 4 种 modelType

`sherpaConfig.ts` 与 `sherpa-worker.js`（两者必须等价，已有约定）新增独立函数 `buildFireRedRecognizerConfig`（不改 `buildRecognizerConfig` / `buildQwenRecognizerConfig` 签名，保 funasr/qwen 既有单测不破），映射：

```
modelConfig.fireRedAsr = { encoder, decoder }   // 两件 ONNX
modelConfig.tokens     = <tokens.txt 路径>       // 顶层 tokens（与 sense_voice/paraformer 同位，区别于 qwen 的 '')
modelConfig.numThreads / provider / debug
// featConfig: { sampleRate: 16000, featureDim: 80 } 不变
```

VAD 分段、`createStream/acceptWaveform/decodeAsync/getResult`、段级时间戳、进度回报**原样复用**。

- **与 qwen 的关键差异**：FireRedASR 用**顶层 tokens.txt**（非 tokenizer 目录），且**无 memset(0) 数值解码超参**（AED beam search，封装未暴露 `maxNewTokens` 等），故配置映射比 qwen 更简单、更接近 sense_voice。
- **为何**：把差异收敛到「配置映射」一处，管线零改；与既有分支同构、便于单测（`sherpaConfig.ts` 已被 `test:engines` 覆盖）。

### D3：`SherpaModelRequest` 增 `fire_red_asr` 分支与 `fireRed` 字段

`SherpaModelRequest.modelType` 联合加 `'fire_red_asr'`；新增 `fireRed?: { encoder: string; decoder: string }`；**复用既有可选 `tokens` 字段**承载 tokens.txt；`params` 联合 `FunasrAddonParams | QwenAddonParams | FireRedAddonParams`。worker 的 `buildKey` 纳入 `fire_red_asr` 分支（encoder|decoder|tokens|num_threads|provider|VAD 字段；无解码超参）。

- **为何**：worker 单 recognizer 按 key 重建，funasr↔qwen↔firered 切换自动 rebuild，无需多 worker。

### D4：运行时入口复用 `getSherpaAsrRuntime`（零改）

D4 的引擎无关入口 `getSherpaAsrRuntime`（= `getSherpaFunasrRuntime`）已在 Qwen 阶段就位，FireRedASR 直接复用，worker 依 `modelType` 选分支。常驻单 worker 在三引擎间共享。

### D5：FireRedASR 独立模型目录与清单，仿 Qwen；CN 首选 ModelScope 官方镜像

新增 `fireRedModelCatalog.ts`（`FIRERED_MODELS` 清单：默认 `fire-red-asr-large-zh-en`，记录 encoder/decoder/tokens 下载项 + `requiredFiles`）与 `fireRedModelDownloader.ts`，模型落 `userData/models/firered/<id>/`。

下载源（仿 qwen 的 `getQwenSourceOrder` 回退）：

1. `modelscope`（CN 首选，逐文件直下、免解包）：官方镜像 `csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16`（与 HF 同作者同内容；逐文件 remote 路径与各文件 size 落地时经 ModelScope 文件树 API 核实）。
2. `ghproxy`（GitHub release 整包经 gh-proxy 代理）。
3. `github`（GitHub release 整包直连）：`k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16.tar.bz2`。

整包解包复用 `download/extractArchive.ts`（独立进程 system tar，`strip:1` 去顶层目录、`excludeContains:'test_wavs'` 过滤示例音频），避免「下完卡住」。silero VAD **复用 FunASR 已下载的 `models/funasr/silero-vad/silero_vad.onnx`**（同一文件），就绪判断需 VAD + FireRedASR 三件齐全。

- **为何**：模型按引擎分目录（沿用三层布局）；ModelScope 有官方镜像故 CN 首选它（符合「官方有则优先」），无须另建 hf-mirror 逐文件路径；VAD 文件字节相同，复用免重复下载。

### D6：适配器 `fireRedEngine.ts` 仿 `qwenEngine.ts`

`isAvailable` = `isSherpaLibInstalled()` && FireRedASR 模型就绪（encoder/decoder/tokens + 共享 VAD）。`transcribe`/`cancelActive`/`prewarm` 复用 `getSherpaAsrRuntime`，`requiresRuntime: true`、**无 `pyEngineId`**。参数走新增 `fireRedParams.ts`（`provider` / `num_threads` + VAD 调参 + 段长安全闸；无解码超参、无 language）。

### D7：任务并发钳制把 fireRedAsr 视为「受限引擎」

`taskProcessor.isRestrictiveEngine` 现有 `fasterWhisper / funasr / qwen` 扩展为也含 `fireRedAsr`。

- **为何**：FireRedASR 与 funasr/qwen 共享同一常驻 sherpa worker，且 AED 自回归 + CPU 占用高，并发会拖垮；钳为 1 与既有受限引擎一致。

### D8：FireRedASR-AED 段长安全闸（本变更特有的关键决策）

FireRedASR-AED 官方明确：**支持 ≤60s 输入；>60s 易产生幻觉；>200s 触发位置编码错误**；官方长音频最佳实践为「先用 VAD 切成每段 <60s，再做 ASR」。

- **决策**：`fireRedParams` **不沿用 SmartSub「`vad_max_speech_duration_s=0` 表示不限制」**的约定；默认 `vad_max_speech_duration_s = 30`（在 60s 硬限下留足安全裕度，且对齐 Whisper 风格的成熟默认），并在映射时**硬钳到 ≤60s**（即便用户调高也不越过 60s）。
- **为何**：silero VAD 的 `maxSpeechDuration` 是软目标、实际段可能略超；30s 默认 + 60s 硬上限可同时兼顾「上下文足够长」与「远离幻觉/崩溃悬崖」。
- **备选**：默认 60s（上下文更长但贴近悬崖，否决为默认值）；不设上限（必然在长独白上幻觉/报错，否决）。

### D9：sherpa 原生库版本闸门——已天然通过

确认现 pin 的 `SHERPA_VERSION = '1.13.2'` 原生库含 FireRedASR 识别器，且 vendored JS 封装已暴露 `fireRedAsr` 配置：

- `extraResources/sherpa/vendor/types.js` 已声明 `OfflineFireRedAsrModelConfig { encoder, decoder }` 并将其纳入 `OfflineModelConfig.fireRedAsr`。
- `non-streaming-asr.js` 的 `OfflineRecognizer` 为纯 pass-through（`addon.createOfflineRecognizer(config)`，无模型类型白名单），传入 `modelConfig.fireRedAsr` 直达原生绑定。
- FireRedASR C/Python API 自 PR #1867 合入，1.13.2 ≥ 该版本，故原生库已含。

→ **仅需在 `buildFireRedRecognizerConfig` 加分支**，无需 re-vendor JS、无需 bump `SHERPA_VERSION`、无需引擎仓重打原生库。

## Risks / Trade-offs

- **模型体积 ~1.74GB（最大体验风险，明显大于 Qwen 0.95GB）** → 下载前体积二次确认 + 磁盘/带宽提示；走 ModelScope 逐文件（CN 快、免解包、续传友好）与整包回退；独立进程解包不卡 UI。
- **AED 解码 CPU 速度** → 默认 int8 + 合理 `num_threads`；UI 标注「CPU 友好但非实时、强于中英混说/方言」；先用 `decodeAsync` 在 worker 线程跑，首段即有进度。
- **长段幻觉 / 位置编码错误** → D8 的 60s 段长安全闸（默认 30s、硬钳 60s）是必需项，必须随引擎一起落地，否则长独白会幻觉甚至报错。
- **ModelScope 逐文件 remote 路径 / size 未最终核实** → 落地时先打 ModelScope 文件树 API（仿 `getQwenModelScopeTreeUrl`）确认 `encoder.int8.onnx`/`decoder.int8.onnx`/`tokens.txt` 的仓库内路径；树拉取失败仅令进度退化、不阻断逐文件下载；整包源（github/ghproxy）作为确定可用的回退。
- **worker 单 recognizer 在三引擎间频繁 rebuild** → 切换引擎本就少见；缓存 key 命中同引擎不重建，可接受。
- **macOS arm64 下载库签名** → 复用既有 `@loader_path` 改写 + ad-hoc 重签（FireRedASR 不引入新原生库，沿用同一 sherpa 库，无额外签名面）。

## Migration Plan

- 无数据迁移（新增引擎，纯增量；无老用户）。
- 实施顺序：`sherpaConfig`/worker 加 `fire_red_asr` 分支 + 泛化 `SherpaModelRequest` → FireRedASR 模型清单/下载器（含 ModelScope 文件树核实）+ 就绪判断 → `fireRedParams`（含段长安全闸）+ `fireRedEngine` 适配器 + registry + 类型 + 并发钳制 → 资源中心 fireRed 引擎/模型 UI + i18n → typecheck + `test:engines` + `check-i18n` + Win/mac 端到端冒烟（含 >60s 长音频不幻觉/不报错的验收）。
- 回滚：分支级回退（改动集中在 `feat/*` 分支）；fireRedAsr 不可用时 `isAvailable` 报 not_installed，任务可改选 whisper.cpp 保底。

## Open Questions

- **ModelScope 逐文件清单**：`csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16` 仓库内文件是否平铺在根（`encoder.int8.onnx` 等）？（落地前经文件树 API 核实 remote 路径与 size。）
- **段长默认值**：30s 是否为最优默认，还是按目标人群（长会议 vs 短视频）再调？（本期定 30s 默认 + 60s 硬上限，后续可按反馈微调。）
- **VAD 段长 UI 暴露**：是否在 FireRedASR 面板单独给「最大段长」滑杆并标注 60s 上限？（本期可先用默认值，UI 暴露留增强。）
