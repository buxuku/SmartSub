# Proofread Panel + UI Polish Implementation Plan (WS-A / WS-B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the proofread-panel usability changes (friendly translation status, expand/collapse-all, font-size switch) plus the small copy/interaction fixes (engine copy, localCli collapsed-by-default, download-dialog button icons, proxy naming, log-dialog footer).

**Architecture:** All changes are renderer-side (React/Tailwind) + i18n JSON. The proofread changes live entirely inside `renderer/components/subtitle/SubtitleList.tsx` (status bar + row rendering) with new keys in `home.json`. The rest are isolated edits to `EnginesTab.tsx`, `LogDialog.tsx`, `resources.json`, and `settings.json`. No main-process, hooks, or data-layer changes.

**Tech Stack:** Next.js 14 (nextron), React 18, Tailwind, `@tanstack/react-virtual`, `lucide-react`, `next-i18next`. No component test runner exists, so verification = `yarn check:i18n` + typecheck/`yarn build` + manual visual checks (dev server `yarn dev` already running on terminal 18, or `yarn dev:cuda-sim`).

**Spec:** `docs/superpowers/specs/2026-06-14-ui-polish-and-infra-analysis-design.md` (§2 WS-A, §3 WS-B).

---

## File Structure

- Modify: `renderer/public/locales/zh/home.json` — add 9 proofread view-control keys.
- Modify: `renderer/public/locales/en/home.json` — same keys (en).
- Modify: `renderer/components/subtitle/SubtitleList.tsx` — `SubtitleRow` gains `forceExpanded` + `fontScale`; `SubtitleList` gains `expandAll`/`fontScale` state + restructured always-on status bar with friendly stats.
- Modify: `renderer/public/locales/zh/resources.json` + `renderer/public/locales/en/resources.json` — item 5 engine copy, item 9 `ghProxy` label.
- Modify: `renderer/public/locales/zh/settings.json` + `renderer/public/locales/en/settings.json` — item 9 `gpuAcceleration.ghProxy` label.
- Modify: `renderer/components/resources/EnginesTab.tsx` — item 7 (remove auto-expand effect) + item 8 (import `X`, add icons to 2 AlertDialog footers).
- Modify: `renderer/components/LogDialog.tsx` — item 10 (flex column + scroll body + pinned footer).

---

## Task 1: Add proofread view-control i18n keys (items 2 & 3)

**Files:**

- Modify: `renderer/public/locales/zh/home.json:97`
- Modify: `renderer/public/locales/en/home.json:97`

- [ ] **Step 1: Add the 9 new keys to zh/home.json**

Insert after the `"showAllSubtitles"` line (currently `renderer/public/locales/zh/home.json:97`):

```json
  "showAllSubtitles": "显示全部字幕",
  "transStatTotal": "全部 {{count}}",
  "transStatSuccess": "成功 {{count}}",
  "transStatFailed": "失败 {{count}}",
  "expandAll": "展开全部",
  "collapseAll": "收起全部",
  "fontSizeLabel": "字体",
  "fontSizeSmall": "小",
  "fontSizeMedium": "中",
  "fontSizeLarge": "大",
```

- [ ] **Step 2: Add the same 9 keys to en/home.json**

Insert after the `"showAllSubtitles"` line (currently `renderer/public/locales/en/home.json:97`):

```json
  "showAllSubtitles": "Show all subtitles",
  "transStatTotal": "All {{count}}",
  "transStatSuccess": "Success {{count}}",
  "transStatFailed": "Failed {{count}}",
  "expandAll": "Expand all",
  "collapseAll": "Collapse all",
  "fontSizeLabel": "Font",
  "fontSizeSmall": "S",
  "fontSizeMedium": "M",
  "fontSizeLarge": "L",
```

- [ ] **Step 3: Verify i18n parity**

Run: `yarn check:i18n`
Expected: exits 0, no missing-key errors for `home` namespace (the 9 keys exist in both zh and en). If the script reports unrelated pre-existing diffs, confirm none of them are the keys you just added.

- [ ] **Step 4: Commit**

```bash
git add renderer/public/locales/zh/home.json renderer/public/locales/en/home.json
git commit -m "feat(proofread): add i18n keys for status stats, expand-all and font size"
```

---

## Task 2: `SubtitleRow` — support forced expand + font scale

**Files:**

- Modify: `renderer/components/subtitle/SubtitleList.tsx:93-279`

