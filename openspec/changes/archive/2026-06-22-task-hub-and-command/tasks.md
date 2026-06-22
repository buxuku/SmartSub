## 1. 顶栏「上下文工具条」骨架

- [x] 1.1 移除顶栏与侧栏重复的品牌名块（版本 / 更新提示暂迁右侧状态簇，功能与现状等价）
- [x] 1.2 左侧引入路由派生的「页面上下文」面包屑（章节名，chrome 定位，与枢纽页 PageHeader 内容标题区分）；子工作面「返回 + 工程名」沿用页内既有头部（顶栏化留作后续细化）
- [x] 1.3 右侧状态簇成形：accel(⚡) 保持常驻独立 chip（行为 / 跳转不变）；版本 / 更新并入右侧簇（Phase 2 再移入活动面板页脚）；「活动」按钮与 Cmd+K 入口位随 Phase 2/3 落地
- [x] 1.4 顶栏中英文标签宽度核对（英文较长），深 / 浅色对比核对（浏览器走查：zh/en 面包屑 + 右簇标签均不溢出，深 / 浅色对比正常；详见 5.1/5.4）

## 2. 活动中枢（popover）

- [x] 2.1 新增 `ActivityCenter` 组件（popover 锚定顶栏活动按钮，`busy` 时图标转圈）
- [x] 2.2 「正在进行」区：消费 `taskRunning` 呈现运行中任务 + 查看入口（→ `/recent-tasks`）
- [x] 2.3 「下载」区：消费 `downloadPill` 呈现下载进度（downloading/extracting/completed/error + Progress 条）
- [x] 2.4 「最近」区：`getWorkItems` 取最近 5 项，状态点（`getWorkItemStatus`）+ 名称 + 时间，点击直达 `getWorkItemTarget`
- [x] 2.5 面板页脚：版本号 +「有新版本 vX」入口（→ UpdateDialog）；`updateAvailable` 时活动按钮加更新提示点
- [x] 2.6 面板「查看全部」跳 `/recent-tasks`；侧栏 `taskRunning`/`downloadPill` 暂与面板共存（收口留作后续评估）

## 3. 命令面板（Cmd+K）

- [x] 3.1 新增 `CommandPalette`，复用 `ui/command.tsx`，`mod+k`（allowInInput）唤起 / Esc 关闭，在 `Layout` 挂载；并加顶栏居中 Cmd+K 入口填补中段真空
- [x] 3.2 跳转分组：六导航项 + `/recent-tasks`（复用 common 既有标签 key）
- [x] 3.3 最近工程分组：`getWorkItems` 取最近 5 → `getWorkItemTarget` 直达（无工程时整组不渲染，不空挂）
- [x] 3.4 动作分组：复用既有 handler（新建转写/翻译/转写+翻译、切主题、折叠侧栏、检查更新、查看日志、速查、FAQ、引导、GitHub），不含破坏性动作；开 Dialog 类动作用 deferred 关面板规避 Radix pointer-events 争用
- [x] 3.5 决策：以命令面板（`mod+k`）作为导航加速器；为避免与 Electron 菜单加速器/序列键冲突，v1 不加逐节 number/序列快捷键（沿用 `allowInInput`，不破坏 `mod+,`/`?`）
- [x] 3.6 在 `ShortcutsHelpDialog` 全局组登记 `mod+k` 命令面板（中/英）

## 4. 标题去重 + 加载 / 空态

- [x] 4.1 新增 `renderer/components/ui/skeleton.tsx`（`bg-muted` + `animate-pulse`，无新依赖）
- [x] 4.2 去除页级标题与首个分区标题的同名回声：translation 页 `ProvidersTab` 左栏标题「翻译服务」→ 改为列表语义标签「服务商」(`providerListTitle`) 并降权为 `text-sm font-semibold text-muted-foreground`；逐页核对 home/engines/proofread/subtitleMerge/settings/recent-tasks 均无同名回声（engines 右栏为引擎名、home 为「最近任务」）
- [x] 4.3 为数据界面铺 skeleton：新增与 `WorkItemList` 行同构的 `WorkItemRowsSkeleton`，用于 recent-tasks（替换纯文本 loading）与 home 最近区（消除「先闪空态」）；活动面板「最近」区加载骨架。说明：TaskRowList 文件来自本地导入同步渲染（已有拖拽空态，无异步加载，不铺骨架）；ModelLibrarySection 已有 `systemInfoLoaded`/`basisLoading` 加载分支；ProvidersTab 内建服务商为静态即时渲染，无需骨架
- [x] 4.4 空态：页面区沿用既有 `EmptyState`（home/recent-tasks）；命令面板 `CommandEmpty`、活动面板空态用同款「muted 图标 + muted 文案」语言（popover 内不套 EmptyState 的虚线框，避免过重）
- [x] 4.5 i18n：标题去重新增 `providerListTitle`（中/英）；活动中枢 / 命令面板文案 key 已在 P2/P3 落；skeleton 为 aria-hidden 纯视觉无新增文案

