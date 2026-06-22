## Why

「Precision Slate」重设计与「页面节奏」打磨给了软件稳固的皮肤，但其**交互模型**仍停留在「批处理器」：内容区顶栏重复侧栏品牌且中段半空、正在进行的工作（运行中的任务 / 模型下载 / 最近完成或失败）散落在侧栏 pill + toast + 日志弹窗里没有「一处可见」的汇聚、也缺少键盘优先的快速跳转手段——这些都在稀释「专业工作站」的定位。本变更把这些**结构性**问题一并解决，并**取代**仅有 proposal 的 `refine-app-chrome-and-states`（顶栏重构 / 标题去重 / 加载空态），将其并入更内聚的外壳升级。

## What Changes

- **顶栏 → 上下文工具条（共享画布）**：移除与侧栏重复的品牌名（**保留**版本号 + 更新提示），改为承载「页面上下文（页名 / 子页返回）+ Cmd+K 入口 + 右侧状态簇」。
- **任务中枢 / 活动面板（D1）**：在顶栏状态按钮上挂一个 popover，统一呈现「单个运行中的任务（含进度）+ 模型下载 + 最近完成 / 失败（跳结果 / 看日志）」；版本号与「有新版本」落在面板页脚，并在按钮上以小圆点提示更新。`/recent-tasks` 仍是全量档案。
- **命令面板（D4）**：用仓库已存在但未作全局用途的 `cmdk` 基元做全局 Cmd+K——跳转页面、打开最近工程（work items）、执行全局动作（新建任务 / 切换主题 / 检查更新 / 查看日志 / FAQ…）；并补一小批「跳转」导航快捷键，登记进现有 `ShortcutsHelpDialog`。
- **标题去重**：消除页级标题与首个分区标题的同名回声（translation「翻译服务 / 翻译服务」）；由顶栏承载页面上下文。枢纽页 `PageHeader` 保留。
- **加载态与空态**：引入 `Skeleton` 基元 + 统一空态，覆盖数据驱动界面（引擎模型清单、翻译服务商、任务行、最近任务、活动面板、命令面板）。
- **取代**：移除 proposal-only 且未入库的 `refine-app-chrome-and-states`，其范围并入本变更。
- **非破坏**：不改变任何业务数据、IPC、引擎 / 翻译 / 任务 / 校对行为；改动集中在外壳、呈现，以及一层**纯增量**的命令 / 键盘能力。

## Capabilities

### New Capabilities

- `app-shell-and-activity`: 上下文顶栏（外壳框架）+ 统一活动中枢（实时状态汇聚）+ 页面标题层级去重。
- `command-palette`: 全局 Cmd+K 命令面板（导航 / 最近工程 / 全局动作）+ 键盘可发现性。
- `loading-and-empty-states`: 数据驱动界面的 skeleton 加载 + 统一空态模式。

### Modified Capabilities

<!-- 无。标题层级虽与 page-layout-rhythm 精神相关，但该 spec 维持不变；本次去重是移除一处内容回声，而非改动节奏契约。design.md 中交叉引用其关系。 -->

## Impact

- **代码**：`renderer/components/Layout.tsx`（顶栏 / 状态簇 / 面板挂载）、新增 `ActivityCenter` + 顶栏状态按钮、新增 `CommandPalette`（复用 `ui/command.tsx`）、`PageHeader` 与各页分区标题、新增 `renderer/components/ui/skeleton.tsx`、各数据界面加载分支（`EngineModelTab`/`ModelLibrarySection`、`ProvidersTab`、`tasks/[type]` 的 `TaskRowList`、`recent-tasks`）、`hooks/useHotkeys` 注册、`ShortcutsHelpDialog`。
- **数据 / IPC**：仅只读消费既有事件（`taskComplete`、`modelDownloadDetail`、`getTaskStatus`、`getWorkItems`）；无新增后端行为。命令面板动作复用既有 handler / 路由。
- **i18n**：命令面板、活动中枢、skeleton / 空态新增文案 key；标题去重涉及少量 key 调整。
- **依赖**：无新增（`cmdk`/`vaul`/`sonner` 均已在仓库）。
- **风险**：顶栏是全局外壳、活动面板与命令面板为新增面，需在 Electron 窗口内逐页核对（深 / 浅色、各页返回 / 动作 / 状态归位）。
