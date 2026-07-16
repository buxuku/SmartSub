# log-storage

## ADDED Requirements

### Requirement: 日志按日追加写入 JSONL 文件

系统 SHALL 将每条日志以单行 JSON 的形式追加写入 `{userData}/logs/YYYY-MM-DD.jsonl`（按本地时区日期命名），且写入 MUST 为追加操作，不得重写既有内容或写入 `config.json`。并发写入 MUST 保持先后顺序。

#### Scenario: 写入一条日志

- **WHEN** 主进程调用 `logMessage()` 或渲染进程经 `addLog` IPC 提交一条日志
- **THEN** 该日志被序列化为一行 JSON 追加到当天的 `.jsonl` 文件末尾，且 `config.json` 内容不变

#### Scenario: 消息包含换行符

- **WHEN** 写入一条 message 中包含换行符的日志
- **THEN** 换行符被 JSON 转义，文件中仍为单行，后续逐行解析不受影响

#### Scenario: 跨零点写入

- **WHEN** 应用运行跨过本地时区零点后产生新日志
- **THEN** 新日志写入新日期命名的文件

### Requirement: 日志自动保留 7 天

系统 SHALL 在应用启动时删除文件名日期早于 7 天前的日志文件。

#### Scenario: 启动清理过期日志

- **WHEN** 应用启动且 logs 目录存在 8 天前的日志文件
- **THEN** 该文件被删除，7 天内的文件保留

### Requirement: 参数化日志查询

系统 SHALL 通过 `getLogs` IPC 提供参数化查询，支持按日期（默认当天）、最新 N 条（默认 100）、日志类型、projectId 过滤，返回按时间升序排列的结果；MUST NOT 无条件返回全部历史日志。系统 SHALL 通过 `getLogDates` IPC 返回可查询的日期列表（降序）。

#### Scenario: 默认查询

- **WHEN** 渲染进程调用 `getLogs({})`
- **THEN** 返回当天最新 100 条日志，按时间升序

#### Scenario: 按条数与类型查询

- **WHEN** 调用 `getLogs({ limit: 50, types: ['error'] })`
- **THEN** 返回当天最新 50 条 error 类型日志

#### Scenario: 按日期查询

- **WHEN** 调用 `getLogs({ date: '2026-07-10', limit: 200 })`
- **THEN** 返回该日期文件尾部 200 条（不足则全部）符合条件的日志

#### Scenario: 按工程查询

- **WHEN** 调用 `getLogs({ projectId: 'abc', limit: 200 })`
- **THEN** 仅返回 `projectId === 'abc'` 的日志

#### Scenario: 文件中存在损坏行

- **WHEN** 查询的日志文件中包含无法解析为 JSON 的行
- **THEN** 该行被跳过，其余日志正常返回

### Requirement: 日志清空

系统 SHALL 支持经 `clearLogs` IPC 清空日志：不带参数时删除全部日志文件；带 projectId 时仅移除该工程的日志条目，其余日志保留。

#### Scenario: 全局清空

- **WHEN** 调用 `clearLogs()`
- **THEN** logs 目录下全部日志文件被删除

#### Scenario: 按工程清空

- **WHEN** 调用 `clearLogs('abc')`
- **THEN** 所有文件中 `projectId === 'abc'` 的条目被移除，其他条目保留

### Requirement: 遗留 store 日志一次性清除

系统 SHALL 在应用启动时检测 electron-store 中的 `logs` 键，若存在则删除该键；不做数据迁移。store schema SHALL 不再包含 `logs` 定义。

#### Scenario: 从旧版本升级

- **WHEN** 用户从旧版本升级后首次启动，`config.json` 中存在 `logs` 数组
- **THEN** 该键被删除，`config.json` 体积恢复正常，应用设置不受影响

### Requirement: 实时日志推送保持不变

系统 SHALL 在每条新日志产生时继续通过 `newLog` IPC 事件向所有窗口推送该条日志（含 projectId 字段，若有）。

#### Scenario: 新日志推送

- **WHEN** 主进程写入一条新日志
- **THEN** 所有打开的窗口收到 `newLog` 事件，负载为该条 LogEntry
