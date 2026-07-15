# Tasks: pipeline-gates

## 1. 类型与闸门字段（零行为变化）

- [x] 1.1 `types/types.ts`：`IFormData.gates?: { subtitle?: 'manual'|'auto'; dubbing?: 'manual'|'auto' }`；`IFiles.subtitleGate?/dubbingGate?: ''|'review'|'passed'`（注释注明 review 不参与中断标记、跨重启保留）
- [x] 1.2 `workItemMigration.derivePipelineWorkItemStatus`：感知 review——存在待校对文件且无执行中/错误时状态为进行中间态；`workItemUtils`/启动台状态点映射「待校对」展示（i18n）

## 2. 主进程：停靠、放行与通知

- [x] 2.1 `taskProcessor.ts`：导出 `enqueueProjectFiles(projectId, files, formData)` 主进程内部派发入口（progressWindow 合成事件 sender，复用 wrapTaskEvent/队列/并发/预热路径）
- [x] 2.2 新增 `pipeline/gateManager.ts`：到闸通知聚合节流（任务×闸门 5s 合并，点击聚焦窗口）；`notifyProjectDone`/`finalizeProjectIfDrained` 感知 review（排空但有停靠 → 「等待校对」文案）
- [x] 2.3 `fileProcessor.ts` 两个检查点：字幕段成功后 `gates.subtitle==='manual' && subtitleGate!=='passed'` → 置 review + 通知 + 结束本轮；配音成功后同理（`dubbingGate`）；放行重派发的续跑路径闸门检查幂等（passed 直接穿过）
- [x] 2.4 dubbingGate 放行后的音轨重建：`resume.dubbingDone` 跳过批量但**总是**经 `buildDubTrack` 按会话当前行状态重建配音轨（吸收工作台修改），产物字段刷新
- [x] 2.5 新增 IPC `pipeline:releaseGate { projectId, gate, fileUuids? }`：校验 review→passed（并发保护）、落库、按 `configSnapshot` 经 enqueueProjectFiles 续跑；返回派发数；批量语义与单文件一致
- [x] 2.6 取消/删除语义：取消不触碰 review 文件；删除任务联动清理（既有会话清理已覆盖，补 review 状态无残留验证）

## 3. 任务详情闸门 UX

- [x] 3.1 `stageUtils.ts`：检查点推导（按快照 gates 在阶段间插入 GateDef）、状态取值（pending/review/passed）；`isFileTerminal/isFileDone` 对停靠文件的判定（停靠=非终态非完成，横幅不误报）
- [x] 3.2 `TaskRowList`/`TaskGridList`：菱形检查点渲染（三态视觉）+ 行级动作——字幕点「校对/放行」、配音点「检查配音/放行」（仅 review 时显示）
- [x] 3.3 任务页聚合操作条：按检查点统计待校对数，「逐个校对」「全部放行（确认对话框）」；`pipeline:releaseGate` 接线与实时刷新
- [x] 3.4 校对检查员包壳：内嵌 ProofreadEditor 外壳叠加「放行并继续下一个」（放行 → 自动载入下一个待校文件，尽头回任务列表）；i18n zh/en

## 4. 配音工作台检查员模式

- [x] 4.1 `dubbing.tsx`/`DubbingPanel`：识别 `?gateProject=&gateFile=` 上下文；`useDubbing` 检查员状态（待检清单实时拉取 workItem 计算）
- [x] 4.2 检查员上下文条：任务名/序号、上一个/下一个（切换会话）、「放行并继续」（releaseGate → 切下一个或返回任务详情）、「全部放行」（确认对话框）；检查员模式隐藏导出入口
- [x] 4.3 i18n zh/en（dubbing.json）

## 5. 向导人工把关开关

- [x] 5.1 TaskWizard：勾选配音或成品视频时显示「人工把关」区（字幕校对默认开、配音确认仅配音时显示默认关、代价说明文案）；gates 入 formData 快照
- [x] 5.2 i18n zh/en（tasks.json wizard.\*）+ `check:i18n` 通过

## 6. 验证与冒烟

- [x] 6.1 单测：gateLogic 纯函数 15 项（停靠判定/auto 与未配置零变化/放行过滤与幂等/计数），test:pipeline 共 38 项全过；test:dubbing 151 / test:compose 31 回归全过
- [x] 6.2 静态：tsc（main/renderer 改动文件 0 错误）、prettier、check:i18n、yarn build 完整构建通过
- [x] 6.3 真机冒烟·字幕校对：批量任务到闸通知与聚合操作条；校对修改 2 行 → 放行 → 配音按新文本重配、成片字幕一致；「放行并继续下一个」流式审片
- [x] 6.4 真机冒烟·配音确认：检查配音跳工作台、重生成一行、放行并继续 → 成片含新配音；全部放行；最后一个放行返回任务
- [x] 6.5 真机冒烟·边界：停靠时重启应用状态保留、取消不清停靠、全自动开关关闭后无停靠、无 gates 旧任务零变化

> 2026-07-15 用户真机冒烟通过（含修复「检查配音」纯会话打开空页问题：仅凭 session id 恢复 + 会话缺失明确指引）后确认归档。
