# 信任修复 · 批次 2「校对与合成安全」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 校对编辑不丢（保存前快照入历史 + 未保存拦截 + .bak 备份）、合成页清除不连坐、禁用提示说真话、暗色失败行不刺眼。

**上游设计：** `docs/superpowers/specs/2026-06-12-trust-fixes-batch2-design.md`

**验证门禁（每个 Task 末尾执行，沿用批次 1 修正版）：**

```bash
# 主进程门禁：对比基线 /tmp/tsc-baseline-mainonly.txt，必须无新增（输出为空）
npx tsc --noEmit 2>/dev/null | grep "error TS" | grep -v "^docs/" | grep -v "^renderer/" | grep -v "__tests__" | sort > /tmp/tsc-now-main.txt; comm -13 /tmp/tsc-baseline-mainonly.txt /tmp/tsc-now-main.txt

# 渲染层门禁：非测试文件错误必须为 0（输出为空）
npx tsc --noEmit -p renderer/tsconfig.json 2>/dev/null | grep "error TS" | grep -v "__tests__"
```

---

## Task 1: hook 安全网（flushPendingEdit + isDirty + handleSave 返回值）

**Files:**

- Modify: `renderer/hooks/useStandaloneSubtitles.ts`

- [ ] **Step 1.1: 状态区加 isDirty**

`const [editSnapshot, setEditSnapshot] = useState<Subtitle[] | null>(null);` 之后加：

```ts
// 自上次保存以来是否有未保存修改
const [isDirty, setIsDirty] = useState(false);
```

- [ ] **Step 1.2: loadFiles 完成清脏**

`loadFiles` 内 `setMergedSubtitles(merged);` 之后加 `setIsDirty(false);`（与载入新内容同步复位）。

- [ ] **Step 1.3: handleSubtitleChange 置脏**

`setMergedSubtitles(newSubtitles);` 之后加 `setIsDirty(true);`。

- [ ] **Step 1.4: 抽 flushPendingEdit（放在 pushToHistory 定义之后）**

```ts
// 把"未提交的逐字编辑"补入历史：保存/切行前调用，消除撤销盲区
const flushPendingEdit = useCallback(() => {
  if (!editSnapshot) return;
  const hasChanged =
    JSON.stringify(editSnapshot) !== JSON.stringify(mergedSubtitles);
  if (hasChanged) {
    pushToHistory(editSnapshot, mergedSubtitles);
  }
  setEditSnapshot(null);
}, [editSnapshot, mergedSubtitles, pushToHistory]);
```

- [ ] **Step 1.5: 切行 effect 复用 flushPendingEdit**

L408-425 的失焦记录 effect 改为：

```ts
useEffect(() => {
  if (
    previousSubtitleIndex !== -1 &&
    previousSubtitleIndex !== currentSubtitleIndex
  ) {
    flushPendingEdit();
  }
  setPreviousSubtitleIndex(currentSubtitleIndex);
}, [currentSubtitleIndex, flushPendingEdit]);
```

- [ ] **Step 1.6: updateSubtitles / handleUndo / handleRedo 置脏**

`updateSubtitles` 的 `setMergedSubtitles(newSubtitles);` 后加 `setIsDirty(true);`；`handleUndo`、`handleRedo` 各自 `setEditSnapshot(null);` 后加 `setIsDirty(true);`。

- [ ] **Step 1.7: handleSave 重写（flush + 结果检查 + 返回 boolean + 清脏）**

