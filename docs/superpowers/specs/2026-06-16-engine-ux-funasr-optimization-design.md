# 引擎管理 UX 重构 + FunASR 多模型/引擎感知优化 — 设计文档

- 日期：2026-06-16
- 状态：已批准设计，待评审
- 范围：P0/P1 之后、P2 之前的当前版本优化
- 涉及仓库：
  - 主仓 `SmartSub`（Electron + Next.js 渲染层）
  - 引擎仓 `/Users/xiaodong/Documents/code/smartsub-py-engine`（Python sidecar）

---

## 1. 背景与目标

P0（faster-whisper 三层架构）与 P1（FunASR / SenseVoice via sherpa-onnx）已落地。多引擎已可用，但围绕「新增引擎」暴露出一批 UX 与一致性问题：引擎管理页又长又乱、FunASR 只有单模型且只能在引擎卡片里管理、FunASR 启用强依赖先下模型、任务台对 FunASR 误判「无模型」、顶部引擎徽标与模型页「当前引擎」对 FunASR 显示错误。

本设计要解决用户提出的 8 点，核心可归纳为两条主线：

1. **引擎管理 UX 重构**：把引擎管理改成「工作台卡片 + 管理抽屉」，一屏看全所有引擎，配置项收进抽屉。
2. **模型层引擎感知归一**：让渲染层与主进程所有「按引擎」分支都正确识别 `funasr`，并把 FunASR 扩展为多 ASR 模型（新增 Paraformer 中文专精），模型统一在「模型」Tab 管理。

### 1.1 成功标准

- 引擎页一屏可见全部引擎（卡片网格），每卡片有「设为当前 / 管理」；点「管理」从右侧抽屉打开该引擎全部配置。
- 卡片展示引擎特色 / 推荐场景。
- FunASR 仅需安装引擎包即可「设为当前」（与 faster-whisper 一致），不再强制先下模型。
- FunASR 下载模型后任务台可正常开始任务；本地命令行仍不校验模型文件。
- 顶部引擎徽标对 FunASR 正确显示（不再是原始 key）。
- 模型管理页「当前转写引擎」对 FunASR 正确显示为 FunASR（不再误显「本地命令行」）。
- 任务页引擎为 FunASR 时，模型下拉只列已安装的 FunASR ASR 模型（VAD 不出现在下拉）；无 ASR 模型时显示「去下载模型」。
- FunASR 新增 Paraformer 中文专精模型，可在模型页下载 / 删除并用于转写。

### 1.2 非目标（YAGNI）

- 不为 FunASR 增加 Whisper 系模型（用户明确不需要）。
- 不重写 faster-whisper / ggml 既有下载、校验、升级链路（仅复用与小幅适配）。
- 不引入新的下载协议或后端基础设施。
- 不做与本次无关的重构。

---

## 2. 现状关键事实（代码级）

> 这些事实来自对现有代码的核对，是后续设计的依据。

