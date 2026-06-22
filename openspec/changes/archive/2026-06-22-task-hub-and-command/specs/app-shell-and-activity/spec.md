## ADDED Requirements

### Requirement: 上下文顶栏去品牌冗余

内容区顶栏 SHALL 重构为「上下文工具条」：MUST NOT 再展示与侧栏重复的应用品牌名；其左侧 SHALL 承载页面上下文（枢纽页为页名、子工作面为「返回 + 当前名称」），右侧 SHALL 承载状态簇与命令入口。

#### Scenario: 顶栏不再重复品牌名

- **WHEN** 在任一页面渲染顶栏
- **THEN** 顶栏不出现与侧栏 logo 同义的应用品牌名块，中段不再是大片空白

#### Scenario: 子工作面显示返回与上下文

- **WHEN** 进入子工作面（如 `tasks/[type]` 或校对编辑态）
- **THEN** 顶栏左侧呈现返回入口与当前工作面名称，可一键回到上层

### Requirement: 顶栏状态簇与活动按钮

顶栏右侧 SHALL 提供一个状态簇，至少包含加速(accel) chip 与「活动」按钮；点击活动按钮 SHALL 打开一个锚定于该按钮的 popover（而非整页或右侧 sheet）。

#### Scenario: 打开活动面板

- **WHEN** 用户点击顶栏「活动」按钮
- **THEN** 在按钮下方弹出 popover 形式的活动面板，再次点击或失焦关闭

#### Scenario: accel 常驻可达

- **WHEN** 加速环境可用（存在 active backend）
- **THEN** accel chip 常驻于顶栏状态簇，点击直达「引擎与模型」的加速区

### Requirement: 活动中枢汇聚实时状态

活动面板 SHALL 在一处汇聚以下实时状态：当前正在进行的任务（含进度，单运行器下至多一个）、进行中的模型下载、以及最近完成 / 失败项；每个条目 SHALL 提供与其语义相符的跳转（查看任务 / 看日志 / 打开结果）。系统 MUST NOT 因此引入并发任务队列调度。

#### Scenario: 展示运行中的任务

- **WHEN** 存在一个正在运行的任务（`getTaskStatus` 为 `running`）
- **THEN** 活动面板「正在进行」区展示该任务及其进度，并提供查看入口

#### Scenario: 展示模型下载

- **WHEN** 收到 `modelDownloadDetail` 的 downloading/extracting 推送
- **THEN** 活动面板「下载」区展示该模型的进度

#### Scenario: 展示最近完成与失败

- **WHEN** 任务完成（`taskComplete`）或失败
- **THEN** 活动面板「最近」区列出该项，完成项可打开结果、失败项可跳转日志

#### Scenario: 全量历史另归档案页

- **WHEN** 用户需要查看全部历史任务
- **THEN** 活动面板提供「查看全部」入口跳转 `/recent-tasks`，活动面板自身只呈现实时与最近少量

### Requirement: 版本与更新提示落点

应用版本号与「有新版本」提示 SHALL 落在活动面板页脚作为应用状态呈现；当检测到可用更新时，顶栏活动按钮 SHALL 以一个视觉提示点（dot/badge）标示，使更新提示无需展开面板即可被察觉。

#### Scenario: 版本展示于面板页脚

- **WHEN** 打开活动面板
- **THEN** 面板页脚展示当前版本号

#### Scenario: 有更新时按钮提示

- **WHEN** `update-status` 为 `available`
- **THEN** 顶栏活动按钮出现更新提示点，展开面板页脚可见「有新版本 vX」并可进入更新流程

### Requirement: 页面标题层级去重

系统 SHALL 消除页级标题与其下首个分区标题的同名回声；枢纽页 `PageHeader` SHALL 保留（承载描述与页级操作），仅当某分区标题与页级标题完全同名重复时 MUST 去除该回声。系统 MUST NOT 为此改动 `page-layout-rhythm` 既定的标题两层写法。

#### Scenario: 去除同名回声

- **WHEN** 渲染「翻译服务」页，其页级标题与首个分区标题同为「翻译服务」
- **THEN** 不再重复呈现同名标题（保留页级标题，去除分区回声）

#### Scenario: 枢纽页头保留

- **WHEN** 渲染任一枢纽页
- **THEN** 其 `PageHeader`（标题 + 描述 + 页级操作）保留，未被顶栏上下文整体替代

### Requirement: 活动中枢仅只读消费既有信号

活动中枢、状态簇与顶栏上下文 MUST 仅消费既有 IPC 事件与查询（`getTaskStatus`、`taskComplete`、`modelDownloadDetail`、`update-status`、加速状态等），MUST NOT 改变任何业务数据、引擎 / 翻译 / 任务 / 校对的功能行为或后端语义。

#### Scenario: 行为零回归

- **WHEN** 上下文顶栏与活动中枢落地后执行任务 / 下载 / 更新检查
- **THEN** 这些功能的行为与改造前完全一致，仅其状态的呈现方式改变