```ts
// 保存字幕文件；返回是否全部写入成功
const handleSave = async (): Promise<boolean> => {
  flushPendingEdit();
  try {
    const results: { error?: string }[] = [];
    if (config.sourceSubtitlePath) {
      results.push(
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.sourceSubtitlePath,
          subtitles: mergedSubtitles,
          contentType: 'source',
        }),
      );
    }
    if (config.targetSubtitlePath && shouldShowTranslation) {
      results.push(
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.targetSubtitlePath,
          subtitles: mergedSubtitles,
          contentType: 'onlyTranslate',
        }),
      );
    }
    if (config.finalTargetSubtitlePath && shouldShowTranslation) {
      const contentType = config.translateContent || 'onlyTranslate';
      results.push(
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.finalTargetSubtitlePath,
          subtitles: mergedSubtitles,
          contentType,
        }),
      );
    }
    const failed = results.find((r) => r && r.error);
    if (failed) {
      console.error('Error saving subtitles:', failed.error);
      toast.error(t('saveFailed') || '保存失败');
      return false;
    }
    setIsDirty(false);
    toast.success(t('subtitleSavedSuccess') || '字幕保存成功');
    return true;
  } catch (error) {
    console.error('Error saving subtitles:', error);
    toast.error(t('saveFailed') || '保存失败');
    return false;
  }
};
```

注意：保存语义与原版一致（同样的三段写入、同样的 toast 文案），新增的是 flush、结果检查与返回值。

- [ ] **Step 1.8: 导出 isDirty / flushPendingEdit**

return 对象 `handleSave,` 之后加：

```ts
    isDirty,
    flushPendingEdit,
```

- [ ] **Step 1.9: 门禁（两条输出为空）→ Commit**

```bash
git add renderer/hooks/useStandaloneSubtitles.ts
git commit -m "fix(proofread): flush pending edits into undo history and track dirty state"
```

---

## Task 2: 主进程 .bak 备份

**Files:**

- Modify: `main/helpers/ipcHandlers.ts`（saveSubtitleFile L252 起）

- [ ] **Step 2.1: 写入前滚动备份**

`await fs.promises.writeFile(filePath, content, 'utf-8');` 之前插入：

```ts
// 覆盖前滚动备份一份 .bak（失败不阻断保存）
try {
  if (fs.existsSync(filePath)) {
    await fs.promises.copyFile(filePath, `${filePath}.bak`);
  }
} catch (backupError) {
  logMessage(`备份字幕文件失败（继续保存）: ${backupError.message}`, 'warning');
}
```

- [ ] **Step 2.2: 门禁 → Commit**

```bash
git add main/helpers/ipcHandlers.ts
git commit -m "feat(proofread): write rolling .bak backup before overwriting subtitle files"
```

---

## Task 3: ProofreadEditor 未保存守卫 + 标记完成隐含保存

**Files:**

- Modify: `renderer/components/proofread/ProofreadEditor.tsx`
- Modify: `renderer/public/locales/zh/home.json`、`renderer/public/locales/en/home.json`

- [ ] **Step 3.1: i18n key（zh/home.json，"markCompleteAndBack" 同级附近插入）**

```json
  "unsavedChangesTitle": "有未保存的修改",
  "unsavedChangesDesc": "当前字幕有未保存的修改，直接返回将丢失这些修改。",
  "saveAndBack": "保存并返回",
  "discardAndBack": "不保存返回",
  "keepEditing": "继续编辑",
```

- [ ] **Step 3.2: i18n key（en/home.json 对应）**

```json
  "unsavedChangesTitle": "Unsaved changes",
  "unsavedChangesDesc": "You have unsaved subtitle edits. Leaving now will discard them.",
  "saveAndBack": "Save and leave",
  "discardAndBack": "Discard and leave",
  "keepEditing": "Keep editing",
```

- [ ] **Step 3.3: ProofreadEditor 接线**

- 头部 import 增加 AlertDialog 组件与 useState（已有）：

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
```

- hook 解构追加 `isDirty,`（`handleSave,` 之后）；
- 组件内加状态与处理器：

```tsx
const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

// 返回列表：有未保存修改时先拦截
const handleBackClick = useCallback(() => {
  if (isDirty) {
    setShowUnsavedDialog(true);
    return;
  }
  onBack();
}, [isDirty, onBack]);