- 引擎类型已含 funasr：`types/engine.ts` 的 `TranscriptionEngine = 'builtin' | 'fasterWhisper' | 'funasr' | 'localCli'`。
- 引擎切换后端只校验引擎包：`main/helpers/ipcEngineHandlers.ts` 的 `set-transcription-engine` 对 funasr 仅判断 `isEnginePackageInstalled('funasr')`，**不**校验模型。→ 第 3 点（启用逻辑）是纯前端问题。
- FunASR「设为当前」按钮被 `fullyReady` 卡住：`FunasrEngineCard.tsx` 第 548 行 `fullyReady && !isActive` 才渲染按钮；`fullyReady = baseReady && pkgInstalled && modelsReady`。→ 改为 `pkgInstalled` 即可放开。
- 任务台自动选模型已走引擎感知入口：`pages/[locale]/tasks/[type].tsx` 第 246–257 行用 `getSelectableModelsForEngine(systemInfo, useLocalWhisper)` 自动写入 `formData.model`。→ 只要该函数对 funasr 返回非空，`TaskControls` 的 `!formData.model` 拦截即自动解除。
- 引擎感知逻辑缺 funasr 分支：`renderer/lib/engineModels.ts` 的 `getInstalledModelsForEngine / getSelectableModelsForEngine / hasModelsForEngine` 只处理 `fasterWhisper / localCli`，funasr 落到默认分支读 `modelsInstalled`（ggml）→ 误判。
- `getSystemInfo` 不含 funasr 模型字段：`systemInfoManager.ts` 返回 `modelsInstalled / fasterWhisperModelsInstalled / transcriptionEngine / pythonEngineStatus`，没有 funasr 模型状态（虽另有 `getFunasrModelStatus` IPC）。
- 模型页对 funasr 走错分支：`ModelsTab.tsx` 的渲染链 `isLocalCli ? … : isBuiltin ? … : (CT2_TIERS)`，funasr 既非这三者，会**落入 else 渲染 faster-whisper CT2 模型**；且 `EngineContextBar` 的 `engineKey` 三元在 funasr 时坍缩成 `'localCli'`（第 461–466 行）→ 显示「本地命令行」。
- 顶部徽标缺 funasr 文案：`Layout.tsx` 用 `t(\`engineBadge.${engine}\`)`，`common.json`的`engineBadge`只有`builtin / fasterWhisper / localCli`。
- `Models.tsx` 的 `transcriptionEngine` prop 类型为 `'builtin' | 'fasterWhisper' | 'localCli'`，缺 funasr。
- `OverviewTab.tsx` 的 `ENGINE_LABEL_KEYS` 缺 funasr（落回 builtin 文案）；`showEngineWarning` 只判断 fasterWhisper。
- FunASR 模型目录与下载均已泛化：`funasrModelCatalog.ts` 的 `FUNASR_MODELS` 是 `Record<FunasrModelId, FunasrModelSpec>`；`getFunasrModelStatus` 已遍历 `Object.keys(FUNASR_MODELS)`；下载 IPC `downloadFunasrModel` 走 `funasrModelDownloader`（repo / files 两种模式）。→ 新增 Paraformer 主要是「加一条目录条目 + sidecar 分支」。
- FunASR 转写适配器当前**硬编码** `sensevoice-small`：`funasrEngine.ts` `transcribeFunasr` 用 `getFunasrModelDir('sensevoice-small')`，未读取 `formData.model`。
- Sidecar 已具备 sense_voice 加载：`smartsub-py-engine/engines/funasr_sensevoice_engine.py` 用 `OfflineRecognizer.from_sense_voice(...)`；注册表 `engines/__init__.py` 以 `sherpa_onnx` 是否可导入来判定 funasr 可用。
- UI 抽屉组件已存在：`renderer/components/ui/sheet.tsx`（右侧抽屉）、`drawer.tsx`。→ 用 `Sheet` 实现管理抽屉。

---

## 3. 架构与关键决策

### 3.1 引擎管理：从「长卡片」到「紧凑卡片 + 管理抽屉」

**决策**：保留 `EngineCardShell` 的视觉骨架，但把卡片 body 收敛为「状态徽章 + 特色/场景 chips + 两个按钮（设为当前 / 管理）」；把现有所有重配置（下载 / 升级 / 卸载 / 检查更新 / 设备 / 计算类型 / FunASR 参数 / 本地命令行）迁入右侧 `Sheet` 抽屉。

**理由**：

- 现有 `EnginesTab.tsx` 单文件 940 行，inline body 过长导致页面冗长。把每个引擎的「管理面板」抽成独立组件，既满足 UX 诉求，又把巨型文件拆成可独立理解/测试的小单元（brainstorming 的隔离原则）。
- 复用现成 `Sheet`，不引入新依赖。

**组件分解**（新增目录 `renderer/components/resources/engines/`）：

| 组件                            | 职责                                                                                         | 依赖                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------- |
| `EngineWorkbenchCard.tsx`       | 通用紧凑卡片：图标 + 名称 + 推荐徽标 + 状态徽章 + 特色/场景 chips + 「设为当前」「管理」按钮 | props 注入状态与回调         |
| `EngineManageDrawer.tsx`        | 右侧 `Sheet`；按 `engine` 渲染对应配置面板                                                   | 各 Panel                     |
| `panels/FasterWhisperPanel.tsx` | 下载/修复/卸载/检查更新/升级 + 设备/计算类型高级设置                                         | 现有 faster-whisper handlers |
| `panels/FunasrPanel.tsx`        | 引擎包下载/卸载/检查更新/升级 + ITN/线程参数 + 「去模型页下载模型」入口（不含模型列表）      | 现有 funasr 引擎包 handlers  |
| `panels/LocalCliPanel.tsx`      | whisperCommand 配置                                                                          | 现有 handlers                |
| `panels/BuiltinPanel.tsx`       | 说明 + 「去模型页」入口（builtin 无需下载引擎）                                              | —                            |
| `panels/BaseRuntimePanel.tsx`   | Python 基座状态/升级（迁移自 `BaseRuntimeCard`）                                             | 现有 base handlers           |

