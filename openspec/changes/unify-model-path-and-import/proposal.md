## Why

统一的「引擎与模型」面已经在 spec 里承诺「在任意引擎的右栏直接下载 / 删除 / **导入**模型，并提供打开模型目录、**切换模型目录**」，但实现只对一部分引擎落地：**导入**仅 builtin（单文件 `.bin/.mlmodelc`）可用；**切换模型目录**仅 builtin / fasterWhisper 可用。三个基于 sherpa 的引擎（funasr / qwen / fireRedAsr）目前是**固定路径 + 仅下载**——模型只能落在 `userData/models/<engine>`，既不能挪到外置/大容量盘，也无法复用已下载或离线拷贝的模型文件。

这是规格与实现之间的欠债，也是体验不一致：fireRedAsr 单模型解包后约 1.74GB，用户却无法改盘或离线导入。本变更补齐承诺，把「自定义模型路径」与「本地导入」对齐到所有以应用托管模型为中心的引擎。

## What Changes

- **每引擎可自定义模型根目录**：为 funasr / qwen / fireRedAsr 新增设置项 `funasrModelsPath` / `qwenModelsPath` / `fireRedModelsPath`，沿用现有 `fasterWhisperModelsPath` 的模式——路径 getter 读「用户覆盖值」否则回退默认 `userData/models/<engine>`。在这三个引擎的模型面板放开已有的「更换路径」按钮。
- **从本地文件夹导入模型**：新增通用导入流程，**按指定模型槽**（引擎 + 模型 id）进行——用户选择一个源文件夹，系统按该模型在 catalog 中的 `requiredFiles` 校验布局（sherpa：encoder/decoder/tokens 等；fasterWhisper：CT2 快照 `model.bin` 等），通过后整目录拷入该引擎模型库的正确子目录（保留嵌套结构，如 qwen 的 `tokenizer/`），随后既有的「已安装」判定自动识别。
- **builtin 维持现状**：保留其单文件导入（`.bin/.mlmodelc` → `modelsPath`），不改动。
- **共享 VAD 改为随应用内置**：sherpa 三引擎（funasr / qwen / fireRedAsr）共用的 `silero_vad.onnx` 不再依赖运行时下载，改为随安装包发布到 `extraResources/sherpa/vad/`（与 builtin 引擎早已内置的 `ggml-silero-v6.2.0.bin` 一致）。三处 VAD 路径 getter 改读该内置只读路径，使 VAD 与「每引擎可自定义的模型根目录」**彻底解耦**——消除「改 funasr 路径静默拖垮 qwen/fireRed 就绪态」「自定义目录其实不含 VAD」「误删 funasr 目录连带删 VAD」三类隐性耦合。
- **导入按指定模型而非文件名自动判别**：因 funasr 两个 ASR 模型 `requiredFiles` 相同（均为 `model.int8.onnx` + `tokens.txt`），无法靠扫描自动区分，故导入必须携带目标模型 id 以消歧。
- **不在本次范围**：不支持导入压缩包（`.tar.bz2` / `.zip`）；不引入"全局统一模型根目录"（采用每引擎独立覆盖）。VAD 仍不纳入「导入」（因其改为随包内置，既不下载也不导入）。

## Capabilities

### New Capabilities

<!-- 无新增能力；本变更细化既有的 engine-model-management 能力。 -->

### Modified Capabilities

- `engine-model-management`: 细化「模型管理独立于引擎安装状态」的承诺，新增三条具体需求——(1) 每引擎可自定义模型存储路径（含 sherpa 三引擎），(2) 从本地文件夹按指定模型导入并按布局校验，(3) sherpa 系共享 VAD 随应用内置、与引擎模型根解耦。

## Impact

- **主进程**：
  - `funasrModelCatalog.ts` / `qwenModelCatalog.ts` / `fireRedModelCatalog.ts`：`get*ModelsRoot()` 改为读各自设置覆盖值，回退默认；`get*VadModelPath()` 改为返回内置只读路径 `getExtraResourcesPath()/sherpa/vad/silero_vad.onnx`，`is*VadInstalled()` 基于内置文件（恒真）；退役 `FUNASR_MODELS['silero-vad']` 可下载项、`getFunasrFileUrls('silero-vad')` 与 `downloadFunasrModel{model:'silero-vad'}` 链路。
  - `store/types.ts`：新增 `funasrModelsPath?` / `qwenModelsPath?` / `fireRedModelsPath?` 设置字段。
  - `systemInfoManager.ts`：`importModel` IPC 泛化（接受引擎 + 模型 id，按 catalog `requiredFiles` 校验并整目录拷贝）；新增/扩展系统信息中各引擎的模型路径字段。
- **渲染层**：`ModelLibrarySection.tsx`：放开 funasr/qwen/fireRedAsr 的「更换路径」按钮（`setSettings` 写对应新键）；为 sherpa + fasterWhisper 的模型行接入「从文件夹导入」动作（携带模型 id）。`FunasrModelSection` / `QwenModelSection` / `FireRedModelSection`：移除或改写「下载 VAD」行（标注「已内置」或不单独列出）。
- **i18n**：`resources` namespace 增补导入/路径相关文案（导入成功/失败/布局校验失败/选择文件夹等），zh/en 同步。
- **构建 / 资源**：新增 `extraResources/sherpa/vad/silero_vad.onnx`（~1.8MB，提交入库，与既有 `ggml-silero-v6.2.0.bin` 同属 extraResources 二进制惯例）；`electron-builder.yml` 已整目录拷贝 `extraResources/sherpa/`，无需改构建配置。
- **不变**：各引擎运行时下载器（ASR 模型）、下载源回退策略、并发钳制、builtin 单文件导入。
