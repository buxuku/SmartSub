# 编辑器专业化 · 批次 5「列表重构 + 命令模式撤销」设计

> 来源：UX_ANALYSIS_REPORT §6.3.5（密度+性能）、§9.3 线框、§8 Phase 2、§11 v2.18.0 beta.2。
> 用户决策：紧凑行单击即「选中+展开+视频跳转」；引入 @tanstack/react-virtual。

## 现状病灶

- `SubtitleList.tsx`：每行常驻 1-2 个全宽 textarea，一屏约 3 条；全量 `.map()` 渲染、无 memo——每敲一字全列表重渲染。
- `useStandaloneSubtitles.ts`：撤销历史为整数组 JSON 深拷贝快照，2000 条时每个撤销点全量复制。
- `useVideoPlayer.ts`：播放联动每个进度 tick 线性 `findIndex` 扫全表。

## 设计

### 1. 行模型：紧凑 + 当前行展开

- 非当前行 = 紧凑单行：`⚠ #41 0:12→0:15 原文预览 / 译文预览`，单行截断，一屏 ≥10 条。
- 当前行（`currentSubtitleIndex`）自动展开为编辑态：时间头 + 原文/译文 textarea + AI 优化/拆分按钮。
- 单击紧凑行 → `handleSubtitleClick(index)`（选中 + 展开 + 视频跳转，沿用现有联动）。
- 编辑必须先成为当前行（密度提升的前提，已获用户确认）。
- 失败行降噪：左缘 2px 红条 + 行头 ⚠ + 红点；不再整行红底红框。失败导航栏保留。
- Tab/Shift+Tab 同行原译切换（批次 4 已做）仅作用于展开行，自然兼容。

### 2. 虚拟化

- `@tanstack/react-virtual` `useVirtualizer`，`measureElement` 动态行高（紧凑 ~32px、展开 ~160px 初估）。
- 自动滚动：`virtualizer.scrollToIndex(currentSubtitleIndex, { align: 'auto' })` 替代 `scrollIntoView`；保留「用户主动点击跳过一次自动滚动」逻辑。
- 行组件 `React.memo`，props 收敛为原始值/稳定引用（行数据、isCurrent、isFailed、回调）。

### 3. 命令模式撤销（外部 API 不变）

统一命令 = 连续区间 diff：

```ts
interface RangeCommand {
  start: number; // 区间起点
  removed: Subtitle[]; // undo 时回填
  inserted: Subtitle[]; // redo 时回填
}
```

- 单行编辑：`{start: i, removed: [旧行], inserted: [新行]}`；同行同字段 500ms 内连续输入合并（只更新 inserted）。
- 合并行：2 removed / 1 inserted；拆分行：1 removed / 2 inserted。
- 工具栏批量操作（搜索替换/时间偏移/批量 AI）走 `updateSubtitles(newArr)`：计算公共前缀/后缀，取最小连续区间 diff 入栈。
- undo = `splice(start, inserted.length, ...removed)`；redo = `splice(start, removed.length, ...inserted)`。
- 栈上限 200 条，超出丢最旧；redo 栈在新命令入栈时清空。
- 对外导出保持不变：`handleUndo/handleRedo/canUndo/canRedo/handleSubtitleChange/updateSubtitles`，工具栏与快捷键零改动。
- `isDirty`/`flushPendingEdit`（批次 2 安全网）语义保留：flush = 把未入栈的合并窗口立即提交为命令。

### 4. 播放联动二分索引

- 字幕按 startTimeInSeconds 有序（解析、合并、拆分均保序）。
- 二分查找最后一个 `startTime <= currentTime` 的行，再验证 `endTime > currentTime`；替换线性 findIndex。

## 错误处理

- 命令应用前做边界钳制（start/长度越界则丢弃该命令并清栈，防御数据漂移）。
- 虚拟器在行数为 0 时不渲染；展开行高度变化触发 remeasure。

## 验收（报告 Phase 2 标准）

一屏 ≥10 条；2000 条滚动流畅、输入无可感延迟；任意编辑（含合并/拆分/批量替换）可撤销重做；搜索替换/时间偏移/AI 优化/快捷键全部不回归。