This task only changes the row component. After it, rows can render expanded when `forceExpanded` is true and scale body font via `fontScale`. `SubtitleList` still passes `forceExpanded={false}` implicitly until Task 3 — so add the props with safe defaults to keep the build green between tasks.

- [ ] **Step 1: Add `forceExpanded` + `fontScale` to `SubtitleRowProps`**

In the `interface SubtitleRowProps` block (currently ends at `SubtitleList.tsx:125`), add two fields after `shouldShowTranslation: boolean;`:

```ts
shouldShowTranslation: boolean;
forceExpanded: boolean;
fontScale: 's' | 'm' | 'l';
showAiOptimize: boolean;
```

- [ ] **Step 2: Destructure the new props and compute `expanded` + `bodyFont`**

In the `SubtitleRow` function params (currently `SubtitleList.tsx:128-146`), add `forceExpanded` and `fontScale` to the destructure (after `shouldShowTranslation,`). Then, immediately after the `failedEdge` const (currently `:148-150`), add:

```ts
const expanded = isCurrent || forceExpanded;
const bodyFont =
  fontScale === 's' ? 'text-[11px]' : fontScale === 'l' ? 'text-sm' : 'text-xs';
```

- [ ] **Step 3: Switch the compact branch from `!isCurrent` to `!expanded` and apply `bodyFont`**

Change the guard on the compact branch (currently `if (!isCurrent) {` at `:152`) to `if (!expanded) {`. Then apply `bodyFont` to the body preview span (currently `:170`), changing:

```tsx
        <span className="min-w-0 flex-1 truncate text-foreground/90">
```

to:

```tsx
        <span className={`min-w-0 flex-1 truncate text-foreground/90 ${bodyFont}`}>
```

- [ ] **Step 4: In the expanded branch, make background depend on `isCurrent` and apply `bodyFont` to both textareas**

In the expanded return (currently starts `:181`), change the container className (currently `:184`) from:

```tsx
      className={`rounded-md bg-accent p-1.5 text-xs ${failedEdge}`}
```

to:

```tsx
      className={`rounded-md ${isCurrent ? 'bg-accent' : 'bg-card'} p-1.5 text-xs ${failedEdge}`}
```

Then change the source `Textarea` className (currently `:248`) from `"mb-2 min-h-[24px] resize-none p-1 text-xs"` to:

```tsx
        className={`mb-2 min-h-[24px] resize-none p-1 ${bodyFont}`}
```

And change the target `Textarea` className (currently `:260-264`) from:

```tsx
          className={`resize-none p-1 text-xs ${
            subtitle.targetContent ? 'min-h-[24px]' : 'min-h-[20px]'
          } ${
            isFailed ? 'border-destructive/40 focus:border-destructive' : ''
          }`}
```

to:

```tsx
          className={`resize-none p-1 ${bodyFont} ${
            subtitle.targetContent ? 'min-h-[24px]' : 'min-h-[20px]'
          } ${
            isFailed ? 'border-destructive/40 focus:border-destructive' : ''
          }`}
```

- [ ] **Step 5: Typecheck (the row now requires the new props; Task 3 supplies them)**

Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: ONE error at the `<SubtitleRow ... />` call site (currently `:697`) — `Property 'forceExpanded'/'fontScale' is missing`. This is expected and fixed in Task 3. No other new errors.

> Do not commit yet — Task 3 completes the compile. (If you must keep commits atomic and green, do Tasks 2 and 3 as one commit at the end of Task 3.)

---

## Task 3: `SubtitleList` — always-on status bar, friendly stats, expand-all + font size

**Files:**

- Modify: `renderer/components/subtitle/SubtitleList.tsx:281-726`

- [ ] **Step 1: Add `expandAll` + `fontScale` state initialised from localStorage**

After the `failedOnly`/`failedBaseline` state (currently `SubtitleList.tsx:305-306`), add:

```tsx
const [expandAll, setExpandAll] = useState(false);
const [fontScale, setFontScale] = useState<'s' | 'm' | 'l'>('m');

// 读取持久化的视图偏好（仅客户端，避免 SSR 不一致）
useEffect(() => {
  try {
    setExpandAll(localStorage.getItem('proofread:expandAll') === '1');
    const fs = localStorage.getItem('proofread:fontScale');
    if (fs === 's' || fs === 'm' || fs === 'l') setFontScale(fs);
  } catch {
    // localStorage 不可用时用默认值
  }
}, []);

const toggleExpandAll = useCallback(() => {
  setExpandAll((prev) => {
    const next = !prev;
    try {
      localStorage.setItem('proofread:expandAll', next ? '1' : '0');
    } catch {
      // 忽略持久化失败
    }
    return next;
  });
}, []);

const handleFontScale = useCallback((scale: 's' | 'm' | 'l') => {
  setFontScale(scale);
  try {
    localStorage.setItem('proofread:fontScale', scale);
  } catch {
    // 忽略持久化失败
  }
}, []);
```

