# log-viewer

## ADDED Requirements

### Requirement: 全局日志弹窗默认展示最新日志

LogDialog SHALL 在打开时默认加载并展示当天最新 100 条日志，按时间升序排列并自动滚动到底部；MUST NOT 一次性加载全部历史日志。

#### Scenario: 打开日志弹窗

- **WHEN** 用户打开全局日志弹窗
- **THEN** 弹窗展示当天最新 100 条日志，视口自动位于列表底部

### Requirement: 条数切换

LogDialog SHALL 提供 50 / 100 / 200 条的条数切换控件，切换后按当前日期与类型过滤条件重新查询。

#### Scenario: 切换为 50 条

- **WHEN** 用户将条数切换为 50
- **THEN** 列表重新加载，仅展示符合当前过滤条件的最新 50 条

### Requirement: 按日查看

LogDialog SHALL 提供日期选择控件，选项来自 `getLogDates` 返回的可用日期（默认今天）；选择历史日期后展示该日符合当前条数与类型过滤的日志。

#### Scenario: 查看历史日期

- **WHEN** 用户选择一个历史日期
- **THEN** 列表展示该日期尾部 N 条（N 为当前条数设置）符合类型过滤的日志

#### Scenario: 无历史日志

- **WHEN** logs 目录中只有当天一个文件
- **THEN** 日期选择控件仅提供"今天"一个选项

### Requirement: 类型过滤

LogDialog SHALL 提供日志类型过滤控件（全部 / 仅错误 / 仅警告），切换后重新查询。

#### Scenario: 仅看错误

- **WHEN** 用户选择"仅错误"
- **THEN** 列表仅展示 error 类型的日志

### Requirement: 实时追加

LogDialog SHALL 在查看"今天"时将 `newLog` 推送的日志实时追加到列表尾部并滚动到底部；新日志 MUST 匹配当前类型过滤才追加。查看历史日期时 MUST NOT 追加实时日志。

#### Scenario: 查看今天时收到新日志

- **WHEN** 用户正在查看今天的日志（类型过滤为"全部"）且主进程产生一条新日志
- **THEN** 该日志追加到列表尾部，视口滚动到底部

#### Scenario: 类型过滤下收到不匹配的新日志

- **WHEN** 用户过滤为"仅错误"且收到一条 info 类型的新日志
- **THEN** 列表不变

#### Scenario: 查看历史日期时收到新日志

- **WHEN** 用户正在查看历史日期且主进程产生一条新日志
- **THEN** 列表不变

### Requirement: 复制与清空

LogDialog SHALL 保留"复制日志"（复制当前列表内容）与"清空日志"（清空全部日志）功能。

#### Scenario: 清空全部日志

- **WHEN** 用户点击清空按钮
- **THEN** 全部日志文件被删除，列表清空

### Requirement: 任务页日志面板按工程展示

LogPanel SHALL 使用 `getLogs({ projectId, limit: 200 })` 加载当前工程最新 200 条日志，实时追加仅接受匹配 projectId 的推送；清空按钮仅清除该工程的日志。

#### Scenario: 打开任务页日志面板

- **WHEN** 用户展开某工程的日志面板
- **THEN** 面板展示该工程最新 200 条日志

#### Scenario: 按工程清空

- **WHEN** 用户点击面板的清空按钮
- **THEN** 仅该工程的日志被清除，其他工程与系统日志保留
