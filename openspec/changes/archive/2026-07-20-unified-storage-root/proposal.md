# Proposal: unified-storage-root

## Why

Issue #388：用户把应用装到 D 盘后，仍需**逐个**修改每个模型引擎的下载路径和临时目录，否则全部落在 C 盘默认位置。当前 6 个模型目录 + 1 个临时目录是 7 个互相独立的 settings 键，引擎页要改 5 处、设置页改 1 处，TTS 模型目录甚至没有任何 UI 入口。

另一个长期痛点与此同源：Windows 中文用户名的 `userData` 默认路径本身含中文，whisper.cpp / sherpa-onnx 在非 UTF-8 locale 下打不开中文路径的模型文件，是历史上一批「模型加载失败」问题的根源。目前中文路径风险仅有一句文案提示，无任何代码校验。

一个「统一存储目录」既满足一键换盘的诉求，也为中文用户名用户提供官方逃生通道；同时把中文路径校验收口到所有目录选择入口。

## What Changes

- 新增 `settings.storageRoot`（统一存储根目录）：6 个模型目录与临时目录的解析链变为「引擎单独设置 > 统一根目录/既有默认子目录名 > userData 默认」，一处设置全部跟随。
- 新增共享路径校验模块（`types/pathValidation.ts`）：检测中文（CJK）字符，**硬阻止**——全部 7 个目录选择入口（统一根目录、5 个引擎路径「更改」、自定义临时目录）选中含中文路径时拒绝保存并提示原因；主进程 `setSettings` 对 8 个路径键兜底拒绝持久化。
- 存量数据归一化：`modelsPath` 从 store defaults 移除，启动时把「持久化值 == 出厂默认路径」的 `modelsPath` 键删除，否则存量用户的 whisper.cpp 永远不会跟随统一目录（defaults 中的绝对路径会随任意一次 setSettings 被连带持久化）。
- 副作用修正：Python 运行时重启判定从「`fasterWhisperModelsPath` 键 truthy 且变化」改为「CT2 有效根目录变化」——覆盖设置统一目录、清除单独覆盖两个新触发场景（现状清空覆盖也不会触发，属既有缺陷）。
- 设置页新增「存储位置」区块：统一根目录（浏览/打开/清除）+ 既有临时目录控件归入；`storageRoot` 未设置且默认路径含中文时主动提示设置纯英文目录。
- 引擎页模型路径行显示来源标识（默认 / 统一目录 / 单独设置），单独设置时提供「恢复跟随统一目录」。
- 首次引导「下载模型」步骤前置存储位置决策：内联展示当前存储基座并可一键更改（新装用户零模型，此时改目录无迁移成本），默认路径含中文时就地警示，避免下载后才发现设置项。
- 沿用既有「改路径不迁移文件」语义：设置统一目录后旧模型不自动搬家，toast 提示手动移动或重新下载。

## Capabilities

### New Capabilities

- `unified-storage-root`: 统一存储根目录——解析链与子目录布局、临时目录纳入、中文路径硬校验、存量 modelsPath 归一化、路径来源可视化与恢复跟随、有效路径变化的运行时副作用、不迁移语义与用户提示、默认路径含中文的主动引导。

### Modified Capabilities

（无——各引擎模型下载、临时文件清理等既有能力的需求不变，仅路径解析来源多了一层。）

## Impact

- **类型与存储**：`main/helpers/store/types.ts`（新增 `storageRoot`）、`main/helpers/store/index.ts`（defaults 移除 `modelsPath`）、新增 `types/pathValidation.ts`（主进程/渲染层共享纯函数）。
- **主进程路径解析**：新增 `main/helpers/storagePaths.ts`（纯函数解析核心 + 子目录常量表）；`main/helpers/whisper.ts`、`modelCatalog.ts`、`funasrModelCatalog.ts`、`qwenModelCatalog.ts`、`fireRedModelCatalog.ts`、`ttsModelCatalog.ts`、`fileUtils.ts`（getTempDir）接入。
- **IPC**：`main/helpers/ipcStoreHandlers.ts`（modelsPath 归一化迁移、CJK 兜底、CT2 有效路径重启判定）、`main/helpers/systemInfoManager.ts`（getSystemInfo 返回 `storageRoot` 与各路径来源）。
- **渲染层**：`renderer/pages/[locale]/settings.tsx`（存储位置区块）、`renderer/components/resources/ModelLibrarySection.tsx`（来源标识、恢复跟随、选路校验）、`renderer/public/locales/{zh,en}/settings.json` 与 `modelsControl.json`。
- **测试**：新增 `scripts/test-storage-paths.ts`（`npm run test:storage-paths`）。
- **不纳入本期**（明确 Non-Goal）：`py-engines`、`addons`、`voiceClones`、`dubbing-sessions`、`logs` 仍在 userData；不新增 TTS 路径单独覆盖 UI（跟随统一目录已覆盖其需求）。
