## Context

`redesign-precision-slate-ui`（已 complete）把外观系统落到系统级：`globals.css` 定义了深/浅色语义 token、`tailwind.config.js` 提供 `font-sans`/`font-mono` 与 `label-caps`/`shadow-sunken` 工具类，共享原子（`Card` 1px 描边无投影、`Button`/`Input` 聚焦主色环、`--radius: 0.375rem`）已就位。`5.4` 还对引擎页/翻译页做了首轮 stitch 对齐（补了选中项 `ring-primary/20`）。

但跨页面的**结构性表达**仍漂移。走查全部表面（壳 + 6 个枢纽页 + 2 个高密度工作面）后，发现同一 UI 角色有多套写法：

```
分区小标题   home=text-sm muted-semibold · providers=label-caps
            settings=CardTitle+IconChip · engines=（无）
主从详情头   translation=text-xl/2xl font-bold + sticky border-b   ← 最完整
            engines   =text-base font-semibold，无分隔            ← 偏平
圆角        多数 rounded-lg，尚有零星 rounded-xl（recent-tasks:246）
纵向节奏     settings=space-y-6 · home=space-y-8 · merge/engines=gap-4
```

`ProvidersTab`（翻译页）是其中最贴合设计语言的一页，可作为**基准样板（oracle）**：在缺少多数页面 stitch 稿的前提下，「与翻译页一致」即视觉验收标准。

关键约束：

- **内容冻结**：不改任何文案/数据/IPC/功能/信息架构；尤其**不新增任何可见文字标签**（新标签需 i18n 多语，属内容变更）。
- **零新增 token/字体/颜色**：仅复用 `appearance-theming` 既有语义；本次为 className 级结构对齐。
- **并行 change**：引擎/模型/翻译类 change 进行中，共享组件有合并面，改动「加类不改结构」。

## Goals / Non-Goals

**Goals:**

- 把「页面节奏」固化为可验收的契约（6 杠杆），以翻译页为基准样板。
- 消除分区小标题/详情头/圆角/纵向节奏的多写法漂移，达成逐页一致。
- 在内容冻结前提下，仅以节奏/层级/间距/圆角的 className 级对齐实现升级。

**Non-Goals:**

- 不改业务逻辑、IPC、数据结构、信息架构、页面功能。
- 不新增可见文字（不给引擎页左栏补「引擎列表」之类新标签）。
- 不新增字体/颜色/token，不引入新组件，不重排页面骨架。
- 不在本次重做工作面的交互流程（仅视觉节奏对齐）。

## Decisions

### D1. 「页面节奏契约」六杠杆（可验收基线）

| 杠杆          | 唯一标准                                                                                                                | 现状                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| ① 页头        | `PageHeader`：`text-2xl font-semibold tracking-tight` + 描述 `text-sm text-muted-foreground`                            | 已统一，保持                     |
| ② 分区小标题  | 见 D2 双层定义                                                                                                          | 4 套写法 → 收敛                  |
| ③ 主从详情头  | 见 D3                                                                                                                   | engines 偏平 → 对齐 translation  |
| ④ 圆角        | 容器 `rounded-lg`、控件 `rounded-md`（`Card`/弹层沿用既有派生）                                                         | 零星 `rounded-xl` → 修正         |
| ⑤ 卡片/面板框 | 1px `border` + `bg-card`，无 `shadow-sm`；列表项/运行时面板回声同款描边                                                 | `Card` 已对齐，列表项/面板待回声 |
| ⑥ 纵向节奏    | hub 页 `space-y-6`；段内 `space-y-3`/`space-y-4`；页边 `p-4`；阅读型页（home/recent）`max-w-4xl` 容器可保留但纵节奏对齐 | `space-y-8`/`gap-4` 等 → 收敛    |

### D2. 分区标题：双层定义（消除歧义，避免过度大写）

- **Tier S — 分区标签**：`label-caps`（11px/700/`tracking-wider`/uppercase）。用于**面板/列内的组标签**：翻译页 `FREE TIER / AI / MT`、`推荐` 标题（已是）、设置页可折叠卡的分区语义。
- **Tier H — 页内小节标题**：`text-sm font-semibold`（中性或 `text-muted-foreground`）。用于 `PageHeader` 之下的**页级小节**：如 home 的「最近任务」。本层保持「一种写法」，不强转为 uppercase。
- **取舍**：把「面板内组标签」与「页级小节标题」分成两层，既统一又不会把 home 的小节标题变成生硬大写；且**只对已存在的标题做样式归一，绝不新增标题**（内容冻结）。

