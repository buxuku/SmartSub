## Why

`redesign-precision-slate-ui` 已把「Precision Slate」外观系统（深/浅色 token、单一 Editing-Blue、等宽字段、收紧圆角、品牌声波）落到**系统级**，全局组件已自动继承新观感。但**逐页的结构性表达发生了漂移**：同一种 UI 角色（分区小标题、主从详情头、卡片/面板框、纵向间距、圆角）在不同页面有 3–4 种写法。最贴近设计语言的是经 `5.4` 打磨过的「翻译服务」页——它可作为**基准样板**。本次目标是把这套「页面节奏」固化为契约，并让所有枢纽页/工作面与之对齐，使产品从「系统级精致」走向「逐页一致的精致」。

借力点：共享原子（Card/Button/Input/`label-caps`/`font-mono`/`shadow-sunken`）与 `PageHeader` 大多已就位，本次以 **className 级对齐**为主，几乎不引入新结构，也不新增任何 token/字体/颜色。

## What Changes

- **固化「页面节奏契约」（6 杠杆）**：① 页头（`PageHeader`，已统一）② 分区小标题统一为 `label-caps` ③ 主从详情头统一为 `text-lg`＋描述槽＋`border-b` 分隔 ④ 圆角 `rounded-lg`(容器)/`rounded-md`(控件) ⑤ 卡片/面板统一 1px 描边＋`bg-card`（无 `shadow-sm`）⑥ 纵向节奏（hub `space-y-6`、段内 `space-y-3/4`、页边 `p-4`）。
- **引擎页对齐翻译页**：`EngineModelTab` 右栏详情头由 `text-base` 提升为 `text-lg` ＋ 顶部 `border-b` 分隔，与其「兄弟页」翻译页的详情头量级一致（③）。
- **分区小标题统一**：将 `home`（`text-sm muted-semibold`）、`settings`（`CardTitle`+`IconChip` 中的分区语义）等处的分区标题，按场景统一到 `label-caps` 标准（②）。
- **圆角与纵向节奏收口**：审计并修正零星 `rounded-xl`（如 `recent-tasks.tsx`）→ `rounded-lg`；统一各 hub 页的 `space-y-*` 节奏（④⑥）。
- **卡片/面板框回声**：让主从列表项、运行时面板与 `Card` 的描边/圆角语言一致（⑤）。
- **两个高密度工作面走查**：`tasks/[type]`（任务工作台）与 `proofread`（校对编辑器）的自定义头/工具条/分区，按契约做谨慎的视觉对齐（密度最高，排在最后）。
- **非目标（Non-goals）**：不改任何内容/文案/数据/IPC/功能/信息架构；不新增页面；不新增字体/颜色/token（仅复用 `appearance-theming` 既有语义）；不重排页面布局结构（仅节奏/层级/间距/圆角的 className 级对齐）。

## Capabilities

### New Capabilities

- `page-layout-rhythm`: 跨页面的**结构性一致**契约——页头模式、分区小标题模式、主从详情头模式、圆角刻度、卡片/面板框、纵向间距刻度，以及「所有枢纽页与工作面在内容冻结前提下与基准样板（翻译页）对齐」的要求。它与 `appearance-theming`（色彩/字体/形状 token＝「长什么样」）正交，本能力关注「页面如何被结构化、分层与留白」。

### Modified Capabilities

<!-- 无：appearance-theming 尚未归档为 openspec/specs 能力，且本次为正交的结构性能力，不改其需求行为。 -->

## Impact

- **基准样板（参照，不改或仅微调）**：`renderer/components/resources/ProvidersTab.tsx`。
- **主要对齐点**：`renderer/components/resources/EngineModelTab.tsx`（右栏详情头③、分区②）、`renderer/pages/[locale]/home.tsx`（分区头②、纵节奏⑥）、`renderer/pages/[locale]/recent-tasks.tsx`（圆角④）、`renderer/pages/[locale]/settings.tsx`（分区语义②）。
- **共享头部（保持）**：`renderer/components/PageHeader.tsx`（已是 `text-2xl/semibold/tracking-tight`，本次不动或仅加可选分隔位）。
- **高密度工作面（最后、最谨慎）**：`renderer/pages/[locale]/tasks/[type].tsx` 及其子组件（`TaskControls`/`InlineConfigBar`/`AdvancedSheet`/`TaskRowList`/`TaskGridList`/`LogPanel`）、`renderer/pages/[locale]/proofread.tsx` 与 `renderer/components/proofread/ProofreadEditor`。
- **共享原子（已就位，按需补差）**：`components/ui/{card,button,input}.tsx`、`globals.css` 的 `label-caps`/`shadow-sunken` 工具类。
- **依赖关系**：与 `appearance-theming`（已 complete）同层但正交；与进行中的引擎/模型/翻译类 change 存在共享组件合并面，改动尽量「加类不改结构」以降低冲突。
- **参考资产**：`docs/UI/stitch/{engines-models,translation}.png`（仅作视觉参考，不据此改内容）。
