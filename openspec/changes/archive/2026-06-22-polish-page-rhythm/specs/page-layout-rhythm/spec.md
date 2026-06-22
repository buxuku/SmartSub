## ADDED Requirements

### Requirement: 页面节奏契约基线

系统 SHALL 定义一套跨页面统一的「页面节奏」契约（页头、分区小标题、主从详情头、圆角刻度、卡片/面板框、纵向间距），并以经打磨的「翻译服务」页（`ProvidersTab`）作为基准样板；所有枢纽页与工作面 MUST 与该契约对齐。

#### Scenario: 翻译页作为基准

- **WHEN** 评审任一页面的节奏是否达标
- **THEN** 以「翻译服务」页同款节奏（详情头量级/分区标签/卡片框/间距）为验收基线

#### Scenario: 枢纽页一致性

- **WHEN** 逐一查看启动台、最近任务、引擎与模型、翻译服务、设置各枢纽页
- **THEN** 其页头、分区标题、圆角、纵向节奏遵循同一契约，无明显写法漂移

### Requirement: 分区标题双层规范

分区标题 SHALL 收敛为两层：面板/列内的**组标签**MUST 使用 `label-caps`（小号、加粗、字距、大写）；`PageHeader` 之下的**页级小节标题**SHALL 使用统一的 `text-sm font-semibold` 写法。系统 MUST NOT 为统一样式而新增任何标题文字。

#### Scenario: 面板内组标签

- **WHEN** 渲染面板或列内已存在的组标签（如翻译页「免费层/AI/MT」「推荐」）
- **THEN** 以 `label-caps` 呈现

#### Scenario: 页级小节标题

- **WHEN** 渲染页头之下已存在的页级小节标题（如启动台「最近任务」）
- **THEN** 以统一的 `text-sm font-semibold` 呈现，且不被改写为大写组标签

#### Scenario: 不新增标题

- **WHEN** 某区域当前没有标题文字（如引擎页左栏列表无「引擎列表」标签）
- **THEN** 不为对齐样板而新增该标题（保持内容冻结）

### Requirement: 主从详情头一致

主从（master-detail）布局的右栏详情头 SHALL 以明显强于正文的标题（`text-lg` 起，可在大断点放大）呈现，并 MUST 以底部 1px 分隔（`border-b`）与下方内容区分区。

#### Scenario: 引擎页详情头对齐

- **WHEN** 在「引擎与模型」页选中某引擎、渲染右栏详情头
- **THEN** 标题量级不低于 `text-lg` 且其下有 `border-b` 分隔，与翻译页详情头节奏一致

#### Scenario: 详情头与内容分区

- **WHEN** 详情头下方紧接运行时面板或表单
- **THEN** 二者之间存在清晰的分隔，标题不与内容糊在一起

### Requirement: 圆角刻度一致

UI SHALL 采用统一圆角刻度：容器/卡片/面板 `rounded-lg`、控件 `rounded-md`；除刻意的大圆角场景外，MUST NOT 残留偏离刻度的 `rounded-xl`。

#### Scenario: 修正越界圆角

- **WHEN** 渲染列表占位、提示框等容器（如最近任务页 no-match 占位）
- **THEN** 其圆角为 `rounded-lg`，与全局容器圆角一致

### Requirement: 纵向节奏刻度一致

页面 SHALL 采用统一的纵向间距刻度：枢纽页区块间距以 `space-y-6` 为基线、段内 `space-y-3`/`space-y-4`；阅读型页面（启动台/最近任务）MAY 保留居中阅读宽度与略大页边，但区块间距 MUST 与基线对齐。

#### Scenario: 枢纽页区块节奏

- **WHEN** 渲染任一枢纽页的纵向区块
- **THEN** 区块间距遵循 `space-y-6` 基线，不出现 `space-y-8` 等越界值

#### Scenario: 阅读型页面差异有界

- **WHEN** 渲染启动台/最近任务等阅读型页面
- **THEN** 其可保留 `max-w-4xl` 与较大页边，但区块间距仍与基线一致

### Requirement: 卡片与面板框一致

卡片、运行时面板与主从列表项 SHALL 共享同一框语言：1px `border` + `bg-card`、`rounded-lg`、无 `shadow-sm`；选中态以半透明主色填充 + `ring-1 ring-inset ring-primary/20` 表达。

#### Scenario: 列表项选中态一致

- **WHEN** 在引擎页与翻译页分别选中某列表项
- **THEN** 两页选中态使用一致的主色填充 + 内嵌主色描边

#### Scenario: 面板成形

- **WHEN** 渲染卡片/分区面板
- **THEN** 其边界由 1px 描边定义而非投影，相邻面板靠描边/分隔成形

### Requirement: 结构性对齐不改内容

本能力的所有对齐 MUST 仅为结构/样式（className）层面；系统 MUST NOT 改变任何可见文案、数据、功能、IPC 或页面信息架构。

#### Scenario: 仅样式变更

- **WHEN** 对任一页面执行节奏对齐
- **THEN** 仅调整 className（字号/分隔/圆角/间距/描边），页面文字、控件行为与数据流不变

#### Scenario: 功能回归为零

- **WHEN** 对齐完成后操作该页（选择/输入/下载/测试等）
- **THEN** 行为与对齐前完全一致

### Requirement: 高密度工作面遵循契约

任务工作台（`tasks/[type]`）与字幕校对编辑器（`proofread`）SHALL 在内容冻结前提下，使其自定义头部、工具条与分区遵循页面节奏契约；因密度最高，对齐 MUST 经逐屏运行态核对，且不得挤压既有栅格或改变交互。

#### Scenario: 工作面头部对齐

- **WHEN** 进入任务工作台或校对编辑器
- **THEN** 其上下文标题/工具条的层级与间距遵循契约，与枢纽页观感连贯

#### Scenario: 密度安全

- **WHEN** 在工作面对齐节奏后渲染长列表/多面板
- **THEN** 布局不溢出、不挤压，原有栅格与交互保持稳定