**状态归属**：所有引擎共享状态（`currentEngine`、`engineStatuses`、`downloadProgress`、`updateInfo`、`taskBusy`、`binarySource`、FunASR 引擎包状态等）继续集中在 `EnginesTab.tsx`，通过 props 下发给卡片与抽屉，避免逻辑散落、降低回归风险。`EnginesTab` 维护 `manageEngine: TranscriptionEngine | null` 控制抽屉开合与内容路由。

**卡片网格**：`grid gap-4 sm:grid-cols-2 xl:grid-cols-3`，Python 基座作为一张卡（管理走 `BaseRuntimePanel`）。

**特色 / 推荐场景**：卡片 chips 复用现有 `engines.tags.*`，并为每个引擎新增一句「推荐场景」文案 `engines.<engine>.scenario`（zh/en）。

### 3.2 模型层引擎感知：单一数据源 + 全分支补 funasr

**决策**：把 FunASR 模型就绪信息纳入 `systemInfo`，并让 `engineModels.ts` 四个函数显式处理 funasr；所有按引擎分支的渲染组件统一改为「认识 funasr」。

`ISystemInfo` 与 `getSystemInfo` 新增字段：

```ts
// types/types.ts
funasrEngineInstalled?: boolean;       // funasr 引擎包已安装
funasrVadInstalled?: boolean;          // silero-vad 已安装
funasrAsrModelsInstalled?: string[];   // 已安装的 FunASR ASR 模型 id（如 ['sensevoice-small','paraformer-zh']）
```

`engineModels.ts` 的 `EngineModelInfo` 同步加上述字段；四函数补 funasr：

- `getInstalledModelsForEngine(funasr)` → `funasrAsrModelsInstalled ?? []`
- `getSelectableModelsForEngine(funasr)` → `funasrAsrModelsInstalled ?? []`（下拉只列已装 ASR 模型，VAD 永不入列）
- `hasModelsForEngine(funasr)` → `funasrVadInstalled && (funasrAsrModelsInstalled?.length ?? 0) > 0`
- `localCli` 保持现状（`hasModelsForEngine=true`、下拉取内置 `models` 名单），即「本地命令行不校验模型文件」。

**模型 id 即下拉值**：`Models.tsx` 渲染 `value={model.toLowerCase()}`，funasr 下拉值就是 ASR 模型 id（`sensevoice-small` / `paraformer-zh`）。转写适配器据此选模型。

### 3.3 FunASR 多模型与 Paraformer

**决策**：FunASR 支持多个 ASR 模型（SenseVoice 多语种、Paraformer 中文专精）+ 一个共用 VAD；用户选哪个 ASR 由任务页模型下拉决定，适配器据 `formData.model` 注入对应模型文件与 `model_type` 给 sidecar。

**Paraformer 具体规格**（已核实 sherpa-onnx API 与 HF 仓库）：

- 仓库：`csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09`（中英双语，int8）
- 关键文件：`model.int8.onnx`、`tokens.txt`
- sidecar 加载：`sherpa_onnx.OfflineRecognizer.from_paraformer(paraformer=<onnx>, tokens=<tokens>, num_threads, sample_rate=16000, feature_dim=80, decoding_method='greedy_search', provider, debug=False)`
- Paraformer 不支持 `use_itn` / `language` 构造参数（仅 SenseVoice 支持）。

### 3.4 取舍记录

- 紧凑卡片 + 抽屉 vs. 继续长卡片折叠：选前者，直接满足 UX 诉求并控制文件体积。
- FunASR 模型管理位置：移到「模型」Tab 统一管理（用户第 2 点），引擎抽屉只保留「引擎包 + 参数 + 去模型页」入口。
- funasr 下拉显示：v1 直接显示模型 id（`sensevoice-small` / `paraformer-zh`，可读性可接受），不引入 label 映射以控制范围；后续可加友好名。

---

## 4. 分模块详细设计

### M1 — 引擎工作台卡片 + 管理抽屉（用户第 1 点）

**改动**：

