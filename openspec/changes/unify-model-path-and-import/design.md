## Context

资源中心「引擎与模型」面已统一，但「模型存储路径」与「本地导入」两项能力在各引擎间不一致：

| 引擎          | 路径 getter                                                          | 可改路径 | 导入                       |
| ------------- | -------------------------------------------------------------------- | -------- | -------------------------- |
| builtin       | `getPath('modelsPath')` 读 `settings.modelsPath`                     | ✅       | ✅ 单文件 `.bin/.mlmodelc` |
| fasterWhisper | `getFasterWhisperModelsPath()` 读 `settings.fasterWhisperModelsPath` | ✅       | ❌                         |
| funasr        | `getFunasrModelsRoot()` = `userData/models/funasr`（写死）           | ❌       | ❌                         |
| qwen          | `getQwenModelsRoot()` = `userData/models/qwen`（写死）               | ❌       | ❌                         |
| fireRedAsr    | `getFireRedModelsRoot()` = `userData/models/firered`（写死）         | ❌       | ❌                         |

各引擎模型的「已安装」判定统一为：在 `<root>/<dirName>` 下 catalog 的 `requiredFiles` 全部存在。关键约束：

- **qwen 的 `requiredFiles` 含嵌套子目录**（`tokenizer/vocab.json`、`tokenizer/merges.txt`），导入必须保留目录结构。
- **funasr 两个 ASR 模型 `requiredFiles` 完全相同**（均 `model.int8.onnx` + `tokens.txt`），无法靠扫描文件名自动判别属于哪个模型。
- fasterWhisper 走 HF 缓存布局，`resolveCt2ModelSnapshotDir()` 会在 `<root>/<dirName>/snapshots/<rev>/model.bin` 与 `hub/...` 下解析快照。
- 现有 IPC：`selectDirectory`（返回 `{canceled, directoryPath}`）、`setSettings`、`importModel`（无参，仅 builtin）、`openModelsFolder({pathType})`。
- **共享 VAD 的隐性耦合**：funasr / qwen / fireRedAsr 共用一份 `silero_vad.onnx`，但 `getQwenVadModelPath()` / `getFireRedVadModelPath()` 均硬编码指向 `getFunasrModelDir('silero-vad')`（即 funasr 根）。三引擎根目录都写死时这无害；一旦决策 1 让 funasr 根可被自定义路径移动，VAD 位置只跟 funasr 走、与 qwen/fireRed 的自定义路径脱节，产生三类坑：① 改 funasr 路径 → qwen/fireRed 的 `is*VadInstalled()` 翻假、就绪态被拖垮；② 只用 fireRed 并设自定义路径时 VAD 仍落在 funasr 默认根，自定义目录不自包含；③「我不用 funasr」误删 funasr 目录连带删掉共享 VAD。
- builtin/whisper.cpp 引擎的 VAD（`extraResources/ggml-silero-v6.2.0.bin`）早已随包内置；唯独 sherpa 这套 VAD 仍走下载，体验不一致。

## Goals / Non-Goals

**Goals:**

- funasr / qwen / fireRedAsr 支持自定义模型根目录，与 builtin / fasterWhisper 体验一致。
- 提供「从本地文件夹导入模型」，覆盖 sherpa 三引擎与 fasterWhisper，按模型布局校验后落地，离线/复用场景可用。
- 零迁移、对既有用户零行为变化（新设置项缺省即沿用当前默认路径）。

**Non-Goals:**

- 不引入全局统一模型根目录（保持每引擎独立覆盖）。
- 不支持导入压缩包（`.tar.bz2` / `.zip`）。
- VAD 不纳入「导入」流程，且不再下载——改为随应用内置（见决策 6）。
- 不为导入的大文件拷贝提供进度条（本期用忙碌态占位）。
- 不自动迁移「改路径前」已存在于旧目录的模型（与现有 builtin/fasterWhisper 行为一致）。

## Decisions

### 决策 1：每引擎独立路径覆盖（方案 B），而非全局统一根目录（方案 A）

为 funasr / qwen / fireRedAsr 新增可选设置 `funasrModelsPath` / `qwenModelsPath` / `fireRedModelsPath`。三个 `get*ModelsRoot()` 改为：

```
读 settings.<engine>ModelsPath → 有值用之；否则回退 userData/models/<engine>
（与 getFasterWhisperModelsPath 完全同构：取值 → 回退默认 → ensureDir → 返回）
```

