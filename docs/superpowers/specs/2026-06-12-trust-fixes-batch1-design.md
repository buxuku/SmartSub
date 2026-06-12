# 信任修复 · 批次 1「任务执行语义重构」设计

> 状态：已评审（2026-06-12 头脑风暴逐节确认）
> 上游依据：`docs/UX_ANALYSIS_REPORT.md` v2 —— Phase 1「信任修复」（v2.17.0）
> 覆盖问题：P0#1（误判已处理）、P0#2（取消/暂停不停）、P0#3（状态/日志跨工程串扰）、4.2.5 局部（取消后误弹完成横幅）

---

## 1. 背景与目标

`taskProcessor.ts` 用模块级全局变量（`processingQueue` / `isProcessing` / `isPaused` / `shouldCancel`）管理所有任务，导致三类信任破产问题：

1. **取消/暂停不作用于执行中文件**：`cancelTask` 只清队列，正在转写/翻译的文件继续跑，spinner 永转；
2. **跨工程串扰**：任务状态与日志是全局单例，A 工程运行时 B 工程页面显示 A 的控制按钮与日志（Updater 日志也混入任务日志面板）；
3. **「全部已处理」误判**：`TaskControls` 用 truthy 检查（`item.extractAudio && item.extractSubtitle`），失败态字符串 `'error'` 同样为真——全部失败的列表点「开始任务」被拒绝执行。

目标：**按钮说什么就做什么**。取消能停、状态归属各自工程、失败列表可重跑。

## 2. 决策记录（脑暴确认）

| 决策点           | 选择                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Phase 1 切分粒度 | 拆 3 个可验证批次，本批 = 任务执行语义重构（P0#1/#2/#3）                                                    |
| 取消语义深度     | 方案 A：JS 层全力中断（kill ffmpeg + 翻译令牌），whisper 转写中文件标「取消中」完成后停；原生 abort 留 2.18 |
| 架构方案         | 方案 1「定向修复」：保留共享队列 + 并发池，队列项打 projectId 标签按工程过滤；不做 TaskRunner 类重构        |
| 多工程并行       | 保留现有「多工程可排队」行为，不做单工程独占                                                                |
| 分支策略         | 继续在 `feat/resource-hub` 上原子提交                                                                       |
| 测试门禁         | 不引入测试框架；`tsc --noEmit` + 人工验收（i18n CI 门禁随 Phase 3 术语批次建设）                            |

## 3. 技术设计

### 3.1 projectId 贯穿执行链

现状：任务页已有 `projectId`（uuid，URL `?project=` 同步），但 `handleTask` 只发 `{files, formData}`。

改造：

- 渲染层 `handleTask` / 重试入口统一携带 `projectId`；
- 队列项结构 `{file, formData}` → `{file, formData, projectId}`；
- 主进程维护 per-project 运行时状态（按 projectId 聚合：queued / active 计数、paused / cancelled 标志），全局并发池（`maxConcurrentTasks`）保留；
- `pauseTask` / `resumeTask` / `cancelTask` / `getTaskStatus` 全部改为携带 projectId 的按工程操作；
- `taskComplete` 事件载荷从字符串改为 `{projectId, status}`，渲染层（TaskControls / 任务页）只消费本工程事件；
- 派发循环跳过 paused / cancelled 工程的队列项；resume 时唤醒派发。

### 3.2 取消信号三层落实

取消某工程时：

1. **队列层**：移除该工程全部排队项（既有行为，保留）；
2. **可中断阶段立即停**：
   - ffmpeg 提取：新增进程注册表（fileUuid → fluent-ffmpeg command），取消时对该工程在跑的提取调用 kill；
   - 翻译：`translate()` 链路透传 `shouldAbort()` 回调，批次边界检查，命中即抛出取消错误终止该文件；
3. **不可中断阶段（whisper 转写）善后**：`whisperAsync` 是原生 addon 调用、无中断信号（已核实）。转写继续完成，**保存已产出的转写结果**（不浪费算力），但 `processFile` 在阶段边界检查取消标记，不再进入后续翻译阶段；该文件行 UI 显示「取消中…完成当前转写后停止」。

暂停语义不变（停止派发新文件，进行中文件继续），但 UI 文案明示这一点（按钮即契约原则）。

阶段状态约定：被取消而未执行的阶段保持 `pending`（不标 error），文件停留在「未完成」态，重新「开始任务」可续跑。

### 3.3 日志按工程隔离（AsyncLocalStorage）

- 主进程引入 `AsyncLocalStorage` 日志上下文：每个文件的处理在 `als.run({projectId}, ...)` 内执行，`logMessage` 自动从上下文取 projectId 打标——无需改动几十个调用点，whisper/ffmpeg/翻译等嵌套调用自动继承；
- `LogEntry` 增加可选 `projectId` 字段；`handleTask` 入口日志显式打标；
- 任务页 `LogPanel`：`getLogs` 支持按 projectId 过滤 + `newLog` 事件按 projectId 过滤，只显示本工程日志（Updater 等系统日志自然消失）；
- 帮助菜单的全局 `LogDialog` 不变，仍显示全量日志（系统日志的正当出口）。

