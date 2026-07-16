# Proposal: optimize-log-storage

## Why

当前全局日志全部存放在 electron-store 的 `config.json` 中的单个 `logs` 数组里，每写一条日志都要整体重写整个配置文件（O(n²) 写放大），且无条数上限、无自动清理。长期使用后日志无限膨胀，导致：查看最新日志需要滑动很久、`getLogs` 全量过 IPC + 全量渲染 DOM 造成卡顿甚至 app 崩溃、`config.json` 被日志污染拖慢所有 store 操作。

## What Changes

- 日志存储从 electron-store 迁移到按日切分的 JSONL 文件（`{userData}/logs/YYYY-MM-DD.jsonl`），追加写入，消除写放大
- 日志自动保留 7 天，启动时清理过期文件
- `getLogs` IPC 改为参数化查询：支持按日期、最新 N 条（50/100/200）、projectId、日志类型（info/error/warning）过滤，不再全量返回
- 日志查看 UI（LogDialog）增加：最新 N 条切换、按日查看、类型过滤
- 任务页 LogPanel 保留按工程（projectId）过滤能力，改用新查询接口
- 升级时清除 `config.json` 中遗留的 `logs` 键，不迁移旧日志
- **BREAKING**（内部）：`getLogs` / `clearLogs` IPC 签名变更；`store` schema 移除 `logs` 键

## Capabilities

### New Capabilities

- `log-storage`: 主进程日志的按日 JSONL 文件存储、7 天保留策略、参数化查询与清理，以及旧 electron-store 日志的一次性清除
- `log-viewer`: 渲染进程日志查看体验——默认最新 N 条、按日切换、类型过滤、按工程过滤、实时追加、复制与清空

### Modified Capabilities

（无——现有 specs 均不涉及日志行为）

## Impact

- 主进程：`main/helpers/logger.ts`（写入路径重写）、`main/helpers/ipcStoreHandlers.ts`（`addLog`/`getLogs`/`clearLogs` 处理器）、`main/helpers/store/types.ts` 与 `store/index.ts`（移除 `logs` 键）、新增日志存储模块
- 渲染进程：`renderer/components/LogDialog.tsx`（全局日志弹窗）、`renderer/components/tasks/LogPanel.tsx`（任务页日志面板）
- IPC 通道：`getLogs`、`clearLogs` 签名变更；`newLog` 推送保持不变；`addLog` 同步改造
- i18n：`renderer/public/locales/{zh,en}/common.json`、`tasks.json` 新增文案
- 无新增第三方依赖