- **为何选 B**：是对现有架构的最小一致扩展（`fasterWhisperModelsPath` 已是此模式），零迁移、零破坏；getter 签名不变，仅内部取值来源变化。
- **放弃 A 的原因**：全局根目录需要迁移现有 `modelsPath` / `fasterWhisperModelsPath` 两个独立设置，引入破坏性变更与迁移成本，收益（少一个设置项）不抵成本。

### 决策 2：导入按「指定模型槽」（携带 engine + modelId），而非按文件名自动判别

导入动作必须携带目标 `(engine, modelId)`，目的地直接定位到 `<root>/<dirName>`，校验集取该模型的 `requiredFiles`。

- **为何**：funasr 两个 ASR 模型 `requiredFiles` 相同，自动判别无法区分；显式模型 id 唯一可靠地消歧，并确定落地子目录。
- **UI 呈现**：导入动作挂在每个模型行/卡片上（"从文件夹导入此模型"），而非面板级单按钮。builtin 维持其面板级单文件导入不变。
- **放弃自动判别**：扫描源目录匹配所有模型 `requiredFiles` 的方案在 funasr 上必然歧义，且对未知布局脆弱。

### 决策 3：导入 = 整目录拷贝 + 按相对路径校验 `requiredFiles`

流程（主进程，泛化后的 `importModel` handler）：

```
1. selectDirectory（properties: ['openDirectory']）→ 取源目录 srcDir
2. 预校验：该模型每个 requiredFiles[i] 在 srcDir 下存在（支持嵌套，如 tokenizer/vocab.json）
   └─ 不全 → 返回 { success:false, reason:'invalid-layout', missing:[...] }，不写盘
3. destDir = <engine root>/<dirName>（sherpa）；已存在则视为覆盖
4. fse.copy(srcDir → destDir)（保留嵌套结构）
5. 后校验：destDir 下 requiredFiles 全在 → { success:true } 否则回滚/报错
```

- **保留嵌套结构**：整目录拷贝天然满足 qwen 的 `tokenizer/` 需求。
- **fasterWhisper 落地差异**：CT2 模型目的地为合成快照目录 `<ct2 root>/<toCt2CacheDirName(modelId)>/snapshots/imported/`，使 `resolveCt2ModelSnapshotDir()` 能命中（其检查 `<root>/<dirName>/snapshots/<rev>/model.bin`）。校验集为 CT2 布局关键文件（`model.bin` + `config.json` 等）。
- **覆盖语义**：导入是显式用户动作，目的地已存在同名模型时直接覆盖（拷贝前可选二次确认；MVP 直接覆盖并提示）。

### 决策 4：IPC 形态 —— 泛化 `importModel`，保持 builtin 向后兼容

`importModel` 接受可选入参 `{ engine, modelId }`：

- 无参 / `engine==='builtin'` → 维持现有单文件 `.bin/.mlmodelc` 对话框逻辑。
- `engine ∈ {funasr,qwen,fireRedAsr,fasterWhisper}` → 走决策 3 的文件夹导入。

返回结构统一：`{ success, reason?, missing?, error? }`，渲染层据 `reason` 出对应文案（`invalid-layout` / `canceled` / 其它错误）。

### 决策 5：改路径只影响"读写位置"，不迁移旧模型

`setSettings` 写入新键后，getter 即从新目录读写。旧目录的模型不自动搬迁、不再被列出（与 builtin/fasterWhisper 现状一致）。文案需提示用户：改路径后如需沿用旧模型，可手动移动或重新下载/导入。

### 决策 6：共享 VAD 随应用内置，与引擎模型根彻底解耦

sherpa 三引擎共用的 `silero_vad.onnx`（~1.8MB）改为**随安装包内置**，而非运行时下载：

