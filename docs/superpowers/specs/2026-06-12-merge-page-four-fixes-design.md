# 批次 7：合成页四件套设计（真实预览 / 取消 / 软字幕 / 中文字体）

日期：2026-06-12
范围：UX_ANALYSIS_REPORT.md Phase 2 收尾——6.4.3 假预览、6.4.5 合成不可取消、6.4.8 软字幕封装、6.4.4 默认字体 Arial、顺手修 6.4.6 完成状态不复位。
前置发现：P1#14（编辑态隐藏顶层切换器）已在批次 2 顺带完成（`proofread.tsx` `stage !== 'edit'` 条件渲染），本批次不含。

## 背景

合成页（`SubtitleMergePanel`）当前：

- 预览叠加层 `SubtitlePreviewOverlay` 渲染写死的 `sampleText`（`VideoPreview.tsx` L27），不随播放时间变化，不读真实字幕。
- `mergeSubtitleToVideo`（`main/helpers/subtitleMerger.ts`）发起 ffmpeg 后无 command 引用，无法取消；长视频烧录动辄几十分钟。
- 输出只有硬字幕烧录一种；mkv 软字幕封装秒级完成且无损，是高频真实需求。
- 默认样式与「经典白字黑边」预设字体为 Arial——不含中文字形，中文烧录时 libass 回退随机系统字体，预览（CSS 渲染由浏览器字体回退掩盖）与成品双重失真。
- `setVideoPath/setSubtitlePath`（换文件，非清除）不复位 progress，合成完成后换文件进度条仍停 100%。

## Task 1：真实字幕预览

**渲染层（仅改 `VideoPreview.tsx` 与接线）**

- `SubtitleMergePanel` 把 `subtitlePath` 传入 `VideoPreview`。
- `VideoPreview` 内部维护 `entries: PreviewCue[]`（`{ startSec, endSec, text }`）：
  - `subtitlePath` 变化时调用已有 IPC `readSubtitleFile`（返回 `{id, startEndTime, content: string[]}[]`），解析 `startEndTime`（SRT `HH:MM:SS,mmm --> HH:MM:SS,mmm`）为秒，`content.join('\n')` 为 text；清除字幕时置空。
  - 按 `currentTime` 二分查找当前条（复用批次 5 的 candidate 二分模式：找最后一个 `startSec <= t`，再验 `endSec > t`）。
- 叠加层文字优先级：
  1. 有字幕文件且当前时间有条目 → 显示该条真实文本；
  2. 有字幕文件但当前时间无条目 → 不显示叠加层（所见即所得）；
  3. 未选字幕 → 显示样例文字（保留样式调试能力）。

**错误处理**：`readSubtitleFile` 失败返回 `[]`，预览自然退化为「无条目」，不需要额外 UI。

## Task 2：ffmpeg 合成可取消

**主进程（`subtitleMerger.ts` + `ipcSubtitleMergeHandlers.ts`）**

- `subtitleMerger.ts` 模块级保存当前 command 与取消标志：
  - `let currentMergeCommand: ReturnType<typeof ffmpeg> | null`、`let mergeCancelled = false`。
  - `mergeSubtitleToVideo` 在 `.save()` 前注册 command，`end/error` 后清空。
  - 新增 `cancelCurrentMerge(): boolean`：置 `mergeCancelled = true`，`command.kill('SIGKILL')`（同 `audioProcessor.killFfmpegForFiles` 模式）。
  - `error` 回调里若 `mergeCancelled` 为真：清理临时字幕、**删除写了一半的输出文件**、reject `MERGE_CANCELLED` 哨兵错误（不发 error 进度事件，发 `{status:'cancelled'}`）。
- 合成同时只有一个（按钮 processing 时禁用），单例引用足够，无需注册表。
- `ipcSubtitleMergeHandlers.ts`：
  - 新增 `subtitleMerge:cancelMerge` handler → `cancelCurrentMerge()`。
  - `startMerge` 捕获 `MERGE_CANCELLED` → 返回 `{ success: true, cancelled: true }`。

**渲染层（`useSubtitleMerge.ts` + `MergeButton.tsx`）**

