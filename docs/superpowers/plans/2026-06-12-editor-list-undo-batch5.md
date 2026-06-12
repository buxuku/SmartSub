# 编辑器专业化 · 批次 5「列表重构 + 命令模式撤销」实施计划

> 设计：`docs/superpowers/specs/2026-06-12-editor-list-undo-batch5-design.md`
> 门禁同批次 1-4：主进程 tsc 对比基线无新增；渲染层非测试错误 0；六路由冒烟 200。

## Task 1: 依赖

- `yarn add @tanstack/react-virtual`
- Commit: `chore(deps): add @tanstack/react-virtual for subtitle list virtualization`

## Task 2: 命令模式撤销（useStandaloneSubtitles 内部重构，外部 API 不变）

- 新 `renderer/hooks/useSubtitleHistory.ts`：RangeCommand 栈（push/undo/redo/coalesce/上限 200/越界防御）
- `useStandaloneSubtitles.ts`：移除 history/historyIndex 快照栈；handleSubtitleChange 走合并窗口；updateSubtitles 计算前缀/后缀最小区间 diff；flushPendingEdit 提交合并窗口；undo/redo 应用 splice
- Commit: `refactor(editor): command-pattern undo with range diffs replacing whole-array snapshots`

## Task 3: SubtitleList 虚拟化重构

- 重写 `SubtitleList.tsx`：useVirtualizer + measureElement 动态行高；行组件 `SubtitleRow`（memo）紧凑/展开两态；失败行左缘红条+⚠ 降噪；scrollToIndex 自动滚动（保留点击跳过逻辑）；Tab 路由与 id 锚点保留
- Commit: `feat(editor): virtualized compact subtitle list with expanded current-row editing`

## Task 4: 播放联动二分索引

- `useVideoPlayer.ts`：线性 findIndex → 二分查找
- Commit: `perf(editor): binary search for playback subtitle index`

## Task 5: 门禁 + 冒烟 + 交接

- 双门禁、六路由 200、interactive_feedback 验收清单