const handleSaveAndBack = useCallback(async () => {
  const ok = await handleSave();
  setShowUnsavedDialog(false);
  if (ok) onBack();
}, [handleSave, onBack]);

const handleDiscardAndBack = useCallback(() => {
  setShowUnsavedDialog(false);
  onBack();
}, [onBack]);

// 标记完成隐含保存：保证完成态文件与界面一致
const handleMarkCompleteClick = useCallback(async () => {
  const ok = await handleSave();
  if (ok) onMarkComplete();
}, [handleSave, onMarkComplete]);
```

- 顶栏按钮改绑：`onClick={onBack}` → `onClick={handleBackClick}`；`onClick={onMarkComplete}` → `onClick={handleMarkCompleteClick}`；
- 组件 JSX 末尾（最外层 div 闭合前）加对话框：

```tsx
<AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{t('unsavedChangesTitle')}</AlertDialogTitle>
      <AlertDialogDescription>{t('unsavedChangesDesc')}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>{t('keepEditing')}</AlertDialogCancel>
      <Button variant="outline" onClick={handleDiscardAndBack}>
        {t('discardAndBack')}
      </Button>
      <AlertDialogAction onClick={handleSaveAndBack}>
        {t('saveAndBack')}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 3.4: 门禁 → Commit**

```bash
git add renderer/components/proofread/ProofreadEditor.tsx renderer/public/locales/zh/home.json renderer/public/locales/en/home.json
git commit -m "feat(proofread): unsaved-changes guard on back and implicit save on mark-complete"
```

---

## Task 4: 合成页清除独立 + 动态提示 + 输出路径默认值

**Files:**

- Modify: `renderer/components/subtitleMerge/hooks/useSubtitleMerge.ts`
- Modify: `renderer/components/subtitleMerge/SubtitleMergePanel.tsx`
- Modify: `renderer/components/subtitleMerge/MergeButton.tsx`
- Modify: `renderer/public/locales/zh/subtitleMerge.json`、`renderer/public/locales/en/subtitleMerge.json`

- [ ] **Step 4.1: hook — loadVideoInfo 输出路径移出成功分支**

```ts
const loadVideoInfo = useCallback(async (path: string) => {
  try {
    const result = await window.ipc.invoke('subtitleMerge:getVideoInfo', {
      videoPath: path,
    });
    if (result.success && result.data) {
      setVideoInfo(result.data);
    }
  } catch (error) {
    console.error('加载视频信息失败:', error);
  }
  // 只要选了视频就生成默认输出路径（不依赖视频信息读取成功）
  try {
    const outputResult = await window.ipc.invoke(
      'subtitleMerge:generateOutputPath',
      { videoPath: path, suffix: '_subtitled' },
    );
    if (outputResult.success && outputResult.data) {
      setOutputPathState(outputResult.data);
    }
  } catch (error) {
    console.error('生成默认输出路径失败:', error);
  }
}, []);
```

- [ ] **Step 4.2: hook — clearVideo / clearSubtitle（clearFiles 之后定义，保留 clearFiles）**

```ts
// 单独清除视频：输出路径派生自视频一并清除；合成结果不再对应，进度复位
const clearVideo = useCallback(() => {
  setVideoPathState(null);
  setVideoInfo(null);
  setOutputPathState(null);
  setProgress({ percent: 0, timeMark: '', targetSize: 0, status: 'idle' });
}, []);

// 单独清除字幕
const clearSubtitle = useCallback(() => {
  setSubtitlePathState(null);
  setSubtitleInfo(null);
  setProgress({ percent: 0, timeMark: '', targetSize: 0, status: 'idle' });
}, []);
```

return 对象 `clearFiles,` 之后加 `clearVideo,`、`clearSubtitle,`。

- [ ] **Step 4.3: SubtitleMergePanel 改绑**

解构追加 `clearVideo, clearSubtitle,`（`clearFiles,` 之后）；