- **落盘位置**：`extraResources/sherpa/vad/silero_vad.onnx`。`electron-builder.yml` 已用 `from: ./extraResources/sherpa/ → to: ./extraResources/sherpa/` 整目录拷贝，**无需改构建配置**即随三平台发包。
- **运行时解析**：复用既有 `getExtraResourcesPath()`（`utils.ts`：dev=`appPath/extraResources`，prod=`resourcesPath/extraResources`）→ `path.join(..., 'sherpa', 'vad', 'silero_vad.onnx')`。extraResources 为**解包后的真实文件**，满足 sherpa 原生插件必须用真实文件系统路径（不能在 `app.asar` 内）的硬约束。
- **三 getter 统一**：`getFunasr/Qwen/FireRedVadModelPath()` 一律返回该内置只读路径；`is*VadInstalled()` 基于内置文件（恒真），`is*Ready()` 退化为「至少一个 ASR 模型已装」。
- **退役下载链路**：`FUNASR_MODELS['silero-vad']` 可下载项、`getFunasrFileUrls('silero-vad')` 候选 URL、三面板「下载 VAD」入口与 `downloadFunasrModel{model:'silero-vad'}`。
- **一致性依据**：builtin/whisper.cpp 的 VAD `ggml-silero-v6.2.0.bin` 早已用同样方式内置；本决策只是把 sherpa 这套对齐（两者格式不同：ggml `.bin` vs sherpa `.onnx`，是两个独立文件）。
- **与本变更的关系**：决策 1 让各引擎模型根可自定义，直接暴露了 Context 所述「共享 VAD 耦合」。内置 VAD 是该耦合的最优解——VAD 不再属于任何引擎模型根，自定义路径只搬 ASR 模型，坑 ①②③ 全消。
- **放弃的替代**：(a) 维持下载+文档化护栏（坑 ①③ 仍在）；(b) 共享**可写**固定位（仍需迁移老下载、需可写目录）；(c) 每引擎各存一份（违背"共用一份"，多份下载）。内置 = 共享固定位的**只读最优形态**，连"迁移老下载"都省（老下载变无害残留，忽略即可）。

## Risks / Trade-offs

- **[大文件拷贝阻塞]**（fireRed ~1.74GB 本地复制）→ 导入期间置忙碌态并禁用重复触发；进度条留作后续增强（Open Question）。
- **[改路径后旧模型"消失"]**（实为换了读取位置）→ 文案明确说明不自动迁移；与现有引擎行为保持一致以降低认知负担。
- **[fasterWhisper 合成快照与运行时加载兼容性]**：python 运行时须经 `resolveCt2ModelSnapshotDir()` 拿到的绝对快照路径加载，而非依赖 HF `refs/main`。→ 落地后需冒烟验证导入的 CT2 模型可被实际转写加载。
- **[自定义路径不可写/跨盘权限]** → getter `ensureDir` 失败或拷贝失败时返回错误并 toast；不静默吞错。
- **[导入错误引擎的文件夹]** → `requiredFiles` 预校验拦截，返回 `invalid-layout` 不写盘。
- **[并发与运行时占用]**（sherpa 三引擎共享同一 worker）→ 导入仅做文件拷贝不触发 worker；但覆盖正在使用的模型目录有锁风险 → 沿用删除模型时"先释放 worker"的既有策略，或在任务运行中禁止导入/改路径。
- **[内置 VAD 增大安装包]**（决策 6）→ ~1.8MB，可忽略；与既有 `ggml-silero-v6.2.0.bin`、`addon.node` 等 extraResources 二进制同级。
- **[二进制入库]** → 需向仓库提交 `silero_vad.onnx`；项目已提交同类二进制，符合既有惯例。
- **[dev 环境就位]** → dev 下 `getExtraResourcesPath()` 取 `appPath/extraResources`，文件随源码提交即就位；CI 打包经 extraResources 整目录拷贝随包发出。

## Migration Plan

- 无数据迁移。新增设置项均为可选，缺省 `undefined` → getter 回退至现有默认路径 → 既有用户行为零变化。
- **共享 VAD（决策 6）**：老用户 funasr 根里已下载的 `silero-vad/silero_vad.onnx` 在切换为内置后变为**无害残留**，运行时不再引用；不强制清理（可作后续可选清理项）。新逻辑直接读内置文件，无需用户任何动作。
- 回滚：还原代码即可；遗留的设置键与残留 VAD 文件均被忽略，无副作用。

## Open Questions

- 大文件导入是否需要进度反馈（本期忙碌态，未来可接入拷贝进度）。
- 改路径时是否提供「一并迁移旧目录模型」的可选项（本期不做）。
- 是否在任务运行中全面禁止导入/改路径（倾向：与运行时变更一致地禁止，避免文件锁）。
- 内置 VAD（决策 6）后是否主动清理老用户遗留的已下载 VAD（本期不做，留作可选清理）。
- 内置 VAD 缺失/损坏（极端：安装包被裁剪）时的兜底（倾向：明确报错提示重装，不回退到下载）。