### 3.4 「全部已处理」误判修复

- `TaskControls` 判定改用现成 `stageUtils`（`getFileStages` + `isFileDone`），感知 taskType 与字幕文件输入，error 态不再被算作「已处理」；
- 「开始任务」只派发未完成（`!isFileDone`）的文件——顺带修复「部分失败后重跑会把已成功文件全部重做」的隐藏问题；
- `TaskControls` 新增 `typeDef` prop（任务页已有该值）。

### 3.5 取消后的完成横幅

`taskComplete` 状态为 `cancelled` 时不弹「全部完成」横幅（修报告 4.2.5 的取消误弹一半；多文件横幅语义重构留 P1#24）。

## 4. 改动面

| 层     | 文件                               | 改动                                                    |
| ------ | ---------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| 主进程 | `taskProcessor.ts`                 | per-project 状态、按工程的 IPC 语义、派发过滤、取消分发 |
| 主进程 | `fileProcessor.ts`                 | 阶段边界取消检查、ALS 上下文包裹                        |
| 主进程 | `audioProcessor.ts`                | ffmpeg 进程注册表 + kill                                |
| 主进程 | `translate/index.ts`（及内层循环） | `shouldAbort` 透传与批次边界检查                        |
| 主进程 | `logger.ts` / `store/types.ts`     | ALS 上下文、LogEntry.projectId、getLogs 过滤            |
| 渲染层 | `TaskControls.tsx`                 | stageUtils 判定、typeDef prop、按工程 IPC、取消中状态   |
| 渲染层 | `tasks/[type].tsx`                 | projectId 传递、taskComplete 过滤                       |
| 渲染层 | `LogPanel.tsx`                     | 按 projectId 过滤                                       |
| 渲染层 | `CompletionBanner.tsx`             | cancelled 不弹横幅                                      |
| 渲染层 | `TaskRowList.tsx`（如需）          | 「取消中」行态展示                                      |
| i18n   | `zh                                | en/tasks.json` 等                                       | 取消中、暂停语义说明等新文案，zh/en 同步 |

**明确不动**：中断恢复（TASK_INTERRUPTED）、工程镜像存储（`applyTaskEventToProjects`）、whisper addon、持久化结构、IPC 协议其余部分。

## 5. 错误处理与边界

- 取消导致的翻译中止不计为该阶段 error（与用户主动意图一致），阶段回退/保持 pending；
- ffmpeg 被 kill 后 `extractAudio` 的 reject 按取消路径处理（不发 error 事件、不弹错误通知）；
- 渲染层发起取消后按钮立即进入「取消中」禁用态，等待主进程 `taskComplete({status:'cancelled'})` 收尾确认；
- 旧版渲染层兼容：`getTaskStatus` 无 projectId 参数时回退全局语义（防止遗漏调用点导致崩溃）；
- 多工程排队时，单工程取消/完成不影响其它工程的派发与状态。

## 6. 验收清单（人工验证）

1. 全部失败的列表点「开始任务」能重跑，不再提示「已处理」；且不重做已完成文件；
2. 运行中点「取消」：队列清空；提取/翻译阶段数秒内真停；转写中文件显示「取消中」并在转写完成后不再翻译；
3. A 工程运行时打开 B 工程：B 页面是「开始任务」按钮而非 A 的暂停/取消；B 日志面板无 A 日志、无 Updater 日志；B 发起取消不影响 A；
4. 暂停后不再派发新文件，恢复继续；暂停控件附近有语义说明；
5. 取消后不弹「全部完成」横幅。

自检门禁：`npx tsc --noEmit` 通过 + `npm run dev` 冷启动跑通一次完整任务。

## 7. 后续批次（Phase 1 剩余，已与用户确认切分）

- **批次 2 · 校对与合成安全**：P0#4 合成页清除联动 bug、P0#5 保存前快照（撤销盲区最小修复）、P0#6 未保存拦截 + .bak 备份、P0#7 暗色失败行、P1#13 合成提示矛盾 + 输出路径默认值；
- **批次 3 · 平台与交互兼容**：P0#8 File.path → webUtils 迁移、P0#9 ProvidersTab 选中 bug、P0#10 macOS 关窗保活 + Dock 进度、P1#22 统一危险操作确认（useConfirmOrUndo）、P1#23 保存反馈降噪。

每批次：实现 → 自检 → 用户验收 → 进入下一批。Phase 2（编辑器专业化）/ Phase 3（品牌一致性）按报告第 11 章节奏，开工前另做该期详细设计。

## 8. 非目标（本批次不做）

- whisper 原生中断（addon 改造，2.18 跟进项）；
- TaskRunner 类化重构；
- 单工程独占运行模式；
- CompletionBanner 多文件语义重构（P1#24）；
- 任务行元信息/ETA（P1#36）；
- 测试框架引入与 i18n CI 门禁。
