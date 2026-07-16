# Tasks: optimize-log-storage

## 1. 主进程日志存储模块

- [x] 1.1 新建 `main/helpers/logStorage.ts`：实现 `appendLog`（promise 链串行化追加写入 `{userData}/logs/YYYY-MM-DD.jsonl`）、`queryLogs({ date?, limit?, types?, projectId? })`（逐行解析、坏行跳过、尾部取 N 条升序返回，默认当天 100 条）、`listLogDates`、`clearLogs(projectId?)`、`cleanupOldLogs`（删 7 天前文件）
- [x] 1.2 改造 `main/helpers/logger.ts`：`logMessage()` 改为调用 `appendLog`，保留 `newLog` IPC 推送，不再读写 store
- [x] 1.3 应用启动时调用 `cleanupOldLogs()`，并检测/删除 store 中遗留的 `logs` 键

## 2. IPC 与 store schema

- [x] 2.1 改造 `main/helpers/ipcStoreHandlers.ts`：`getLogs` 改为接收 query 对象并调用 `queryLogs`；`clearLogs` 改为文件操作；`addLog` 改走 `appendLog`；新增 `getLogDates` 处理器
- [x] 2.2 从 `main/helpers/store/types.ts` 与 `main/helpers/store/index.ts` 移除 `logs` 键定义与默认值（`LogEntry` 类型保留并被 logStorage 引用）
- [x] 2.3 全局搜索确认无其他代码直接读写 `store.get('logs')` / `store.set('logs', ...)`

## 3. 渲染进程 UI

- [x] 3.1 改造 `renderer/components/LogDialog.tsx`：新增日期选择（数据来自 `getLogDates`，默认今天）、条数切换（50/100/200，默认 100）、类型过滤（全部/仅错误/仅警告）；控件变化重新查询；实时追加仅在查看今天且匹配类型过滤时生效；保留复制与清空
- [x] 3.2 改造 `renderer/components/tasks/LogPanel.tsx`：改用 `getLogs({ projectId, limit: 200 })`，实时追加与按工程清空逻辑保持
- [x] 3.3 新增 i18n 文案：`renderer/public/locales/{zh,en}/common.json`（日期/条数/类型过滤相关），必要时补充 `tasks.json`

## 4. 验证

- [x] 4.1 类型检查通过：本次改动的 8 个文件无 tsc/lint 错误（仓库存在与本次改动无关的历史 tsc 错误）；`check:i18n` 通过；`logStorage` 模块 9 项独立行为测试全部通过（追加/序列化/默认查询/类型过滤/工程过滤/坏行跳过/按日查询/过期清理/清空）
- [x] 4.2 已在运行中的 dev 应用内经 CDP 自动化验证：`.jsonl` 按日生成、`getLogs` 默认/limit/types/projectId 查询、`getLogDates`、`newLog` 实时推送；LogDialog 默认「今天 / 最新 100 条 / 全部类型」、切 50 条、切「仅错误」（匹配的实时日志追加、不匹配的不追加）、按日切换（历史日期不追加实时日志）、按工程清空（其他日志保留）均通过并截图确认
- [x] 4.3 旧版本升级验证：真实 `config.json` 含 447 条历史日志（154KB），启动后 `logs` 键被删除（文件缩至 69KB），`settings` 等其余配置无损