## 5. 运行态逐页核对（Electron 窗口）

- [x] 5.1 顶栏上下文/状态簇逐页归位：浏览器（注入 window.ipc 桩）走查 home·translation·engines·recent-tasks 均正确——面包屑随路由（home「任务」/engines「引擎与模型」/translation「翻译服务」），右簇 ⚡chip+活动按钮+帮助常驻；recent-tasks 作子页无面包屑（页内「返回启动台」承接）
- [x] 5.2 活动中枢：桩 idle 态下「最近」区呈现 5 项（状态点+名称+时间）+ 页脚版本 v2.17.0-beta.19 +「查看全部」跳转；运行/下载/更新三态因桩为静态未逐一触发（代码分支已审，留 Electron 真机复核）
- [x] 5.3 命令面板：跳转分组（6 导航+最近任务）、最近工程（输入「周会」即过滤到「周会记录.mov」）、动作分组（新建×3/切主题/折叠/检查更新/日志/速查/FAQ/引导/GitHub）均呈现且可选
- [x] 5.4 深/浅色：zh 下深、浅色均核对通过（顶栏/卡片/列表/popover/命令面板对比正常）。**中/英**：英文外壳整体正常；曾观察到**新加 i18n key（cmd._ / activity._ / providerListTitle）在运行中的 dev server 回退中文**——经 `__NEXT_DATA__` 验证为服务端嵌入的 en bundle 缺这些 key（源文件正确、无重复、JSON 合法），属 nextron dev 编译缓存陈旧，非代码缺陷。**已实证消解**：一次 Layout 改动触发 HMR 重编译后，英文页 `cmd.*` 已正确显示（"Search or jump to…"），确认仅为 dev 缓存、生产构建不受影响。功能零回归（任务/下载/更新/校对未触改）。

## 6. 收尾

- [x] 6.1 `openspec validate task-hub-and-command --strict` 通过
- [x] 6.2 自检内容冻结：`git diff` 实证——改动仅落在外壳/页面 UI、locale、样式 / tailwind 配置（Layout、ShortcutsHelpDialog +1 速查项、ProvidersTab 仅标题文案/降权、home/recent-tasks 仅加载骨架 UX、globals.css +chrome token、tailwind +chrome 颜色、locale +keys）+ 新增组件（ActivityCenter/CommandPalette/skeleton/WorkItemRowsSkeleton）；**无主进程 / IPC / 引擎·翻译·任务·校对·DB 文件变更**，新增组件仅只读复用既有 `getWorkItems` 通道。唯一文案变更为标题去重（translationServices→providerListTitle）
- [x] 6.3 与 `page-layout-rhythm` 交叉引用：标题去重沿用其两层写法契约、未改其规则故无 delta（见 design 决策④）；本变更已 `--strict` 通过、tasks 全勾，**归档就绪**（待部署 / 合入后执行 `openspec archive task-hub-and-command`，本阶段不自动归档）

## 7. 外壳视觉精修（会话内追加，纯外壳 UI）

- [x] 7.1 左上角品牌双语字标：本地化主名后追加弱化英文字标 `SmartSub`（`t('brandName') !== 'SmartSub'` 条件抑制，zh 显示「妙幕 SmartSub」、en 仅「SmartSub」不重复）；`items-baseline` 对齐
- [x] 7.2 外壳分区「色阶台阶」化（决策⑧）：新增 `--chrome` 面（深 9% / 浅 97%）+ tailwind 颜色注册；侧栏 + 顶栏改 `bg-chrome` 合为 L 型安静面板，移除侧栏 `border-r`、logo `border-b`、顶栏 `border-b` 三条硬线与左上角硬十字
- [x] 7.3 内容区 `<main>` 加单层发丝线 `border-l border-t border-border/60`：仅勾勒 chrome↔画布的内 L 边补回嵌定感，顶栏 / 侧栏仍无缝同色、不复现网格盒与转角十字；深 / 浅色浏览器走查通过
