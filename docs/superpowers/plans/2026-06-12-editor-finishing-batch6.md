# 编辑器专业化 · 批次 6「编辑器功能补全」实施计划

> 设计：`docs/superpowers/specs/2026-06-12-editor-finishing-batch6-design.md`
> 门禁同批次 1-5：main tsc 对比基线无新增；渲染层非测试错误 0；路由冒烟 200。

## Task 1: 时间轴行内编辑

- `useStandaloneSubtitles.ts`：新增 `handleTimeChange(index, startSec, endSec)`，邻行钳制校验 + 单行 RangeCommand + isDirty；导出。
- 新 `renderer/components/subtitle/TimeRangeEditor.tsx`：展示态/编辑态切换、SRT 时间解析与格式化、Enter/Esc/失焦、错误文案展示。
- `SubtitleList.tsx`：SubtitleRow 展开态接入 TimeRangeEditor（透传 onTimeChange）；`ProofreadEditor.tsx` 接线。
- i18n：zh/en `home.json` 新增 timeEdit 相关 key。
- Commit: `feat(editor): inline time range editing with neighbor-clamped validation and undo`

## Task 2: 主进程取消注册表 + 批量 AI 可取消

- `ipcProofreadHandlers.ts`：模块级 `Map<string, AbortController>`、`cancelProofreadBatch` IPC、`batchOptimizeSubtitles` 接受 batchId + 每批边界检查 + 返回 cancelled/部分结果，finally 清理。
- `BatchAiOptimizeDialog.tsx`：batchId 生成、running 取消按钮、关弹窗先取消、review 标注「已取消」、删除 isPaused 死代码。
- i18n：zh/en 取消相关 key。
- Commit: `feat(editor): cancellable batch AI optimization with partial results`

## Task 3: 重翻失败 IPC

- `ipcProofreadHandlers.ts`：新 `retranslateSubtitles` handler（默认服务商校验、translateWithProvider、retranslateProgress 事件、Abort 检查、部分结果返回），复用 Task 2 注册表。
- Commit: `feat(proofread): retranslate-failed IPC reusing task translation pipeline with cancel`

## Task 4: 失败集中处理 UI

- `SubtitleList.tsx`：失败栏升级（只看失败开关 + 进度快照 + 重翻按钮/进度/取消）；虚拟器数据源支持失败索引映射。
- `ProofreadEditor.tsx` / hook：重翻调用、进度监听、`id+startEndTime` 匹配回填走 updateSubtitles。
- i18n：zh/en 失败工作流 key。
- Commit: `feat(editor): failed-subtitles workflow with filter, progress and batch retranslate`

## Task 5: 门禁 + 冒烟 + 交接

- 双门禁、路由冒烟 200、interactive_feedback 验收清单。