- [ ] **Step 2: Re-measure virtual rows when `expandAll` changes**

After the `virtualizer` is created (currently `SubtitleList.tsx:370-378`), add this effect (place it right after the virtualizer declaration):

```tsx
// 展开/收起全部会改变每行高度，强制虚拟列表重算
useEffect(() => {
  virtualizer.measure();
}, [expandAll, fontScale, virtualizer]);
```

- [ ] **Step 3: Import the icons used by the new controls**

In the `lucide-react` import block (currently `SubtitleList.tsx:13-25`), add `ChevronsUpDown` and `ChevronsDownUp` to the list:

```tsx
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronsDownUp,
  AlertTriangle,
```

- [ ] **Step 4: Replace the status-bar block with an always-on bar (friendly stats + view controls)**

Replace the entire status-bar block (currently `SubtitleList.tsx:543-628`, the comment `{/* 翻译失败导航栏 */}` through its closing `)}`) with:

```tsx
{
  /* 状态/视图控制栏（常驻：纯转写下也显示展开全部 + 字号） */
}
<div className="flex items-center justify-between gap-2 p-2 border-b bg-muted/30 flex-shrink-0">
  <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
    {shouldShowTranslation && (
      <>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {failedIndices.length === 0 ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <span className="tabular-nums">
            {t('transStatTotal', { count: mergedSubtitles.length })}
            {' · '}
            {t('transStatSuccess', {
              count: mergedSubtitles.length - failedIndices.length,
            })}
            {' · '}
            <span
              className={
                failedIndices.length > 0 ? 'text-destructive font-semibold' : ''
              }
            >
              {t('transStatFailed', { count: failedIndices.length })}
            </span>
          </span>
        </div>
        {(hasFailedTranslations || failedOnly) && (
          <label className="flex flex-shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs">
            <Switch
              checked={failedOnly}
              onCheckedChange={handleFailedOnlyChange}
              className="scale-75"
            />
            {t('failedOnlyLabel')}
          </label>
        )}
        {failedOnly && failedBaseline > 0 && (
          <span className="flex-shrink-0 text-xs tabular-nums">
            {t('failedProcessedProgress')
              .replace('{{done}}', String(processedCount))
              .replace('{{total}}', String(failedBaseline))}
          </span>
        )}
      </>
    )}
  </div>
  <div className="flex flex-shrink-0 items-center gap-1.5">
    {shouldShowTranslation &&
      retranslate &&
      hasFailedTranslations &&
      (retranslate.running ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="tabular-nums">
            {retranslate.done}/{retranslate.total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={retranslate.cancel}
            disabled={retranslate.cancelling}
          >
            <CircleStop className="h-4 w-4" />
            {retranslate.cancelling ? t('cancelling') : t('cancel')}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={retranslate.start}
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          {t('retranslateFailedBtn').replace(
            '{{count}}',
            String(failedIndices.length),
          )}
        </Button>
      ))}
    {shouldShowTranslation && hasFailedTranslations && (
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={goToPreviousFailedTranslation}
          className="h-7 px-2"
        >
          <ChevronUp className="h-3 w-3" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={goToNextFailedTranslation}
          className="h-7 px-2"
        >
          <ChevronDown className="h-3 w-3" />
        </Button>
      </div>
    )}
    {/* 展开/收起全部 */}
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={toggleExpandAll}
    >
      {expandAll ? (
        <ChevronsDownUp className="h-3.5 w-3.5" />
      ) : (
        <ChevronsUpDown className="h-3.5 w-3.5" />
      )}
      {expandAll ? t('collapseAll') : t('expandAll')}
    </Button>
    {/* 字号 小/中/大 */}
    <div className="flex items-center overflow-hidden rounded-md border">
      {(['s', 'm', 'l'] as const).map((scale) => (
        <button
          key={scale}
          type="button"
          onClick={() => handleFontScale(scale)}
          className={`px-2 py-1 text-xs transition-colors ${
            fontScale === scale
              ? 'bg-primary/5 text-primary font-medium'
              : 'text-muted-foreground hover:bg-accent/50'
          }`}
        >
          {scale === 's'
            ? t('fontSizeSmall')
            : scale === 'm'
              ? t('fontSizeMedium')
              : t('fontSizeLarge')}
        </button>
      ))}
    </div>
  </div>
</div>;
```