- 新增 `engines/EngineWorkbenchCard.tsx`、`engines/EngineManageDrawer.tsx`、`engines/panels/*.tsx`（见 3.1）。
- 重构 `EnginesTab.tsx`：
  - 渲染卡片网格；每卡传入 `status / badge / chips / scenario / onSetActive / onManage`。
  - 维护 `manageEngine` 状态；`EngineManageDrawer` 依据它渲染对应 Panel。
  - 现有 handlers（`handleStartDownload / handleUpgrade / handleUninstall / handleCheckUpdate / handleDeviceChange / handleComputeTypeChange / handleSaveWhisperCommand` 等）整体迁入或下发到对应 Panel；下载进度 / 更新监听逻辑保留在 `EnginesTab`。
  - `FunasrEngineCard.tsx` 拆解：引擎包相关逻辑迁入 `FunasrPanel`，模型列表逻辑迁出到模型页（见 M6），卡片改用 `EngineWorkbenchCard`。
- `BaseRuntimeCard.tsx` 调整为卡片 + `BaseRuntimePanel`（或在 Panel 中复用其现有内容）。

**验收**：一屏可见全部引擎卡片；点「管理」右侧抽屉打开对应配置；点「设为当前」切换引擎并即时更新顶部徽标（沿用 `transcription-engine-changed` 事件）。

### M2 — 模型层引擎感知归一（用户第 4/6/7/8 根因）

**改动**：

- `types/types.ts`：`ISystemInfo` 增 `funasrEngineInstalled / funasrVadInstalled / funasrAsrModelsInstalled`。
- `main/helpers/systemInfoManager.ts`：`getSystemInfo` 填充上述字段（复用 `isEnginePackageInstalled('funasr')`、`isFunasrModelInstalled('silero-vad')`、新增 `getInstalledFunasrAsrModels()`）。
- `renderer/lib/engineModels.ts`：`EngineModelInfo` 加字段；四函数补 funasr 分支（见 3.2）。
- `renderer/components/Models.tsx`：`IProps.transcriptionEngine` 改为 `TranscriptionEngine`（含 funasr）。

**验收**：`getSelectableModelsForEngine(funasr)` 返回已装 ASR 模型；`hasModelsForEngine(funasr)` 在「VAD + ≥1 ASR」时为 true。

### M3 — 任务可开始校验修复（用户第 4 点）

**说明**：无独立改动，由 M2 达成。FunASR 装好「VAD + ≥1 ASR」后 `hasModelsForEngine=true` → `InlineConfigBar` 渲染模型下拉而非「去下载模型」；`[type].tsx` 自动选中首个 funasr ASR 模型 → `TaskControls` 的 `!formData.model` 拦截解除。`localCli` 仍 `hasModelsForEngine=true` 且不校验模型文件。

**验收**：FunASR 当前引擎 + 已装模型 → 任务可开始；未装模型 → 模型位显示「去下载模型」并跳模型页。

### M4 — FunASR 启用逻辑对齐 faster-whisper（用户第 3 点）

**改动**（纯前端）：

- `FunasrPanel`（原 `FunasrEngineCard`）：把「设为当前」按钮的渲染条件由 `fullyReady` 改为 `pkgInstalled`。
- 状态徽章：`pkgInstalled && !modelsReady` 显示「需下载模型」（已有 `engines.funasr.needsModels`），但仍允许设为当前。
- 后端无需改动（`set-transcription-engine` 已只校验引擎包）。

**验收**：仅装 FunASR 引擎包即可设为当前；设为当前后任务页按 M3 引导去下模型。

### M5 — FunASR 多模型 + Paraformer（用户第 2/7 点，跨仓）

#### 5.1 引擎仓 `smartsub-py-engine`

- `engines/funasr_sensevoice_engine.py`（保留文件名，泛化内部）：
  - `_build_recognizer(sherpa_onnx, params)` 按 `params['model_type']` 分支：
    - `'paraformer'` → `from_paraformer(paraformer=asr_model, tokens=tokens, num_threads=…, sample_rate=16000, feature_dim=80, decoding_method='greedy_search', provider=…, debug=False)`
    - 其它（默认 `'sense_voice'`）→ 现有 `from_sense_voice(...)`
  - `_get_recognizer` 缓存 key 增加 `model_type`。
  - `transcribe / preload` 透传 `model_type`；paraformer 分支忽略 `language / use_itn`。
- `_version.py`：bump engineVersion（使 App 检查更新可发现新 sidecar）。
- CI（`release.yml`）：重跑发布 latest（funasr 依赖不变，仍 `requirements-funasr.txt` 的 sherpa-onnx）。
- `smoke_test.py`：可选补一个 paraformer 冒烟（有模型时）。

