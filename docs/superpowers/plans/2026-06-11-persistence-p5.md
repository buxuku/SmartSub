# P5 任务持久化 + 工序衔接实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 任务列表跨重启保留（中断任务可一键重跑）、完成横幅接通「合成到视频」、合成页支持预填、任务全完成时系统通知。

**上游设计:** 蓝图 §6。

## 代码事实

- `main/helpers/taskManager.ts`：`taskList` 纯内存，重启即失；renderer 每次 files 变化都 `setTasks` 全量同步 → 落库只需 main 侧写穿 electron-store（带防抖，进度事件很频繁）。
- 阶段状态键：`extractAudio/extractSubtitle/translateSubtitle/prepareSubtitle`，值 `'loading'|'done'|'error'`；中断恢复=启动时把 `'loading'` 改写为 `'error'` + `${key}Error='TASK_INTERRUPTED'` 哨兵，renderer 翻译哨兵并复用现成重试按钮。
- `StoreType` 有 `[key:string]: any`，显式补 `tasks?: IFiles[]`。
- `useSubtitleMerge` 已支持 `initialVideoPath/initialSubtitlePath` 入参（`SubtitleMergePanelProps extends UseSubtitleMergeOptions`），但初始路径不触发 `loadVideoInfo/loadSubtitleInfo` → 补一个 mount effect。
- 完成通知：`processNextTasks` completed 分支；`BrowserWindow.fromWebContents(event.sender)` 判焦点，`settings.language` 选 zh/en 文案。
- 蓝图 6.4「校对编辑器路由化/校对历史并入 WorkItem」**本期不做**：校对模块已有独立历史任务体系（`proofreadTasks`），P3 任务页已复用同一编辑器组件，并入属大改，留 P6 评估（feedback 时向用户说明）。

## Task 1: main 落库 + 中断标记 + 完成通知

**Files:**

- Modify: `main/helpers/taskManager.ts`（启动加载+sanitize、setTasks 防抖写穿、clearTasks 即写、before-quit flush）
- Modify: `main/helpers/store/types.ts`（`tasks?: IFiles[]`）
- Modify: `main/helpers/taskProcessor.ts`（completed 且窗口未聚焦 → Notification，zh/en 按 settings.language）

**Verify:** tsc 非测试 0 错误。

## Task 2: renderer 中断文案 + 横幅合成衔接 + 合成页预填

**Files:**

- Modify: `renderer/public/locales/{zh,en}/tasks.json`（`interrupted`、`completion.goMerge`）
- Modify: `renderer/components/tasks/TaskRowList.tsx`（错误行哨兵翻译）
- Modify: `renderer/components/tasks/CompletionBanner.tsx`（media 任务 + 有产物字幕 → [合成到视频] 带参跳转）
- Modify: `renderer/pages/[locale]/subtitleMerge.tsx`（router.query.video/subtitle → initial 入参，isReady 门控）
- Modify: `renderer/components/subtitleMerge/hooks/useSubtitleMerge.ts`（初始路径 mount 加载 info）

**Verify:** tsc + yarn build。

## Task 3: 终验

- 两个原子提交；interactive_feedback 冒烟（重启保留/中断重跑/横幅合成跳转预填/通知）。