### D3. 主从详情头契约（③）

主从（master-detail）右栏详情头 = 可选图标 + 标题 `text-lg`（`lg:` 断点可 `text-xl`）+ 可选描述槽 + 底部 `border-b` 分隔，与下方运行时/表单区形成清晰分区。

- 翻译页 `ProvidersTab` 已满足（`text-xl/2xl` + sticky `border-b`），作为基准。
- 引擎页 `EngineModelTab` 右栏头由 `text-base font-semibold`（`:633`）提升为 `text-lg`，并在头部行下补 `border-b pb-3`，与下方 `ModelLibrarySection` 既有的 `border-t pt-4` 形成对称分区节奏。
- **取舍**：不强求两页字号像素相同（翻译页是 sticky 头、带图标，量级略大有其语境）；契约只要求「明显强于正文 + 有分隔」，避免引擎页「标题与面板糊在一起」。

### D4. 圆角与纵向节奏收口（④⑥）

- 全仓审计 `rounded-xl` 落点，非刻意大圆角处（如 `recent-tasks.tsx:246` 的 no-match 占位）改 `rounded-lg`；启动台卡片等已是 `rounded-lg` 的保持。
- 各 hub 页纵向节奏向 `space-y-6` 收敛；home 的 `space-y-8`（`:237`）评估下调至 `space-y-6`/`space-y-7`（保留阅读型页的呼吸即可），段内统一 `space-y-3/4`。
- **取舍**：阅读型页（home/recent）保留 `max-w-4xl` 居中容器与略大页边（`px-6 py-10`）作为「轻松浏览」语境的有意差异，仅统一**段间**节奏而非强行等同于工具页的 `p-4`。

### D5. 卡片/面板框回声（⑤）

主从列表项的选中态（`bg-primary/10 ring-1 ring-inset ring-primary/20`，5.4 已统一）保持；非选中态在需要时补静息描边/`hover:border-foreground/20`，与 `Card` 的 1px 描边语言一致，让面板群「成形」而非靠空白堆叠。运行时面板（builtin/fasterWhisper 等）若有裸露分区，按 `Card`/`border-t` 语言补轻分隔。

### D6. 排期分层（工作面最后、最谨慎）

1. **固化契约**：补齐工具类差异（多已就位），本 change 的 spec 即契约。
2. **引擎页对齐**：③ 详情头 + ② 分区（仅归一已存在标题）。
3. **收口**：④ 圆角 + ⑥ 纵向节奏（纯 className）。
4. **两个高密度工作面走查**：`tasks/[type]`、`proofread` 编辑器的自定义头/工具条/分区，按契约谨慎对齐——这两处信息密度最高、回归风险最大，放最后并逐屏运行态核对。

### D7. 与 appearance-theming 的关系

正交：`appearance-theming` 管「token＝长什么样」，本能力管「页面结构节奏」。本次**不动任何 token/颜色/字体**，仅用既有语义 token 与工具类做结构对齐。两者不冲突、可独立回滚（本次回滚＝还原相关组件的 className）。

## Risks / Trade-offs

- [触碰引擎/翻译等仍在演进的共享组件，易与并行 change 冲突] → 「加类不改结构」、小步提交、置后处理工作面。
- [工作面（tasks/proofread）密度高，className 调整可能挤压布局] → 放最后、逐屏运行态核对、改动仅限节奏/间距/圆角，不动栅格与逻辑。
- [缺多数页面 stitch 稿，验收主观] → 以翻译页为 oracle：「与翻译页同款节奏」即达标；引擎页可与翻译页并排对照。
- [`label-caps` 过度大写伤可读性] → D2 双层定义限定其只用于面板内组标签；页级小节用 Tier H，不大写。
- [内容冻结边界模糊（样式 vs 内容）] → 明确红线：**不新增/不改写任何可见文字**；只改既有元素的 className。
