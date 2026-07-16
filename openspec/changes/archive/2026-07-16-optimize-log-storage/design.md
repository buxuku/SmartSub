# Design: optimize-log-storage

## Context

日志链路现状：

- 写入：`main/helpers/logger.ts` 的 `logMessage()` 读出 electron-store 中整个 `logs` 数组，追加一条后 `store.set('logs', [...])` 整体重写 `config.json`；同时经 `newLog` IPC 推送给所有窗口
- 存储：`config.json`（与应用设置同文件）中的单个 `LogEntry[]`，`LogEntry = { message, type, timestamp, projectId? }`，无上限、无自动清理
- 查询：`ipcStoreHandlers.ts` 的 `getLogs`（全量返回，可选按 projectId 过滤）、`clearLogs`、`addLog`（渲染进程写日志）
- 展示：`LogDialog.tsx`（全局弹窗，全量 map 渲染）、`LogPanel.tsx`（任务页，按 projectId 过滤）

问题：每条日志 O(n) 重写整个配置文件（累计 O(n²) 写放大）、日志膨胀拖慢所有 store 操作并有崩溃风险、UI 全量渲染无法快速定位最新日志。

已确认的产品决策：保留 7 天；LogPanel 按工程过滤保留；旧日志不迁移直接丢弃；增加按类型（error/warning）过滤。

## Goals / Non-Goals

**Goals:**

- 日志写入为 O(1) 追加，不再触碰 `config.json`
- 自动保留 7 天，无需用户手动维护
- 查询参数化：最新 N 条（50/100/200）、按日、按类型、按工程
- LogDialog / LogPanel 改用新查询接口，默认只加载最新一批
- 升级后一次性清除 `config.json` 中遗留的 `logs` 键

**Non-Goals:**

- 不迁移历史日志
- 不引入 electron-log / SQLite 等新依赖
- 不做虚拟列表（单次最多渲染几百条，无必要）
- 不做日志全文搜索、导出文件（保留现有"复制"即可）

## Decisions

### D1: 按日 JSONL 文件存储

日志存放在 `{userData}/logs/YYYY-MM-DD.jsonl`（本地时区日期），每行一个 `JSON.stringify(LogEntry)`。

- 为什么不继续用 electron-store：写放大是崩溃根因，必须离开 `config.json`
- 为什么不用 electron-log：其输出是文本行格式，按 type/projectId 结构化过滤反而要自己写解析；且引入新依赖只为文件轮转不划算
- 为什么不用 SQLite：数据量（7 天运行日志）和查询复杂度都用不上，成本过高
- JSONL 的天然优势："按日查看" = 读一个文件；"保留 7 天" = 删旧文件；`JSON.stringify` 自动转义换行，多行消息安全

### D2: 新增 `main/helpers/logStorage.ts` 模块，串行化写入

对外暴露：

- `appendLog(entry: LogEntry): void` —— 追加一行到当天文件。内部用 promise 链串行化 `fs.appendFile`，保证顺序且不阻塞主进程
- `queryLogs(query): Promise<LogEntry[]>`，`query = { date?: string; limit?: number; types?: LogType[]; projectId?: string }` —— 读目标文件（默认当天），逐行 parse（坏行跳过），按条件过滤后取尾部 `limit` 条（默认 100），按时间升序返回
- `listLogDates(): Promise<string[]>` —— 列出 logs 目录下的可用日期，降序
- `clearLogs(projectId?): Promise<void>` —— 无参删除全部文件；带 projectId 则逐文件重写过滤
- `cleanupOldLogs(): Promise<void>` —— 删除文件名日期早于 7 天前的文件，应用启动时调用

`logger.ts` 的 `logMessage()` 改为调用 `appendLog` + 原样 `newLog` 推送；`ipcStoreHandlers.ts` 的 `addLog` 处理器同样走 `appendLog`。

### D3: IPC 接口

- `getLogs(query)`：参数从 `projectId?: string` 变为上述 query 对象（**BREAKING**，内部接口，两处调用方同步修改）
- `getLogDates()`：新增，返回可用日期列表
- `clearLogs(projectId?)`：签名不变，实现改为文件操作
- `newLog` 推送：完全不变，实时性由推送保证，文件只负责持久化和历史查询

### D4: UI 行为

**LogDialog（全局弹窗）**：

- 顶部控件：日期选择（来自 `getLogDates()`，默认今天）、条数切换（50/100/200，默认 100）、类型过滤（全部/仅错误/仅警告）
- 任一控件变化即重新 `getLogs`；历史日期同样受条数与类型过滤约束（取该日尾部 N 条）
- 实时追加：仅当查看"今天"且新日志匹配当前类型过滤时，将 `newLog` 推送追加到列表尾部并自动滚底
- 清空按钮 → `clearLogs()`（全部）

**LogPanel（任务页）**：

- `getLogs({ projectId, limit: 200 })`，实时追加逻辑不变（按 projectId 过滤推送）
- 清空按钮 → `clearLogs(projectId)`
- 不加日期/类型控件（面板空间有限，全局弹窗承担完整查询能力）

### D5: 旧数据清除

应用启动时（`cleanupOldLogs` 同一时机）检测 store 中是否存在 `logs` 键，存在则 `store.delete('logs')` 一次性清除；`store/types.ts` 与 `store/index.ts` 移除 `logs` 定义与默认值。不做任何迁移。

## Risks / Trade-offs

- [跨零点写入] 长任务运行中跨日，日志自然落到新文件 → 无需处理；UI 实时推送不受影响，仅历史查询按日归属
- [并发写乱序] 多处同时 `appendLog` → promise 链串行化保证单进程内顺序
- [坏行/半行]（崩溃时可能写入半行）→ 逐行 parse 失败即跳过，不影响其余日志
- [按工程清空需重写文件] 频率低（用户手动触发），文件小（单日日志），可接受
- [丢弃旧日志] 升级后用户历史日志消失 → 已确认可接受（运行日志非用户数据）

## Open Questions

（无——关键决策已在探索阶段与用户确认）