```tsx
onClearVideo = { clearVideo };
onClearSubtitle = { clearSubtitle };
```

MergeButton 处追加两个 props：

```tsx
              <MergeButton
                videoPath={videoPath}
                subtitlePath={subtitlePath}
                outputPath={outputPath}
                ...
```

- [ ] **Step 4.4: MergeButton 动态提示**

Props 接口加 `videoPath: string | null; subtitlePath: string | null;`，解构加同名；提示块改为：

```tsx
{
  /* 提示信息：按缺失项动态生成 */
}
{
  !canMerge && status !== 'processing' && (
    <p className="text-xs text-muted-foreground text-center">
      {!videoPath && !subtitlePath
        ? t('selectFilesToMerge') || '请先选择视频和字幕文件'
        : !videoPath
          ? t('selectVideoToMerge') || '请选择视频文件'
          : !subtitlePath
            ? t('selectSubtitleToMerge') || '请选择字幕文件'
            : t('selectOutputPathToMerge') || '请选择输出路径'}
    </p>
  );
}
```

- [ ] **Step 4.5: i18n（subtitleMerge.json zh/en，"selectFilesToMerge" 之后插入）**

zh：

```json
  "selectVideoToMerge": "请选择视频文件",
  "selectSubtitleToMerge": "请选择字幕文件",
  "selectOutputPathToMerge": "请选择输出路径",
```

en：

```json
  "selectVideoToMerge": "Please select a video file",
  "selectSubtitleToMerge": "Please select a subtitle file",
  "selectOutputPathToMerge": "Please select an output path",
```

- [ ] **Step 4.6: 门禁 → Commit**

```bash
git add renderer/components/subtitleMerge/hooks/useSubtitleMerge.ts renderer/components/subtitleMerge/SubtitleMergePanel.tsx renderer/components/subtitleMerge/MergeButton.tsx renderer/public/locales/zh/subtitleMerge.json renderer/public/locales/en/subtitleMerge.json
git commit -m "fix(merge): independent clear buttons, accurate disabled hints and default output path"
```

---

## Task 5: 暗色失败行

**Files:**

- Modify: `renderer/components/subtitle/SubtitleList.tsx`

- [ ] **Step 5.1: 行容器（L151-157）**

```tsx
                    : isFailed
                      ? 'bg-red-50 hover:bg-red-100 border border-red-200 dark:bg-red-950/30 dark:hover:bg-red-900/40 dark:border-red-900'
                      : 'bg-card hover:bg-accent/50'
                } text-xs ${isFailed ? 'ring-1 ring-red-300 dark:ring-red-900' : ''}`}
```

- [ ] **Step 5.2: 翻译输入框（L233-235）**

```tsx
                    } ${isFailed ? 'border-red-300 focus:border-red-500 dark:border-red-800 dark:focus:border-red-400' : ''}`}
```

- [ ] **Step 5.3: 门禁 → Commit**

```bash
git add renderer/components/subtitle/SubtitleList.tsx
git commit -m "fix(proofread): dark mode variants for failed subtitle rows"
```

---

## Task 6: 冒烟自检与验收交接

- [ ] **Step 6.1: 双门禁全量跑一遍（输出为空）**
- [ ] **Step 6.2: dev 实例冒烟**：校对页与合成页路由编译 200、无运行时报错；
- [ ] **Step 6.3: 验收清单交用户**（spec §5 六条）。

---

## 已知边界与决策提醒

- `useStandaloneSubtitles` 仅 ProofreadEditor 一个消费方，改 API 安全；
- `handleSave` 的三段写入语义与 toast 文案保持不变，只加 flush/校验/返回值；
- `.bak` 滚动单份，备份失败仅 warning 不阻断保存；
- 不动：历史栈实现（命令模式属 Phase 2）、SubtitleEditToolbar、BatchAiOptimizeDialog、`clearFiles`（保留兼容）。
