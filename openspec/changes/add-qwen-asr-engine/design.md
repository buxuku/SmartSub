## Context

仓库已有两套**已验证**的转写运行时：

- **Python 三层（P0）**：`PythonRuntimeManager` + PBS 基座 + 下载式 `faster-whisper` site-packages，`fasterWhisperEngine.ts` 在用。
- **sherpa-onnx-node 原生 addon（P1）**：`main/helpers/sherpaOnnx/*`（`sherpaLibPaths` / `sherpaLibManager` / `sherpaLibDownloader` / `sherpaFunasrRuntime` / `sherpaConfig`）+ `extraResources/sherpa/worker/sherpa-worker.js` + `extraResources/sherpa/vendor/*` vendored JS 封装。原生库按需下载到 `userData/sherpa-onnx/current`（绕开 asar），mac 走 `@loader_path` 改写 + ad-hoc 重签，worker 内 `readWave → silero VAD 分段 → 逐段 decodeAsync → 段级时间戳 → SRT`。FunASR 正是用它，并以此根治了 Windows「首个转写卡 0%」。

`sherpa-onnx` 上游（PR #3399，2026-03）新增了**离线 Qwen3-ASR**：模型为四件套 ONNX（`conv_frontend.onnx` / `encoder.int8.onnx` / `decoder.int8.onnx` / `tokenizer/`），通过 `OfflineRecognizer` 的 `qwen3Asr` 配置使用，且官方示例就是 `sherpa-onnx-vad-with-offline-asr`——与现有 worker 管线同构。0.6B int8 实测 ~0.95GB。

约束：Windows > macOS > Linux；主包 ≤200MB（模型/库一律下载）；无开发者证书（原生库 ad-hoc 即可）；whisper.cpp 永远是保底；无老用户、可零迁移。

## Goals / Non-Goals

**Goals:**

- 新增本地 `qwen` 引擎，**复用 P1 的 sherpa 运行时**，不引入任何新原生运行时或 Python/torch 依赖。
- 默认 **Qwen3-ASR-0.6B int8 + 仅 CPU + 段级时间戳**，端到端出 SRT，进度/取消/预热与 FunASR 一致。
- 模型与原生库全部按需下载，复用现有镜像回退/断点续传/SHA256/原子替换/回滚/ad-hoc 重签。
- 任务侧把 `qwen` 接入逐任务引擎选择与混合队列并发钳制。

**Non-Goals:**

- 不做 1.7B 档位（仅 CPU 自回归过慢；留作 GPU 路线后续项）。
- 不做 GPU 加速（sherpa 预编译仅 CPU；CUDA 需自定义构建 + CUDA toolkit，与 FunASR 同决策，留未来）。
- 不做词级时间戳 / Qwen3-ForcedAligner（sherpa 未集成；段级满足字幕）。
- 不引入 Python sidecar 的 Qwen torch 路线（原设计 §P2，已被本设计取代）。
- 不改 faster-whisper / whisper.cpp / FunASR 的既有行为。

## Decisions

### D1：运行时走 sherpa-onnx-node，而非原设计的 Python+torch

复用 P1 刚建好的 sherpa 运行时模板，新增一个 `qwen3_asr` 识别器分支即可。

- **为何**：(1) sherpa 上游已原生支持 Qwen3-ASR 且与现有 worker 管线同构；(2) 0.6B int8 ~0.95GB，远轻于 torch（~2–3GB），且 CPU 可跑、无 Python；(3) 避开 P1 主动逃离的 Python 冷启动/杀软扫描/stdio 握手；(4) 复用面极大（库管理/下载/mac 重签/VAD/SRT 全现成）。
- **备选**：① Python+torch sidecar（原设计）——重、慢、Windows 冷启动坑，仅在需 GPU 1.7B / 词级时间戳时才有相对优势，降级为未来项；② llama.cpp GGUF——实验性（>2min 音频幻觉/空输出）、无原生时间戳、且要新建原生运行时，否决。