- `MergeStatus` 增加 `'cancelled'` 不必要——取消后直接复位 `idle`，toast 提示「已取消合成」。hook 新增 `cancelMerge()` 方法与 `isCancelling` 状态；`startMerge` 收到 `cancelled: true` 时复位 progress 为 idle。
- `MergeButton` processing 状态下渲染「取消」按钮（outline，进度条旁）。

## Task 3：软字幕封装选项

**类型与状态**

- `MergeConfig` 增加 `outputMode?: 'hardcode' | 'softmux'`（缺省 `hardcode`，向后兼容）。
- `useSubtitleMerge` 新增 `outputMode` 状态 + `setOutputMode`；切换到 `softmux` 时输出路径后缀强制改 `.mkv`（重新生成：`generateOutputPath(videoPath, '_subtitled')` 再替换扩展名）；切回 `hardcode` 恢复视频原扩展名。

**主进程（`subtitleMerger.ts`）**

- `mergeSubtitleToVideo` 按 `outputMode` 分支：
  - `hardcode`：现状逻辑不变。
  - `softmux`：`ffmpeg(videoPath).input(subtitlePath)`，outputOptions：`-map 0 -map 1 -c copy -c:s srt -disposition:s:0 default`，输出 `.mkv`。srt/vtt/ass 均可直接作字幕输入（vtt/ass 由 ffmpeg 转码为 srt 字幕流；mkv 原生支持）。秒级完成，进度事件照常发（基本瞬间到 100）。
- 取消逻辑对两种模式一致生效。

**UI（`MergeButton.tsx`）**

- 输出路径上方加「输出方式」二选（RadioGroup 或两个卡片式按钮）：
  - 烧录硬字幕：字幕画进画面，所有播放器可见（重新编码，较慢）
  - 封装软字幕（MKV）：秒级完成、无损画质，播放器可开关字幕
- 选 `softmux` 时左侧样式设置整卡禁用并显示提示「软字幕样式由播放器决定，样式设置仅对烧录生效」（`SubtitleMergePanel` 按 outputMode 传 disabled + 提示行）。

## Task 4：中文默认字体 + 完成状态复位

**字体（`constants.ts` + `BasicStyleSettings.tsx`）**

- 新增 `getDefaultCjkFont()`：按 `navigator.platform`（renderer 环境）返回 mac→`PingFang SC`、win→`Microsoft YaHei`、其他→`Noto Sans CJK SC`。
- `DEFAULT_STYLE.fontName` 与 `classic` 预设改用该函数结果（模块加载时求值）。这些字体含完整拉丁字形，对英文字幕无副作用。
- 风格化预设（movie/youtube/clean/bold_impact）保持原字体——它们是用户主动选择的风格。
- `FONT_LIST` 中文字体项 label 追加「（支持中文）」标注（通过 i18n 或直接 label 拼接；FONT_LIST 是常量，labelKey 方案改动大，直接在 label 上拼中文括号即可，列表本身就是中英混排）。

**完成状态复位（`useSubtitleMerge.ts`）**

- `setVideoPath`/`setSubtitlePath`/`selectVideo`/`selectSubtitle` 成功换文件后，若 `progress.status` 为 `completed`/`error` → 复位为 idle（抽一个 `resetProgressIfFinished()`）。处理中不允许换文件（UI 已禁用）。

## Task 5：i18n + 门禁 + 冒烟

- zh/en `subtitleMerge.json` 补 key：输出方式、两种模式名与描述、样式仅烧录生效提示、取消按钮、已取消 toast、字体标注。
- 门禁：renderer 非测试 TS 错误 0；main 不高于基线 95。
- 逐任务提交（4 个功能 commit）。

## 验收标准

1. 选好视频+字幕后，预览随播放显示真实字幕条目，空档期无字幕；未选字幕时显示样例文字。
2. 烧录进行中可取消：进度复位、无错误弹窗、输出目录无半成品文件。
3. 选「封装软字幕」：输出 .mkv 秒级完成，播放器（IINA/VLC）能看到默认开启的字幕轨；样式区禁用并有提示。
4. 默认与「经典」预设在 mac 上字体为苹方，中文预览与成品不再回退衬线杂字体；英文字幕显示正常。
5. 合成完成后更换视频或字幕文件，完成横幅与进度条消失（回到 idle）。