#### 5.2 主仓 `SmartSub`

- `main/helpers/funasrModelCatalog.ts`：
  - `FunasrModelId` 增 `'paraformer-zh'`：`'sensevoice-small' | 'paraformer-zh' | 'silero-vad'`。
  - `FunasrModelSpec` 增 `kind: 'asr' | 'vad'` 与 `modelType?: 'sense_voice' | 'paraformer'`。
  - 新增 `paraformer-zh` 条目（repo / keepFiles / requiredFiles 见 3.3；`kind:'asr', modelType:'paraformer'`）；`sensevoice-small` 标 `kind:'asr', modelType:'sense_voice'`；`silero-vad` 标 `kind:'vad'`。
  - 新增 `getInstalledFunasrAsrModels(): FunasrModelId[]`（返回已装且 `kind==='asr'`）。
  - `isFunasrReady()` 重定义：`isFunasrModelInstalled('silero-vad') && getInstalledFunasrAsrModels().length > 0`。
- `main/helpers/engines/funasrEngine.ts`：
  - `transcribeFunasr` 读取 `ctx.formData.model`（funasr ASR id）；校验属于已装 ASR 模型，否则回退首个已装 ASR；据 catalog 取该模型目录的 `model.int8.onnx`/`tokens.txt` 与 `modelType` 注入 sidecar 参数。
  - 就绪校验消息按新 `isFunasrReady` 调整。
- `main/helpers/engines/funasrParams.ts`：`FunasrSidecarParams` 增 `model_type: string`；由适配器注入（默认 `'sense_voice'`）。

**验收**：模型页可下载/删除 Paraformer；任务页 FunASR 下拉出现已装 ASR 模型；选 Paraformer 转写走 `from_paraformer`。

### M6 — 模型 Tab 统一管理 FunASR（用户第 2/6 点）

**改动**（`renderer/components/resources/ModelsTab.tsx`）：

- `ENGINE_OPTIONS` 增 `{ id: 'funasr', icon: Languages }`。
- `EngineContextBar` 的 `engineKey` 计算增加 funasr 分支（修复第 6 点「本地命令行」误显）。
- 渲染链增加 funasr 分支：新增 `FunasrModelSection`（迁移自 `FunasrEngineCard` 的模型行逻辑），列出 ASR 模型（`sensevoice-small`、`paraformer-zh`）+ VAD（`silero-vad`，标注为必需基础组件）；复用 `downloadFunasrModel / deleteFunasrModel / cancelModelDownload` IPC 与 `downloadProgress` 的 `funasr:<id>` 事件。
- 模型路径展示与「打开目录」：funasr 分支显示 `models/funasr` 根目录；`openModelsFolder` 的 `pathType` 增加 `'funasr'`（`systemInfoManager.ts` 对应分支返回 `getFunasrModelsRoot()`）。
- `hasAnyInstalled` / 空态：funasr 分支基于已装 ASR + VAD 判断。
- `FunasrEngineCard` 中的模型列表区块移除（迁至此处）。

**验收**：模型页「当前转写引擎」对 FunASR 正确显示；FunASR 模型在模型页可统一下载/删除。

### M7 — i18n 补齐（用户第 5 点）

- `renderer/public/locales/{zh,en}/common.json`：`engineBadge` 增 `funasr`（zh/en 均为 `"FunASR"`）。
- `renderer/public/locales/{zh,en}/modelsControl.json`：`engineFilter.funasr`、`engineModelHint.funasr`（如 zh：「以下为 FunASR 模型：SenseVoice 多语种、Paraformer 中文专精，及共用的 VAD」）。
- `renderer/public/locales/{zh,en}/resources.json`：
  - 新增各引擎 `engines.<engine>.scenario`（推荐场景一句话）。
  - FunASR 模型新增 `engines.funasr.models.paraformer-zh.{name,desc}`。
- 运行 `npm run check-i18n` 校验 zh/en 键齐全。

### M8 — 全面引擎感知排查（用户第 8 点）

逐处确认/补 funasr：