### D2：`qwen3_asr` 作为 `OfflineRecognizer` 的第三种 modelType

`sherpaConfig.ts` 与 `sherpa-worker.js`（两者必须等价，已有约定）的 `buildRecognizerConfig` 增加 `'qwen3_asr'` 分支，映射 sherpa 的 `qwen3Asr` 配置：

```
modelConfig.qwen3Asr = {
  convFrontend, encoder, decoder, tokenizer,   // 四件套路径（tokenizer 是目录）
  maxNewTokens, temperature, topP, seed,       // 自回归解码参数
}
```

VAD 分段、`createStream/acceptWaveform/decodeAsync/getResult`、段级时间戳、进度回报**原样复用**（Qwen3-ASR 经 sherpa 暴露同一 `OfflineRecognizer` API）。

- **为何**：把差异收敛到「配置映射」一处，管线零改；与 sense_voice/paraformer 同构，便于单测（`sherpaConfig.ts` 已被 `test:engines` 覆盖）。

### D3：`SherpaModelRequest` 从「单模型+tokens」泛化为「按 modelType 取文件」

现 `SherpaModelRequest` 假设 `asrModel`（单 onnx）+ `tokens`（tokens.txt）。Qwen 是四件套（无 tokens.txt，改为 tokenizer 目录）。泛化请求结构：保留 funasr 字段，新增 qwen 四件套字段，`buildKey` 缓存 key 纳入 modelType + 四件套路径。

- **为何**：worker 单 recognizer 缓存按 key 重建，FunASR↔Qwen 切换自动 rebuild，无需双 worker。
- **备选**：为 qwen 起独立 worker/runtime——多一份常驻 worker 与代码，收益不明，否决（统一一个运行时，按 modelType 分流）。

### D4：运行时入口泛化（`sherpaFunasrRuntime` → 通用 ASR 运行时）

现单例 `getSherpaFunasrRuntime()` 与 FunASR 名称耦合，但其实现已与具体引擎无关（只是 load/transcribe/cancel/缓存）。改名/复用为通用 `getSherpaAsrRuntime()`，FunASR 与 Qwen 共用同一常驻 worker。

- **为何**：避免两份重复运行时；缓存 key 已含 modelType，天然隔离。
- **备选**：保留 funasr 命名 + 新增并列 qwen 运行时——重复代码、两个 worker 抢 CPU，否决。

### D5：Qwen 独立模型目录与清单，仿 FunASR

新增 `qwenModelCatalog.ts`（`QWEN_MODELS` 清单：默认 `qwen3-asr-0.6b-int8`，记录四件套下载项 + 校验）与 `qwenModelDownloader.ts`，模型落 `userData/models/qwen/<id>/`。silero VAD **复用 FunASR 已下载的 `models/funasr/silero-vad/silero_vad.onnx`**（同一文件），就绪判断需 VAD + qwen 四件套齐全。

- **为何**：模型按引擎分目录（沿用三层布局）；VAD 文件字节相同，复用免重复下载。
- **备选**：把 VAD 也放 qwen 目录——重复 ~2MB，且与 funasr 不一致，否决（统一指向 funasr 的 VAD 路径，或抽到共享 `models/_shared/`，本期取前者最小改动）。

### D6：适配器 `qwenEngine.ts` 仿 `funasrEngine.ts`

`isAvailable` = `isSherpaLibInstalled()` && qwen 模型就绪（VAD + 四件套）。`transcribe`/`cancelActive`/`prewarm` 复用 sherpa 运行时，`requiresRuntime: true`、**无 `pyEngineId`**（非 Python 引擎）。参数走新增 `qwenParams.ts`（`max_new_tokens` / `temperature` / `top_p` / `seed` / `language` + VAD 调参复用）。

### D7：任务并发钳制把 qwen 视为「受限引擎」

`taskProcessor` 现有「含 faster-whisper / funasr 即钳为 1」逻辑扩展为也含 `qwen`。

- **为何**：Qwen 自回归 + 单 worker，且 CPU 占用高，并发会拖垮；钳为 1 与 FunASR 一致。

