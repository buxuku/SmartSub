## Why

当前「引擎管理」和「模型管理」是资源中心里两个分离的 Tab，但二者强耦合：模型 Tab 的清单完全由**全局当前引擎**（`settings.transcriptionEngine`）驱动，想下载某引擎的模型必须先把该引擎「设为当前」，而设为当前又要求先把引擎包装好。这条链路让新用户困惑（"为什么看不到这个引擎的模型"），也让"先下模型、晚点再决定用哪个引擎"变得不可能。

同时，引擎选择是一个**全局单例**——所有任务被迫共用一个引擎，切换引擎是一次全局状态变更（还会被运行中的任务阻塞）。实际上每个任务应当能独立选择最合适的引擎。

## What Changes

- 资源中心 `engines` + `models` 两个 Tab **合并为单个「引擎与模型」Tab**，采用主从双栏：左栏是引擎列表（仅状态，无"启用"开关），右栏是该引擎的运行时安装/参数 + 模型清单，全部同屏、零弹窗（取代现有的卡片 + Drawer 模式）。资源中心从 5 Tab 收敛为 4 Tab。
- **引擎选择改为逐任务**：任务配置里的"模型"下拉改为「引擎 ▸ 模型」分组下拉，选中即同时确定 (引擎, 模型)；任务携带 `transcriptionEngine`，后端按任务所带引擎执行，而非读全局设置。
- **移除"启用 / 设为当前引擎"概念**：引擎不再有启用开关；任意已就绪引擎都能在任务里被选用。任务默认引擎 = 上次使用（初次为 builtin / whisper.cpp）。
- **模型下载与引擎安装解耦**：未安装某引擎也可先下载该引擎下的模型（后端下载链路本就独立于引擎包）。
- **移除全局引擎指示**：删除顶栏"当前引擎"徽章与模型页的 `EngineContextBar`。
- **BREAKING**：移除全局 `settings.transcriptionEngine` 字段及相关 IPC（`set-transcription-engine` 的"设为当前"语义）。无老用户，零迁移。
- Python 基座（共享运行时）从引擎视图移出，仅保留"检查更新"功能，归入设置页。
- 就绪判断（新手引导、全景）改为**跨引擎**："任意引擎装有任意模型即视为就绪"。

## Capabilities

### New Capabilities

- `engine-model-management`: 统一的引擎与模型管理面（主从双栏）。浏览引擎及其状态、安装/修复/升级/卸载引擎运行时、配置引擎参数（设备/计算类型/自备命令）、以及在同一处下载/删除/导入该引擎的模型——全程不依赖"启用引擎"，模型下载不依赖引擎包是否安装。
- `task-transcription-engine`: 逐任务的转写引擎选择与执行。任务时通过「引擎 ▸ 模型」分组选择器确定 (引擎, 模型)，任务携带引擎并由后端按此执行；默认值取"上次使用"（初次 builtin）；混合引擎队列按最受限引擎钳制并发；跨引擎就绪判断。

### Modified Capabilities

<!-- 仓库 openspec/specs/ 下暂无既有 spec，无需修改既有能力。 -->

## Impact

- **渲染层**：`renderer/components/resources/EnginesTab.tsx` 与 `ModelsTab.tsx`（合并/重构为主从双栏 + 各引擎面板内联）、`resources.tsx`（Tab 收敛 5→4 + 深链接 `?tab=engines`/`?tab=models` 归一）、`OverviewTab.tsx`（管理入口与就绪判断）、`Models.tsx`（改分组下拉）、`InlineConfigBar.tsx`（跨引擎模型/去下载判断）、`tasks/[type].tsx`（默认引擎+模型选择逻辑）、`Layout.tsx`（删除顶栏引擎徽章）、引擎面板 `engines/panels/*`、`BaseRuntimePanel`（迁往设置页）。
- **主进程**：`transcriptionEngine.ts`/`engines/registry.ts`（`getActiveEngineAdapter` → 按任务引擎解析）、`transcriptionRouter.ts`/`taskProcessor.ts`/`fileProcessor.ts`（引擎透传进 `TranscribeContext`、按任务引擎预热 sidecar、并发钳制）、`ipcEngineHandlers.ts`（移除 `set/get-transcription-engine` 的全局语义，新增"上次使用"默认）、`systemInfoManager.ts`（就绪/默认字段）、`store/types.ts`（移除 `transcriptionEngine`、新增 last-used 记忆字段）。
- **数据/设置**：移除 `settings.transcriptionEngine`（及 `useLocalWhisper` 运行时语义），新增"上次使用引擎/模型"偏好。
- **i18n**：`resources`/`modelsControl`/`common` 等 namespace 文案增删（合并 Tab 名、删除引擎徽章/上下文条文案、新增分组选择器文案）。
- **不变**：模型下载/删除/导入底层 IPC（`downloadModel`/`downloadCt2Model`/`downloadFunasrModel`）、各引擎运行时下载器、加速包与翻译服务管理。
