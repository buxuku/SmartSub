# 信任修复 · 批次 2「校对与合成安全」设计

> 上游：`docs/UX_ANALYSIS_REPORT.md` Phase 1；批次切分见 `2026-06-12-trust-fixes-batch1-design.md` §7。
> 范围：P0#4、P0#5、P0#6、P0#7、P1#13。批次 1（任务执行语义）已完成并验收。

## 1. 背景与目标

校对编辑器与合成页存在数据安全与状态欺骗问题：改完不切行保存则永久无法撤销（P0#5）；退出/标记完成不提示未保存、保存直接覆盖原文件无备份（P0#6）；合成页点视频 X 连字幕一起清空（P0#4）；暗色模式失败行白底刺眼（P0#7）；合成按钮禁用提示与实际缺失项矛盾（P1#13）。

目标：编辑不丢、覆盖有备份、清除不连坐、提示说真话、暗色不刺眼。

## 2. 决策记录（已与用户确认）

| 决策点           | 结论                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| .bak 策略        | 滚动单份：每次保存前把现有目标文件复制为 `<file>.bak`，覆盖上一份；不堆积                  |
| 未保存对话框     | AlertDialog 三选：保存并返回 / 不保存返回 / 继续编辑（取消）                               |
| 标记完成语义     | 隐含保存：先 await 保存，成功才标记完成返回；失败 toast 并留在编辑器                       |
| 撤销盲区修复深度 | 最小修复（保存前 flush 快照入历史）；命令模式重构属 Phase 2 不做                           |
| 清除按钮连带     | clearVideo / clearSubtitle 各自独立；清除同时重置进度状态（顺带修「换文件进度条停 100%」） |
| 输出路径默认值   | 选视频即生成（移出 getVideoInfo 成功分支），仍走 `subtitleMerge:generateOutputPath` IPC    |

## 3. 技术设计

### 3.1 P0#5 撤销盲区（renderer/hooks/useStandaloneSubtitles.ts）

现状：`handleSubtitleChange` 首次击键存 `editSnapshot`，仅在 `currentSubtitleIndex` 变化的 effect（L408-425）里提交进历史。不切行直接保存 → 快照从未入栈。

修复：抽 `flushPendingEdit()`：

```ts
const flushPendingEdit = useCallback(() => {
  if (editSnapshot) {
    const hasChanged =
      JSON.stringify(editSnapshot) !== JSON.stringify(mergedSubtitles);
    if (hasChanged) pushToHistory(editSnapshot, mergedSubtitles);
    setEditSnapshot(null);
  }
}, [editSnapshot, mergedSubtitles, pushToHistory]);
```

- `handleSave` 开头调用 `flushPendingEdit()`；
- 切行 effect 改为复用同一函数（行为不变）。

### 3.2 P0#6 未保存保护 + .bak（hook + ProofreadEditor + 主进程）

**isDirty 追踪（hook）**：

- `const [isDirty, setIsDirty] = useState(false)`；
- 置脏：`handleSubtitleChange`、`updateSubtitles`、`handleUndo`、`handleRedo`（merge/split/AI 优化都走 `updateSubtitles`，自动覆盖）；
- 清脏：`loadFiles` 完成时、`handleSave` 全部写入成功后；
- 导出 `isDirty`、`flushPendingEdit`；`handleSave` 返回 `Promise<boolean>`（成功 true，任一写入失败 false），现有调用方不受影响（此前无人消费返回值）。

**ProofreadEditor 守卫**：

- 「返回列表」：`isDirty` 时弹 AlertDialog（ui/alert-dialog 已有）：
  - 保存并返回：`await handleSave()` 成功 → `onBack()`；失败 toast 留下；
  - 不保存返回：直接 `onBack()`；
  - 继续编辑：关对话框。
- 「标记完成」：`await handleSave()` 成功 → `onMarkComplete()`；失败 toast 留下（无论 dirty 与否都先保存——保证完成态文件与界面一致）。

**.bak 备份（main/helpers/ipcHandlers.ts `saveSubtitleFile`）**：

写入前：

```ts
try {
  if (fs.existsSync(filePath)) {
    await fs.promises.copyFile(filePath, `${filePath}.bak`);
  }
} catch (backupError) {
  logMessage(`备份字幕文件失败（继续保存）: ${backupError.message}`, 'warning');
}
```

备份失败不阻断保存；`.bak` 滚动覆盖。

### 3.3 P0#4 清除联动（useSubtitleMerge.ts + SubtitleMergePanel.tsx）

hook 新增（保留 `clearFiles` 兼容）：

- `clearVideo()`：清 videoPath/videoInfo/outputPath（输出路径派生自视频），进度重置 idle；
- `clearSubtitle()`：清 subtitlePath/subtitleInfo，进度重置 idle。

面板改绑：`onClearVideo={clearVideo}`、`onClearSubtitle={clearSubtitle}`。

### 3.4 P0#7 暗色失败行（SubtitleList.tsx）

- 行容器：`bg-red-50 hover:bg-red-100 border-red-200` → 追加 `dark:bg-red-950/30 dark:hover:bg-red-900/40 dark:border-red-900`；`ring-red-300` → 追加 `dark:ring-red-900`；
- 翻译输入框：`border-red-300 focus:border-red-500` → 追加 `dark:border-red-800 dark:focus:border-red-400`。

### 3.5 P1#13 动态提示 + 输出路径默认值（useSubtitleMerge.ts + MergeButton.tsx + 面板）

- `loadVideoInfo`：把 `generateOutputPath` 调用移出 `if (result.success)`——只要有视频路径就生成默认输出路径；
- `MergeButton` 新增 props `videoPath`、`subtitlePath`，提示逻辑：
  - 缺视频+字幕 → 现有 `selectFilesToMerge`；
  - 只缺视频 → `selectVideoToMerge`（请选择视频文件）；
  - 只缺字幕 → `selectSubtitleToMerge`（请选择字幕文件）；
  - 文件齐只缺输出路径 → `selectOutputPathToMerge`（请选择输出路径）；
- i18n：`subtitleMerge.json` zh/en 增 3 个 key。

## 4. 错误处理

- 保存任一文件失败：`handleSave` 返回 false，toast 错误，dirty 保持，不返回/不标记完成；
- .bak 复制失败：warning 日志，不阻断保存；
- 守卫对话框「保存并返回」失败：留在编辑器，对话框关闭，toast 可见。

## 5. 验收清单（人工）

1. 改一行字幕**不切行**直接点保存 → 点撤销能回到改前内容；
2. 改动后点「返回列表」弹三选对话框；「不保存返回」再进来内容未变；「保存并返回」内容已存且生成 `.bak`；
3. 「标记完成」后打开文件，内容与编辑器一致（隐含保存生效）；
4. 合成页点视频卡 X：只清视频（字幕保留）；点字幕卡 X：只清字幕；合成完成后换文件，进度不再停留 100%；
5. 暗色模式下失败行为暗红底色，不再白底刺眼；
6. 合成页只缺输出路径时提示「请选择输出路径」；选视频后输出路径自动有默认值（视频同目录 `_subtitled`）。

## 6. 非目标

- 历史栈命令模式重构、列表虚拟化、快捷键（Phase 2）；
- 合成真实预览、合成取消、软字幕封装（Phase 2/backlog）；
- 校对页顶层切换器隐藏（P1#14，批次外）；
- 「校对中」状态误导（6.3.12，批次外）。
