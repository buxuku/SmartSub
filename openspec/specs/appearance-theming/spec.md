# appearance-theming Specification

## Purpose

TBD - created by archiving change redesign-precision-slate-ui. Update Purpose after archive.

## Requirements

### Requirement: 默认色彩模式与切换

应用 SHALL 默认以深色模式启动，并 MUST 保留用户在深/浅色之间切换的能力，且 MUST 持久化用户的显式选择。

#### Scenario: 首次启动呈现深色

- **WHEN** 用户从未设置过主题、首次启动应用
- **THEN** 界面以 Precision Slate 深色模式呈现

#### Scenario: 浅色选择被记忆

- **WHEN** 用户切换到浅色并重启应用
- **THEN** 应用以浅色模式启动（沿用上次显式选择）

#### Scenario: 切换可逆

- **WHEN** 用户点击主题切换控件
- **THEN** 界面在深色与浅色之间即时切换，无需重载页面

### Requirement: 单一 Editing-Blue 强调色

系统 SHALL 以单一「Editing Blue」(`#00A3FF` 区间) 作为主强调色（`--primary` 及 `--ring` 同源），统一用于主 CTA、选中态、聚焦态与链接；indigo MUST NOT 再作为全局主色。

#### Scenario: 主操作按钮使用强调色

- **WHEN** 渲染任一主操作按钮（如「开始」「下载」「测试」）
- **THEN** 该按钮以 Editing Blue 实心填充，且前景文字与之达到 WCAG AA 对比度

#### Scenario: 聚焦与选中使用同一强调色源

- **WHEN** 元素获得键盘聚焦，或列表项/导航项处于选中态
- **THEN** 其聚焦环/选中标识使用 Editing Blue（与 `--primary` 同源）

#### Scenario: 强调色作为前景达标

- **WHEN** 以 Editing Blue 作为文字/图标前景落于深色背景
- **THEN** 对比度 ≥ 4.5:1（正文）或 ≥ 3:1（大字/图标）

### Requirement: Precision Slate 深色调色板

深色模式 SHALL 采用三层中性面体系（画布 `#131313` → 面板 `#1b1b1c`/`#202020` → 浮层/高起 `#2a2a2a`），并 MUST 以 1px 描边（`#333` 区间）分隔高密度面板；元素聚焦时描边 MUST 转为强调色。

#### Scenario: 三层表面区分

- **WHEN** 同屏出现画布、卡片/面板、弹层三类容器
- **THEN** 三者背景明度依次递增、彼此可分辨

#### Scenario: 面板描边

- **WHEN** 渲染卡片或分区面板
- **THEN** 其边界为 1px `--border` 描边，而非依赖投影

### Requirement: Precision Slate 浅色调色板

浅色模式 SHALL 基于与深色相同的语义 token 推导一套校准过的浅色配色，使浅色同样精致一致；浅色主色 MUST 加深至与白色前景达到 AA 的蓝（`#0077CC` 区间）。

#### Scenario: 浅色主按钮可读

- **WHEN** 在浅色模式渲染主操作按钮
- **THEN** 主色为加深蓝 + 白色文字，对比度 ≥ 4.5:1

#### Scenario: 语义一致

- **WHEN** 同一组件分别在深/浅色下渲染
- **THEN** 其语义角色（背景/卡片/描边/前景/主色）一一对应、视觉层级一致

### Requirement: 字体与排版系统（零打包）

系统 SHALL 仅使用系统字体栈，MUST NOT 内嵌任何三方字体文件。正文使用 `system-ui` sans 栈；技术字段 MUST 使用系统等宽栈；面板/分区标题 SHALL 提供 `label-caps` 样式（小号、加粗、字距、大写）。

#### Scenario: 不增打包体积

- **WHEN** 构建产物完成
- **THEN** 不包含新增的字体资源文件（woff/woff2/ttf）

#### Scenario: 技术字段等宽对齐

- **WHEN** 渲染时间码、文件/模型路径、文件尺寸、API Key/Base URL、版本号
- **THEN** 这些字段以等宽（或 `tabular-nums`）呈现，数值纵向对齐、刷新不跳动

#### Scenario: 分区标题样式

- **WHEN** 渲染面板或分区的标题（如「引擎列表」「免费层」）
- **THEN** 以 `label-caps`（大写 + 字距 + 加粗小号）呈现，区别于可编辑正文

### Requirement: 形状与密度

UI SHALL 采用收紧的圆角（控件约 4px、容器约 8px）与紧凑间距；侧边栏激活项 MUST 以左侧主色竖条 + 半透明主色填充表达激活态。

#### Scenario: 收紧圆角

- **WHEN** 渲染按钮/输入等控件与卡片/面板等容器
- **THEN** 控件圆角小于容器圆角，整体呈克制硬朗的工具观感

#### Scenario: 侧栏激活态

- **WHEN** 某导航项为当前页
- **THEN** 该项显示左侧主色竖条并以半透明主色填充背景

### Requirement: 蓝色声波品牌标识

应用 SHALL 以「蓝色声波」符号作为主品牌标识，并 MUST 同步替换应用内侧边栏标识与打包桌面图标（macOS/Windows）。

#### Scenario: 应用内标识替换

- **WHEN** 渲染侧边栏品牌区
- **THEN** 显示新的蓝色声波标识

#### Scenario: 打包图标替换

- **WHEN** 构建桌面安装包
- **THEN** macOS（`.icns`）与 Windows（`.ico`）应用图标均为新的蓝色声波标识

### Requirement: 集中式 token 驱动全局外观

外观 SHALL 通过集中的语义 token（CSS 变量 + tailwind 配置）驱动，使全局组件自动继承主题；启动台功能卡片 MAY 作为唯一例外保留差异化彩色。

#### Scenario: token 级联

- **WHEN** 修改主题 token（背景/卡片/描边/主色等）
- **THEN** 使用语义 token 的全局组件外观随之更新，无需逐个改组件

#### Scenario: 启动台彩色例外

- **WHEN** 渲染首页启动台的功能卡片
- **THEN** 各卡片保留其差异化强调色，同时与新的中性底/圆角/描边语言对齐