- [ ] **Step 5: Pass `forceExpanded` + `fontScale` into `SubtitleRow`**

In the `<SubtitleRow ... />` call (currently `SubtitleList.tsx:697-717`), add the two props after `shouldShowTranslation={shouldShowTranslation}`:

```tsx
                    shouldShowTranslation={shouldShowTranslation}
                    forceExpanded={expandAll}
                    fontScale={fontScale}
                    showAiOptimize={!!onAiOptimizeClick}
```

- [ ] **Step 6: Typecheck the renderer**

Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: PASS (no errors). The Task 2 missing-prop error is now resolved.

- [ ] **Step 7: Manual verification (dev server)**

With dev running (`yarn dev` or terminal 18's `yarn dev:cuda-sim`), open a proofread task:

1. All translations succeed → status shows green check + `全部 6 · 成功 6 · 失败 0`, no ⚠.
2. Construct/open a file with some failed lines → ⚠ warning + `失败 N` highlighted red; prev/next + retranslate still appear.
3. Click `展开全部` → every row renders multi-line (editable); icon/label flips to `收起全部`; scrolling stays smooth on a long list; reload app → state persists.
4. Click 小/中/大 → body + textarea font changes immediately; meta (#id, time) unchanged; reload → persists.
5. Open a transcription-only file (no translation) → status bar still shows, with only 展开全部 + font controls (no translation stats).

- [ ] **Step 8: Commit**

```bash
git add renderer/components/subtitle/SubtitleList.tsx
git commit -m "feat(proofread): friendly translation status + expand-all + font-size controls"
```

---

## Task 4: Engine copy edits (item 5)

**Files:**

- Modify: `renderer/public/locales/zh/resources.json:30,35`
- Modify: `renderer/public/locales/en/resources.json:30,35`

- [ ] **Step 1: zh — M series + trim faster-whisper tail**

In `renderer/public/locales/zh/resources.json`, change the `builtin.desc` (currently `:30`) so `苹果芯片（M1/M2/M3）` becomes `苹果芯片（M 系列）`:

```json
      "desc": "默认引擎，支持 ggml 量化模型与 GPU 加速；苹果芯片（M 系列）有专属优化、速度更快，电脑配置老旧或内存偏小时也能轻量流畅运行、不卡顿。",
```

And change `fasterWhisper.desc` (currently `:35`), removing the trailing `，适合处理 1 小时以上长录音、批量转写多个文件`:

```json
      "desc": "基于 CTranslate2，速度更快，模型按需从 HuggingFace 下载；带英伟达（NVIDIA）独立显卡的电脑速度最快，普通 Windows 电脑也更快。",
```

- [ ] **Step 2: en — M series + trim faster-whisper tail**

In `renderer/public/locales/en/resources.json`, change `builtin.desc` (currently `:30`) so `Apple silicon (M1/M2/M3)` becomes `Apple silicon (M series)`:

```json
      "desc": "Default engine with ggml quantized models and GPU acceleration; specially optimized for Apple silicon (M series) for extra speed, and stays light and smooth on older or low-memory computers.",
```

And change `fasterWhisper.desc` (currently `:35`), removing ` — ideal for recordings over an hour and batch-transcribing many files`:

```json
      "desc": "CTranslate2-based engine with faster inference; models download from HuggingFace on demand. Fastest on computers with a dedicated NVIDIA GPU, and faster on regular Windows PCs too.",
```

- [ ] **Step 3: Verify JSON validity + i18n parity**

Run: `yarn check:i18n`
Expected: exits 0; no key add/remove (only values changed), no JSON parse errors.

- [ ] **Step 4: Commit**

```bash
git add renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "docs(engines): use 'M series' wording and trim faster-whisper use-case tail"
```

---

## Task 5: localCli command config collapsed by default (item 7)

**Files:**

- Modify: `renderer/components/resources/EnginesTab.tsx:94-95,171-177`

- [ ] **Step 1: Remove the auto-expand effect**

Delete the effect that force-opens the command config (currently `EnginesTab.tsx:171-177`):

```tsx
// localCli 已有命令时首次自动展开配置区；之后尊重用户手动开合
useEffect(() => {
  if (!commandConfigInitRef.current && whisperCommand) {
    commandConfigInitRef.current = true;
    setShowCommandConfig(true);
  }
}, [whisperCommand]);
```

- [ ] **Step 2: Remove the now-unused `commandConfigInitRef`**

Delete its declaration (currently `EnginesTab.tsx:95`):

```tsx
const commandConfigInitRef = useRef(false);
```

Leave `const [showCommandConfig, setShowCommandConfig] = useState(false);` (currently `:94`) untouched — `false` is the desired collapsed default, and the manual toggle button (`:772-785`) keeps working.

- [ ] **Step 3: Check for other `commandConfigInitRef`/unused `useRef` references**

Run: `rg "commandConfigInitRef" renderer/components/resources/EnginesTab.tsx`
Expected: no matches. If `useRef` is now unused in the file, leave the import as-is only if other refs use it; otherwise remove `useRef` from the React import to avoid an unused-import lint. Verify with:
Run: `rg "useRef" renderer/components/resources/EnginesTab.tsx`
Expected: if other `useRef(` calls remain, keep the import; if none remain, remove `useRef` from the import.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Dev server → open Resource Hub → Engines → select localCli engine (with a saved `whisperCommand`): the "配置命令" section is collapsed on first view; clicking it expands/collapses as before.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx
git commit -m "fix(engines): collapse localCli command config by default"
```

---

## Task 6: Download/upgrade dialog button icons (item 8)

**Files:**

- Modify: `renderer/components/resources/EnginesTab.tsx:36-51,850-855,873-878`

- [ ] **Step 1: Import the `X` icon**

In the `lucide-react` import block (currently `EnginesTab.tsx:36-51`), add `X,` (e.g. after `Box,`):

```tsx
import {
  Box,
  X,
  Zap,
```

(`Download` and `ArrowUpCircle` are already imported at `:42` and `:46`.)

- [ ] **Step 2: Add icons to the download dialog footer**

Replace the download `AlertDialogFooter` (currently `EnginesTab.tsx:850-855`) with:

```tsx
<AlertDialogFooter>
  <AlertDialogCancel className="gap-1.5">
    <X className="h-4 w-4" />
    {commonT('cancel')}
  </AlertDialogCancel>
  <AlertDialogAction className="gap-1.5" onClick={handleStartDownload}>
    <Download className="h-4 w-4" />
    {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
  </AlertDialogAction>
</AlertDialogFooter>
```

- [ ] **Step 3: Add icons to the upgrade dialog footer**

Replace the upgrade `AlertDialogFooter` (currently `EnginesTab.tsx:873-878`) with:

```tsx
<AlertDialogFooter>
  <AlertDialogCancel className="gap-1.5">
    <X className="h-4 w-4" />
    {commonT('cancel')}
  </AlertDialogCancel>
  <AlertDialogAction className="gap-1.5" onClick={handleUpgrade}>
    <ArrowUpCircle className="h-4 w-4" />
    {t('engines.fasterWhisper.upgrade')}
  </AlertDialogAction>
</AlertDialogFooter>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Dev server → Engines → faster-whisper → trigger the download dialog and the upgrade dialog: Cancel shows an `X` icon, the primary action shows a download / upgrade icon, both with consistent `gap-1.5` spacing.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx
git commit -m "feat(engines): add unified icons to download/upgrade dialog buttons"
```

---

## Task 7: Unify proxy naming to "github 国内加速" (item 9)

**Files:**

- Modify: `renderer/public/locales/zh/resources.json:4`
- Modify: `renderer/public/locales/en/resources.json:4`
- Modify: `renderer/public/locales/zh/settings.json:82`
- Modify: `renderer/public/locales/en/settings.json:82`

> No component logic changes: `EnginesTab.tsx:393` and `CudaDownloadSheet.tsx:290` already map `['github','ghproxy','gitcode']` (same order) and render `t('ghProxy')` / `t('gpuAcceleration.ghProxy')`. Renaming the i18n values updates both selectors. Do NOT change `modelsControl.domesticMirror` ("国内加速源（更快）").

- [ ] **Step 1: resources.json `ghProxy`**

`renderer/public/locales/zh/resources.json:4`: change `"ghProxy": "Gh代理",` → `"ghProxy": "github 国内加速",`
`renderer/public/locales/en/resources.json:4`: change `"ghProxy": "GH Proxy",` → `"ghProxy": "GitHub Mirror (China)",`

- [ ] **Step 2: settings.json `gpuAcceleration.ghProxy`**

`renderer/public/locales/zh/settings.json:82`: change `"ghProxy": "GitHub 代理 (国内加速)",` → `"ghProxy": "github 国内加速",`
`renderer/public/locales/en/settings.json:82`: change `"ghProxy": "GitHub Proxy (Faster in China)",` → `"ghProxy": "GitHub Mirror (China)",`

- [ ] **Step 3: Verify order consistency (acceptance check, no edit expected)**

Run: `rg -n "'github', 'ghproxy', 'gitcode'" renderer/components/resources/EnginesTab.tsx renderer/components/settings/gpu/CudaDownloadSheet.tsx`
Expected: one match in each file (both render order = GitHub · github 国内加速 · GitCode). If a third three-source selector exists, it must use the same order.

- [ ] **Step 4: i18n parity + manual check**

Run: `yarn check:i18n`
Expected: exits 0.
Dev server → Engines download dialog AND Settings → GPU acceleration download source: the middle option reads "github 国内加速" (en: "GitHub Mirror (China)") in both places, in the same position.

- [ ] **Step 5: Commit**

```bash
git add renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json renderer/public/locales/zh/settings.json renderer/public/locales/en/settings.json
git commit -m "feat(i18n): unify GitHub mirror label to 'github 国内加速'"
```

---

## Task 8: Log dialog footer pinned to bottom (item 10)

**Files:**

- Modify: `renderer/components/LogDialog.tsx:77,82,105`

Root cause: `DialogContent` base is `grid + overflow-hidden + max-h` (`ui/dialog.tsx:39`); this dialog uses a fixed `h-[60vh]` scroll body and a plain `mt-4` footer, so on short windows the total exceeds `max-h-[80vh]` and the footer is clipped. Fix = make the content a flex column, let the body flex-grow/scroll, and keep the footer non-shrinking.

- [ ] **Step 1: Make `DialogContent` a flex column**

Change `LogDialog.tsx:77` from:

```tsx
      <DialogContent className="max-w-3xl max-h-[80vh]">
```

to:

```tsx
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
```

(`flex` overrides the base `grid` via tailwind-merge.)

- [ ] **Step 2: Make the scroll body flex-grow instead of fixed height**

Change `LogDialog.tsx:82` from:

```tsx
        <ScrollArea ref={scrollRef} className="h-[60vh]">
```

to:

```tsx
        <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
```

- [ ] **Step 3: Keep the footer visible (non-shrinking)**

Change the footer div `LogDialog.tsx:105` from:

```tsx
        <div className="flex justify-end space-x-2 mt-4">
```

to:

```tsx
        <div className="flex justify-end space-x-2 mt-4 shrink-0">
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Dev server → open the global Log dialog. Resize the app window very short: the Copy / Clear buttons stay pinned and visible at the bottom; the log list scrolls within the remaining space.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/LogDialog.tsx
git commit -m "fix(logs): pin log dialog footer with flex column + scrollable body"
```

---

## Task 9: Whole-plan verification

- [ ] **Step 1: i18n consistency**

Run: `yarn check:i18n`
Expected: exits 0.

- [ ] **Step 2: Production build (renderer + main compile)**

Run: `yarn build`
Expected: completes with no new TypeScript errors. (Pre-existing `tsbuildinfo` churn is fine.)

- [ ] **Step 3: Format**

Run: `yarn format`
Expected: rewrites only the files you touched (or no changes). Re-commit if formatting changed any file:

```bash
git add -A
git commit -m "style: prettier formatting for UI polish changes"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** item2 → Task 3 Step 4; item3.2 → Tasks 2-3; item3.3 → Tasks 2-3; status bar always-on (§2.4) → Task 3 Step 4; item5 → Task 4; item7 → Task 5; item8 → Task 6; item9 → Task 7 (incl. order-consistency check); item10 → Task 8. All §2/§3 requirements mapped.
- **No placeholders:** every code step shows the exact edited code.
- **Type consistency:** `forceExpanded: boolean` + `fontScale: 's'|'m'|'l'` defined in `SubtitleRowProps` (Task 2 Step 1), destructured (Task 2 Step 2), and passed from `SubtitleList` (Task 3 Step 5). `expandAll`/`fontScale` state names match between declaration (Task 3 Step 1) and usage (Steps 2/4/5).
