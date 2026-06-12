# 批次 7 实施计划：合成页四件套

设计文档：`docs/superpowers/specs/2026-06-12-merge-page-four-fixes-design.md`
门禁基线：renderer 非测试 TS 错误 0；main 95。每任务完成后跑门禁并独立提交。

## Task 1：真实字幕预览

1. `SubtitleMergePanel.tsx`：向 `VideoPreview` 传 `subtitlePath`。
2. `VideoPreview.tsx`：
   - props 加 `subtitlePath: string | null`。
   - `useEffect([subtitlePath])`：调 `window.ipc.invoke('readSubtitleFile', { filePath })`，把 `{startEndTime, content}[]` 解析为 `{startSec, endSec, text}[]`（SRT 时间 `HH:MM:SS,mmm` 解析函数本地实现）；失败/清除置 `[]`。
   - 二分查找当前条（candidate 模式）；按设计的三级优先级决定叠加层文字（真实条/无/样例）。
3. 提交：`feat(merge): real subtitle preview following playback time`

## Task 2：ffmpeg 合成可取消

1. `main/helpers/subtitleMerger.ts`：
   - 模块级 `currentMergeCommand` / `mergeCancelled`；`mergeSubtitleToVideo` 注册/清理。
   - 导出 `cancelCurrentMerge()`：置标志 + `kill('SIGKILL')`。
   - `.on('error')`：若 `mergeCancelled` → 清理 tmp 字幕 + 删除半成品输出文件 + reject `new Error('MERGE_CANCELLED')`，进度发 `{status:'idle', percent:0}` 不发 error。
2. `ipcSubtitleMergeHandlers.ts`：
   - 新增 `subtitleMerge:cancelMerge` handler。
   - `startMerge` catch 里识别 `MERGE_CANCELLED` → `{ success: true, cancelled: true }`。
3. `useSubtitleMerge.ts`：`cancelMerge` 方法 + `isCancelling` 状态；`startMerge` 处理 `cancelled` 分支（复位 idle，toast）。
4. `MergeButton.tsx`：processing 时显示「取消」按钮。
5. 提交：`feat(merge): cancellable ffmpeg burn with partial output cleanup`

## Task 3：软字幕封装

1. `types/subtitleMerge.ts`：`MergeConfig.outputMode?: 'hardcode' | 'softmux'`。
2. `subtitleMerger.ts`：`mergeSubtitleToVideo` softmux 分支（`-map 0 -map 1:0? `→ 实际 `.input(subtitlePath)` + `['-map','0','-map','1','-c','copy','-c:s','srt','-disposition:s:0','default','-y']`）。
3. `useSubtitleMerge.ts`：`outputMode` 状态 + `setOutputMode`（切换时改输出扩展名 .mkv ↔ 原扩展名）；`startMerge` 传 outputMode。
4. `MergeButton.tsx`：输出方式选择 UI（两个可点卡片/RadioGroup）。
5. `SubtitleMergePanel.tsx`：outputMode=softmux 时样式区禁用 + 提示行。
6. 提交：`feat(merge): soft subtitle mkv muxing as alternative to hardcode burn`

## Task 4：中文默认字体 + 完成状态复位

1. `constants.ts`：`getDefaultCjkFont()` 平台判断；`DEFAULT_STYLE` 与 classic 预设用之；`FONT_LIST` 中文字体加标注。
2. `useSubtitleMerge.ts`：`resetProgressIfFinished()`，在 `setVideoPath/setSubtitlePath/selectVideo/selectSubtitle` 成功后调用。
3. 提交：`fix(merge): platform CJK default font and stale completion state reset`

## Task 5：i18n + 门禁 + 交接

1. zh/en `subtitleMerge.json` 补 key（outputMode/cancel/toast/样式提示/字体标注）。
2. 门禁：renderer 0 非测试错误；main ≤95。
3. interactive_feedback 验收交接。
