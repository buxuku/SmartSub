# command-palette Specification

## Purpose

TBD - created by archiving change task-hub-and-command. Update Purpose after archive.

## Requirements

### Requirement: 全局命令面板唤起

系统 SHALL 提供一个全局命令面板，经 `mod+k`（Cmd/Ctrl+K）在任意页面唤起，并 SHALL 复用仓库既有的 `cmdk` 基元（`ui/command.tsx`）实现；面板 MUST 支持键盘上下选择与回车执行、Esc 关闭。

#### Scenario: 任意页唤起

- **WHEN** 用户在任意页面按下 `mod+k`
- **THEN** 命令面板以对话框形式打开，输入框自动聚焦

#### Scenario: 键盘驱动执行

- **WHEN** 面板打开后用户用方向键选中某条目并回车
- **THEN** 执行该条目对应的跳转或动作，并关闭面板

### Requirement: 跳转条目

命令面板 SHALL 提供跳转到各主导航页（`NAV_ITEMS` 六项）与「最近任务」(`/recent-tasks`) 的条目，可经输入模糊筛选。

#### Scenario: 跳转到导航页

- **WHEN** 用户在面板中筛选并选择「设置」
- **THEN** 路由跳转到设置页并关闭面板

### Requirement: 最近工程条目

命令面板 SHALL 列出最近工程（`getWorkItems`），选择某项 SHALL 经 `getWorkItemTarget` 直达其对应工作面 / deep-link。

#### Scenario: 打开最近工程

- **WHEN** 用户在面板「最近」分组选择某工程
- **THEN** 直达该工程对应的任务 / 校对工作面（带其上下文）

#### Scenario: 无最近工程时不空挂

- **WHEN** 当前没有任何最近工程
- **THEN** 面板不显示空的「最近」分组（或以无匹配占位呈现），不出现裸露空块

### Requirement: 全局动作条目

命令面板 SHALL 提供复用既有 handler 的全局动作（如新建转写 / 翻译 / 转写+翻译任务、切换深 / 浅色、检查更新、查看日志、打开引导、FAQ、GitHub、展开 / 折叠侧栏）。v1 MUST NOT 纳入破坏性动作（如删除工程），且 MUST NOT 新增后端能力。

#### Scenario: 执行全局动作

- **WHEN** 用户在面板选择「切换主题」
- **THEN** 触发既有主题切换逻辑，效果与从侧栏 `ThemeToggle` 操作一致

#### Scenario: 不含破坏性动作

- **WHEN** 浏览 v1 命令面板的动作列表
- **THEN** 其中不包含删除工程等破坏性操作

### Requirement: 键盘可发现性

新增的命令面板与导航快捷键 SHALL 登记进现有 `ShortcutsHelpDialog`；新增键位 MUST 保守、低冲突，并沿用既有 `useHotkeys` 的输入态语义（`allowInInput`），不破坏既有 `mod+,` 与 `?` 快捷键。

#### Scenario: 速查可见

- **WHEN** 用户打开快捷键速查（`?`）
- **THEN** 其中列出 `mod+k` 命令面板与新增的「跳转」导航快捷键

#### Scenario: 不冲突既有热键

- **WHEN** 新增导航快捷键后再次使用 `mod+,`（设置）与 `?`（速查）
- **THEN** 两者行为不变