### D8：sherpa 原生库版本闸门

确认现 pin 的 `SHERPA_VERSION = '1.13.2'` 原生库是否含 Qwen3-ASR 识别器，且 vendored JS 封装是否暴露 `qwen3Asr` 配置（现 `non-streaming-asr.js` 未见 qwen3 字段）。

- 若已含：仅在 `buildRecognizerConfig` 加分支即可。
- 若未含：(1) 引擎仓 `buxuku/smartsub-py-engine` 的 sherpa 重打包流水线升级到含 Qwen3-ASR 的 sherpa 版本并重发 6 平台资产；(2) re-vendor 对应版本的 JS 封装（`extraResources/sherpa/vendor/non-streaming-asr.js` 等）使其映射 `qwen3Asr`；(3) bump `SHERPA_VERSION`。

## Risks / Trade-offs

- **自回归 CPU 速度**（最大风险）→ 默认仅 0.6B 并设合理 `max_new_tokens`；UI 标注「比 SenseVoice 慢、CPU 友好但非实时」；1.7B/GPU 留未来。先用 `decodeAsync` 在 worker 线程跑，保证不阻塞 UI、首段即有进度。
- **sherpa 1.13.2 不含 Qwen3-ASR / JS 封装缺 `qwen3Asr`** → D8 的版本闸门：先做最小验证（构造一个 qwen recognizer 对一段 wav decode 出文本）；不满足则引擎仓重打 + re-vendor + bump 版本。
- **段级时间戳粒度** → 与 FunASR 现状一致，字幕够用；词级需 ForcedAligner（sherpa 未集成），明确为非目标。
- **模型体积 ~0.95GB** → 下载前二次确认 + 体积/硬件提示；走镜像回退与断点续传，弱网可恢复。
- **VAD 文件复用耦合 funasr 目录** → 若用户只装 qwen 未装 funasr，需保证 VAD 文件存在：qwen 模型清单把 silero VAD 列为其依赖项（指向同一下载，落 funasr 目录或共享目录），就绪判断显式校验 VAD 存在。
- **worker 单 recognizer 缓存在 FunASR↔Qwen 间频繁 rebuild** → 切换引擎本就少见；缓存 key 命中同引擎不重建，可接受。
- **macOS arm64 下载库签名失效** → 复用 `sherpaLibDownloader` 的 `@loader_path` 改写 + ad-hoc 重签（qwen 不引入新原生库，沿用同一 sherpa 库，无额外签名面）。

## Migration Plan

- 无数据迁移（新增引擎，纯增量；无老用户）。
- 实施顺序：先做 **D8 版本闸门的最小验证**（确认/产出含 Qwen3-ASR 的 sherpa 库 + JS 封装）→ `sherpaConfig`/worker 加 `qwen3_asr` 分支 + 泛化 `SherpaModelRequest`/运行时 → qwen 模型清单/下载器 + 就绪判断 → `qwenEngine` 适配器 + registry + 类型 + 并发钳制 → 资源中心 qwen 引擎/模型 UI + i18n → typecheck + `test:engines` + `check-i18n` + Win/mac 端到端冒烟。
- 回滚：分支级回退（改动集中在 `feat/*` 分支）；qwen 不可用时 `isAvailable` 报 not_installed，任务可改选 whisper.cpp 保底。

## Open Questions

- **D8 结论**：1.13.2 是否已含 Qwen3-ASR + JS 封装 `qwen3Asr`？（落地前第一步验证；决定是否需要引擎仓重打 + re-vendor。）
- **VAD 文件归属**：复用 funasr 目录的 `silero_vad.onnx`，还是抽到共享目录？（本期倾向复用 funasr 路径，最小改动。）
- **Qwen3-ASR 语言参数**：sherpa 的 qwen3Asr 是否暴露语言/方言提示位，还是纯 prompt 决定？（影响 `qwenParams.language` 的映射，落地时按 sherpa API 核实。）