- `renderer/components/Models.tsx`：类型联合（M2 已含）。
- `renderer/components/resources/OverviewTab.tsx`：`ENGINE_LABEL_KEYS.funasr`；`showEngineWarning` 增加「funasr 引擎包未装」判断（基于 `systemInfo.funasrEngineInstalled`）。
- `renderer/components/onboarding/OnboardingDialog.tsx`：核对引擎分支是否需要 funasr 文案/入口。
- `renderer/pages/[locale]/home.tsx`：已用 `hasModelsForEngine`，M2 后自动正确，复核 banner 文案。
- `renderer/components/Layout.tsx`：徽标 M7 后正确，复核引擎解析。
- 主进程：`getSystemInfo` 字段（M2）、`openModelsFolder` 的 funasr 分支（M6）。

---

## 5. 数据流（FunASR 选模型 → 转写）

```
模型页下载 Paraformer (downloadFunasrModel{model:'paraformer-zh'})
  → 文件落到 userData/models/funasr/paraformer-zh/{model.int8.onnx,tokens.txt}
getSystemInfo → funasrAsrModelsInstalled:['sensevoice-small','paraformer-zh'], funasrVadInstalled:true
任务页 [type].tsx 自动选 → formData.model='paraformer-zh'（或用户在下拉改选）
开始任务 → funasrEngine.transcribeFunasr 读 formData.model
  → catalog 查 'paraformer-zh' → asr 目录 + model_type='paraformer'
  → sidecar params{asr_model,tokens,vad_model,model_type,...buildFunasrParams}
  → funasr_sensevoice_engine._build_recognizer 走 from_paraformer
  → 分段转写 → SRT
```

---

## 6. 错误处理与边界

- FunASR 设为当前但未装模型：任务页模型位显示「去下载模型」（M3）；不阻塞设为当前（M4）。
- 仅装 VAD 未装任何 ASR：`hasModelsForEngine(funasr)=false` → 引导下载 ASR。
- `formData.model` 为旧引擎残留值：`[type].tsx` 既有「不在 selectable 内则改写为 selectable[0]」逻辑兜底。
- 选了某 ASR 后将其删除：下次 `getSystemInfo` 刷新后自动回退；适配器再校验一次并回退首个已装 ASR。
- Paraformer sidecar 不支持 itn/language：适配器对 paraformer 不传这两项；sidecar 分支也忽略，避免构造报错。
- 下载互斥：沿用 `downloadingModels` 单并发与 `anotherDownloadInProgress`。

---

## 7. 测试与验证

- 类型检查：`npx tsc --noEmit`（根与 renderer）。
- i18n：`npm run check-i18n`。
- 引擎仓：`python smoke_test.py`（faster-whisper + funasr，可选 paraformer）。
- 手工冒烟（`npm run dev`）：
  1. 引擎页卡片网格 + 管理抽屉开合、设为当前、下载/卸载/升级路径。
  2. 仅装 FunASR 引擎包即可设为当前；顶部徽标显示 FunASR。
  3. 模型页「当前引擎=FunASR」正确；下载 SenseVoice / Paraformer / VAD。
  4. 任务页 FunASR 下拉只列已装 ASR；选 Paraformer 可开始并产出字幕。
  5. 切回 localCli：模型不校验，可开始。
- 每个 Task 完成后原子提交（遵循仓库提交规范）。

---

## 8. 风险

- **M1 大重构**：`EnginesTab.tsx`（940 行）拆分易引入下载/校验/升级回归。缓解：状态集中保留在 `EnginesTab`，handlers 原样下发，分 Task 小步提交并逐项手工冒烟。
- **M5 跨仓发布**：Paraformer 依赖新 sidecar 代码，App 需重新下载/更新 funasr 引擎包。当前无正式发布用户，可本地 build 引擎包拷入 userData 验证，或重跑 CI 发 latest。
- **抽屉信息密度**：配置迁入抽屉后单引擎操作多一次点击；通过卡片直出「设为当前」高频操作来平衡。

---

## 9. 实施顺序（建议）

1. M5.2 catalog/类型基座（`FunasrModelId`、`kind/modelType`、helpers）→ 为 M2 提供数据。
2. M2 `systemInfo` + `engineModels` 引擎感知（解锁 M3/M4 校验）。
3. M4 FunASR 启用放开（小改）。
4. M6 模型页 FunASR 分支（含从卡片迁出模型列表）。
5. M5.1 引擎仓 sidecar paraformer + 版本/CI；M5.2 适配器/参数接线。
6. M1 引擎卡片 + 抽屉重构。
7. M7 i18n、M8 全面排查与复核。

> 注：M1 可与 M2–M6 并行推进，但建议先稳住数据层（M2–M6）再做大 UI 重构，降低同时调试两层的成本。
