# Task UX Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent task-page usability fixes — engine detection feedback, default model selection + start guard, embedded soft-subtitle marker, list/grid task views, and a VAD toggle with faster-whisper word-level timestamps.

**Architecture:** An Electron + Next.js (nextron) app. Renderer talks to the main process via a generic `window.ipc.invoke/send/on` bridge (`main/preload.ts`). Each topic is self-contained: T5a/T5b touch the faster-whisper adapter + advanced sheet; T1 touches the engines tab; T2 touches model selection + start guard; T3 touches the file processor + row list; T4 adds a grid view. Settings persist in `electron-store` (`store.settings`, merged by `setSettings`).

**Tech Stack:** TypeScript, React 18, Next.js (nextron), Electron, shadcn/ui, lucide-react (0.378), next-i18next, react-hook-form, electron-store.

---

## Spec

Design: `docs/superpowers/specs/2026-06-15-task-ux-batch-design.md`. Read it before starting.

## Testing Reality (read first)

This repo has **no React component test runner** (no jest/RTL). So component/UI changes are verified by:

1. **Typecheck gate:** `npx tsc -p tsconfig.json` → must exit 0, no new errors.
2. **i18n parity gate:** `node scripts/check-i18n.mjs` → zh/en keys must stay in parity.
3. **Manual matrix:** the concrete steps listed per task.

Main-process engine logic also runs:

4. **Engine unit gate:** `npm run test:engines` → last line must read `0 failed`.

Run gates from the repo root. Each task ends with its gate commands + a commit.

## Task Order & Dependencies

1. Task 1 — T5a faster-whisper `word_timestamps` (main process)
2. Task 2 — T1 engine detection feedback (EnginesTab)
3. Task 3 — T2 default model + start guard
4. Task 4 — T3 embedded soft-subtitle marker
5. Task 5 — T5b VAD toggle in Advanced sheet
6. Task 6 — T4 list/grid view (**depends on Task 4** for the `embeddedSubtitle` field used by the grid badge)

Tasks 1–5 are mutually independent. Do Task 4 before Task 6.

---

## Task 1: faster-whisper `word_timestamps` (T5a)

Enable word-level timestamps in the faster-whisper sidecar request so segment end-times stop collapsing into the next segment's start (faster-whisper [issue #1119](https://github.com/SYSTRAN/faster-whisper/issues/1119)). The SRT is built from `segment.start/end`, so it benefits automatically — no SRT code change.

**Files:**

- Modify: `main/helpers/engines/fasterWhisperEngine.ts:88-109` (the `params` object)

- [ ] **Step 1: Add `word_timestamps: true` to the transcribe params**

In `main/helpers/engines/fasterWhisperEngine.ts`, the `params` object currently ends with the VAD fields. Add `word_timestamps: true` right after `initial_prompt`. Resulting object:

```ts
const params = {
  engine: 'faster_whisper',
  audio_file: tempAudioFile,
  model: modelSnapshotDir,
  local_files_only: true,
  download_root: getFasterWhisperModelsPath(),
  language: getWhisperLanguage(sourceLanguage),
  device: settings.fasterWhisperDevice || 'auto',
  compute_type: settings.fasterWhisperComputeType || 'auto',
  initial_prompt: prompt || '',
  // faster-whisper #1119：开启词级时间戳，让 segment.end 对齐到真实末词，
  // 避免开 VAD 时段尾时间被拉到下一段开头。旧 sidecar 忽略该参数也无害。
  word_timestamps: true,
  vad: settings.useVAD !== false,
  vad_threshold: getNumericSetting(settings.vadThreshold, 0.5),
  vad_min_speech_duration_ms: getNumericSetting(
    settings.vadMinSpeechDuration,
    250,
  ),
  vad_min_silence_duration_ms: getNumericSetting(
    settings.vadMinSilenceDuration,
    100,
  ),
  vad_speech_pad_ms: getNumericSetting(settings.vadSpeechPad, 30),
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json`
Expected: exit 0, no new errors.

- [ ] **Step 3: Engine unit gate**

Run: `npm run test:engines`
Expected: last line `0 failed`.

- [ ] **Step 4: Manual smoke (installed faster-whisper required)**

Switch engine to faster-whisper, run one short video (`generate` task). Confirm: the run completes; in the output SRT, a segment's end time no longer equals the next segment's start verbatim (compare against the #1119 description). The main-process log line `fasterWhisperParams:` should include `"word_timestamps": true`.

- [ ] **Step 5: Commit**

```bash
git add main/helpers/engines/fasterWhisperEngine.ts
git commit -m "feat(engine): enable faster-whisper word_timestamps to fix segment end times (#1119)"
```

---

## Task 2: Engine detection feedback (T1)

After a faster-whisper engine download completes, there is a gap before it is truly usable (PyInstaller cold start). Today `refresh()` returns quickly (it only reads the manifest), so the download button reappears and the user can re-click. Make "detecting" a real phase backed by the existing `python-engine:ping` IPC (which calls `ensureStarted()` and cold-starts the runtime), and hide the download/repair buttons while detecting.

**Files:**

- Modify: `renderer/components/resources/EnginesTab.tsx:143-149` (the `completed` branch) and `:647` (download button visibility)
- No i18n additions needed — reuse existing `engines.fasterWhisper.verifying` (zh `正在校验并启动引擎…` / en `Verifying & starting engine…`).

- [ ] **Step 1: Make the `completed` branch await a real cold-start ping**

In `renderer/components/resources/EnginesTab.tsx`, replace the `completed` branch inside the `py-engine-download-progress` listener (currently lines 143-149):

```tsx
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需校验/冷启动，期间给出明确状态，避免用户以为卡住没反应
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          refresh().finally(() => setVerifying(false));
        } else if (_progress.status === 'error') {
```

with a version that pings the runtime (real cold-start validation) before clearing `verifying`:

```tsx
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需冷启动校验（PyInstaller 首帧加载），期间保持「检测中」，
          // 避免用户以为卡住没反应、且能挡住下载/修复按钮被重复点击。
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          (async () => {
            try {
              await window?.ipc?.invoke('python-engine:ping');
            } catch {
              // 校验失败：忽略错误，交给 refresh() 反映真实状态（broken → 显示修复入口）
            } finally {
              await refresh();
              setVerifying(false);
            }
          })();
        } else if (_progress.status === 'error') {
```

> Context: `python-engine:ping` is registered in `main/helpers/ipcEngineHandlers.ts` (`getPythonRuntimeManager().ensureStarted()`), and the preload bridge exposes a generic `invoke(channel, ...args)`, so no whitelist change is needed.

- [ ] **Step 2: Hide the download button while detecting**

Still in `EnginesTab.tsx`, the download button (currently `{!fasterInstalled && !isDownloading && !fasterBroken && (`) must also hide while `verifying`. Change that condition (around line 647) to:

```tsx
{
  !fasterInstalled && !isDownloading && !fasterBroken && !verifying && (
    <Button
      size="sm"
      className="gap-1.5"
      onClick={() => setShowDownloadConfirm(true)}
    >
      <Download className="h-3.5 w-3.5" />
      {t('engines.fasterWhisper.download', {
        size: PY_ENGINE_SIZE,
      })}
    </Button>
  );
}
```

> The badge already renders a `verifying` state (lines ~330-336) and the panel already shows a `verifying && !isDownloading` block (lines ~632-638), so the only missing guard is the download button. The repair button is gated by `fasterBroken` (false during detection) and set-active/uninstall are gated by `taskBusy`, so no further changes are required.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json`
Expected: exit 0, no new errors.

- [ ] **Step 4: i18n parity gate**

Run: `node scripts/check-i18n.mjs`
Expected: no missing/extra keys reported (we reused existing keys).

- [ ] **Step 5: Manual verification**

Uninstall faster-whisper, then click Download. Observe the order: `Downloading…` (progress bar) → `Verifying & starting engine…` (no download button visible, button cannot be re-clicked) → `Available`. If the engine fails cold start, it should land on the broken/repair UI rather than hanging in "verifying" (ping has a 60s timeout in the manager).

- [ ] **Step 6: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx
git commit -m "feat(engines): real detecting phase after download via python-engine:ping, block re-click"
```

---

## Task 3: Default model selection + start guard (T2)

When a user has installed a model but never picked one, the model field is empty and starting a task can error. Auto-select the first selectable model for the current engine, and add a final guard in `TaskControls` so an empty model never reaches the queue.

`renderer/lib/engineModels.ts` already has `resolveEngine`, `getInstalledModelsForEngine` (returns `[]` for localCli by design — that semantic must NOT change), and `hasModelsForEngine`. The dropdown (`Models.tsx`) shows a different list for localCli (built-in `models`). To auto-select what is actually selectable, add a new `getSelectableModelsForEngine` that mirrors the dropdown, and make `Models.tsx` consume it (single source of truth).

**Files:**

- Modify: `renderer/lib/engineModels.ts` (add `getSelectableModelsForEngine`)
- Modify: `renderer/components/Models.tsx:26-40` (consume the shared function)
- Modify: `renderer/pages/[locale]/tasks/[type].tsx` (add auto-select effect)
- Modify: `renderer/components/TaskControls.tsx:80-87` (add model guard)
- Modify: `renderer/public/locales/zh/home.json` + `renderer/public/locales/en/home.json` (add `selectModelFirst`)

- [ ] **Step 1: Add `getSelectableModelsForEngine` to `engineModels.ts`**

Append to `renderer/lib/engineModels.ts` (and add the `models` import at the top). The new function returns exactly what the dropdown offers, including localCli's built-in models:

At the top of the file, add the import:

```ts
import { models } from './utils';
```

Then add the function (after `getInstalledModelsForEngine`):

```ts
/**
 * 当前引擎在「语音模型」下拉里可选的模型列表（与 Models.tsx 下拉同源）。
 * 与 getInstalledModelsForEngine 的区别：localCli 返回内置 models 名单（用户自备模型/命令，
 * 下拉里仍可选），而 getInstalledModelsForEngine 对 localCli 返回 [] 用于「就绪判断」。
 * 用于默认模型自动选择，确保自动选中的值一定是下拉里存在的选项。
 */
export function getSelectableModelsForEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): string[] {
  const engine = resolveEngine(info, useLocalWhisper);
  if (engine === 'fasterWhisper') {
    return info?.fasterWhisperModelsInstalled ?? [];
  }
  if (engine === 'localCli') {
    return models.map((m) => m.name);
  }
  return info?.modelsInstalled ?? [];
}
```

- [ ] **Step 2: Make `Models.tsx` use the shared function (DRY)**

In `renderer/components/Models.tsx`, replace the local `getAvailableModels` (lines 26-40) with the shared helper so the dropdown and auto-select never diverge:

```tsx
const availableModels = getSelectableModelsForEngine(
  {
    transcriptionEngine: props.transcriptionEngine,
    modelsInstalled: props.modelsInstalled,
    fasterWhisperModelsInstalled: props.fasterWhisperModelsInstalled,
  },
  props.useLocalWhisper,
);
```

Add the import near the other imports at the top of `Models.tsx`:

```tsx
import { getSelectableModelsForEngine } from 'lib/engineModels';
```

Remove the now-unused `engine` const and `getAvailableModels` definition. Keep everything else (the `availableModels.map(...)` render below already uses `availableModels`).

- [ ] **Step 3: Add the auto-select effect to the task page**

In `renderer/pages/[locale]/tasks/[type].tsx`, add the import:

```tsx
import { getSelectableModelsForEngine } from 'lib/engineModels';
```

Then add this effect next to the other form-normalizing effects (e.g., right after the `translateProvider` cleanup effect that ends around line 231):

```tsx
// 已装模型但未选（或选中的模型不属于当前引擎）→ 自动选第一个，避免空模型直接开始任务报错。
// 切换引擎（systemInfo.transcriptionEngine / useLocalWhisper 变化）时复跑，修正残留旧选择。
useEffect(() => {
  if (!typeDef?.needsModel) return;
  if (!formData || Object.keys(formData).length === 0) return; // 配置未加载完
  const selectable = getSelectableModelsForEngine(
    systemInfo,
    useLocalWhisper,
  ).map((m) => m.toLowerCase());
  if (!selectable.length) return; // 无可选模型：保持空，InlineConfigBar 展示「去下载模型」
  const current = (formData.model || '').toLowerCase();
  if (current && selectable.includes(current)) return;
  form.setValue('model', selectable[0]);
}, [typeDef, systemInfo, useLocalWhisper, formData?.model, form]);
```

> Note: `Models.tsx` stores the selected value lower-cased (`value={model.toLowerCase()}`), so auto-select sets and compares lower-cased values.

- [ ] **Step 4: Add the start guard to `TaskControls`**

In `renderer/components/TaskControls.tsx`, inside `handleTask`, add a model guard immediately after the existing translate-provider check (after line 87, before the `pendingFiles` filter):

```tsx
// 需要模型的任务必须已选模型：自动选择兜底后仍为空，说明确实没有可用模型，拦截并指引下载
if (typeDef.needsModel && !formData?.model) {
  toast.error(t('home:selectModelFirst'));
  return;
}
```

> `TaskControls` already uses `useTranslation(['home', 'common'])` and imports `toast` from sonner, so no new imports are needed.

- [ ] **Step 5: Add the i18n key (zh + en)**

In `renderer/public/locales/zh/home.json`, next to `"selectProviderFirst"` add:

```json
  "selectModelFirst": "请先选择语音模型",
```

In `renderer/public/locales/en/home.json`, next to `"selectProviderFirst"` add:

```json
  "selectModelFirst": "Please select a speech model first",
```

- [ ] **Step 6: Typecheck + i18n gate**

Run: `npx tsc -p tsconfig.json`
Expected: exit 0 (no unused `engine` var error from Models.tsx).

Run: `node scripts/check-i18n.mjs`
Expected: zh/en parity OK (both got `selectModelFirst`).

- [ ] **Step 7: Manual verification**

(a) With at least one installed model for the current engine and `userConfig.model` empty, open a media task page → the model dropdown shows the first model selected automatically.
(b) Switch engine (builtin ↔ faster-whisper) in Resources, return to the task page → the selected model updates to one valid for the new engine.
(c) With no installed model, the config bar shows "Download a model" and clicking Start shows the "Please select a speech model first" toast (no task queued).

- [ ] **Step 8: Commit**

```bash
git add renderer/lib/engineModels.ts renderer/components/Models.tsx "renderer/pages/[locale]/tasks/[type].tsx" renderer/components/TaskControls.tsx renderer/public/locales/zh/home.json renderer/public/locales/en/home.json
git commit -m "feat(tasks): auto-select first model per engine and guard task start against empty model"
```

---

## Task 4: Embedded soft-subtitle marker (T3)

When the app extracts a video's embedded text subtitle directly (skipping audio extraction + ASR), mark the file so the task list can show a "captions" icon. Reuse the existing per-file metadata pattern (`taskFileChange` payload merges into renderer state via `{ ...file, ...res }`).

**Files:**

- Modify: `types/types.ts:14-31` (add `embeddedSubtitle?: boolean` to `IFiles`)
- Modify: `main/helpers/fileProcessor.ts` (set flag on embedded success; clear on ASR path)
- Modify: `renderer/components/tasks/TaskRowList.tsx` (render the icon)
- Modify: `renderer/public/locales/zh/tasks.json` + `en/tasks.json` (tooltip text)

- [ ] **Step 1: Add the field to `IFiles`**

In `types/types.ts`, add to the `IFiles` interface (after `whisperBackend?: string;`):

```ts
  /** 该文件走了内封软字幕直提（跳过抽音频 + ASR）：用于任务列表标识 */
  embeddedSubtitle?: boolean;
```

- [ ] **Step 2: Set the flag on the embedded-success path**

In `main/helpers/fileProcessor.ts`, the embedded-success branch sends `extractSubtitle: 'done'` (currently lines 276-279). Add `embeddedSubtitle: true` to that final event:

```ts
event.sender.send('taskFileChange', {
  ...file,
  extractSubtitle: 'done',
  embeddedSubtitle: true,
});
usedEmbedded = true;
```

- [ ] **Step 3: Clear the flag on the ASR path (retry correctness)**

Still in `fileProcessor.ts`, the ASR path begins by sending `extractAudio: 'loading'` (currently lines 302-305). Add `embeddedSubtitle: false` so a retry that falls back to ASR clears any stale marker in the renderer (which merges, so the key must be explicitly sent):

```ts
event.sender.send('taskFileChange', {
  ...file,
  extractAudio: 'loading',
  embeddedSubtitle: false,
});
```

- [ ] **Step 4: Render the captions icon in the row list**

In `renderer/components/tasks/TaskRowList.tsx`, add `Captions` to the lucide import block (top of file):

```tsx
import {
  Captions,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Edit2,
  FileUp,
  FolderOpen,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
```

Then, inside the filename container, render the icon after the filename Tooltip block and before the `meta` span. Replace this block (currently lines ~238-255):

```tsx
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default truncate text-sm font-medium min-w-0">
                        {file?.fileName}
                        {file?.fileExtension}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-md">
                      <p className="break-all">{file?.filePath}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {meta && (
```

with:

```tsx
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default truncate text-sm font-medium min-w-0">
                        {file?.fileName}
                        {file?.fileExtension}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-md">
                      <p className="break-all">{file?.filePath}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {file?.embeddedSubtitle && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex-shrink-0 text-primary">
                          <Captions className="h-3.5 w-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        {t('row.embeddedSubtitle')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {meta && (
```

- [ ] **Step 5: Add the tooltip i18n (zh + en)**

In `renderer/public/locales/zh/tasks.json`, inside the `"row"` object add a key:

```json
  "row": {
    "cancelling": "取消中…正在中断转写",
    "proofread": "校对",
    "openFolder": "打开所在文件夹",
    "retry": "重试",
    "remove": "移除",
    "embeddedSubtitle": "内封软字幕直提（已跳过听写/ASR）"
  },
```

In `renderer/public/locales/en/tasks.json`, inside `"row"`:

```json
  "row": {
    "cancelling": "Cancelling… interrupting transcription",
    "proofread": "Proofread",
    "openFolder": "Show in folder",
    "retry": "Retry",
    "remove": "Remove",
    "embeddedSubtitle": "Extracted from embedded subtitles"
  },
```

- [ ] **Step 6: Typecheck + i18n + engine gates**

Run: `npx tsc -p tsconfig.json` → exit 0.
Run: `node scripts/check-i18n.mjs` → parity OK.
Run: `npm run test:engines` → `0 failed` (fileProcessor is main-process code touched here).

- [ ] **Step 7: Manual verification**

Import an `.mkv`/`.mp4` that has an embedded **text** subtitle track, run `generate`. The row should show a small captions icon after the filename; hovering shows the tooltip. A normal ASR file (no embedded track) shows no icon. Retry a file that previously used embedded extraction but now goes ASR → icon disappears.

- [ ] **Step 8: Commit**

```bash
git add types/types.ts main/helpers/fileProcessor.ts renderer/components/tasks/TaskRowList.tsx renderer/public/locales/zh/tasks.json renderer/public/locales/en/tasks.json
git commit -m "feat(tasks): mark embedded soft-subtitle extraction with a captions icon"
```

---

## Task 5: VAD toggle in Advanced sheet (T5b)

Add a VAD switch to the Advanced sheet's recognition section (media tasks only). It reads/writes the **global** `settings.useVAD` directly (B1 passthrough) — same single source as the Settings page — with a concise explanation. Default stays ON.

**Files:**

- Modify: `renderer/components/tasks/AdvancedSheet.tsx` (state + switch UI)
- Modify: `renderer/public/locales/zh/tasks.json` + `en/tasks.json` (add `vad` block)

- [ ] **Step 1: Add state + load/save for global `useVAD`**

In `renderer/components/tasks/AdvancedSheet.tsx`, change the React import to include hooks:

```tsx
import React, { useEffect, useState } from 'react';
```

Inside the component (after the `const isMediaTask = ...` / `showFormatHere` lines), add:

```tsx
// VAD 是全局设置（settings.useVAD），与设置页同源；这里只是任务高级选项里的便捷入口。
// 不进 react-hook-form，避免与逐任务的 userConfig 混淆。
const [vadEnabled, setVadEnabled] = useState(true);
useEffect(() => {
  if (!open) return;
  let active = true;
  (async () => {
    const s = await window?.ipc?.invoke('getSettings');
    if (active) setVadEnabled(s?.useVAD !== false);
  })();
  return () => {
    active = false;
  };
}, [open]);
const handleVadChange = async (checked: boolean) => {
  setVadEnabled(checked);
  await window?.ipc?.invoke('setSettings', { useVAD: checked });
};
```

> `setSettings` merges (`{ ...preSettings, ...settings }` in `main/helpers/ipcStoreHandlers.ts`), so writing `{ useVAD }` updates only that field.

- [ ] **Step 2: Render the switch in the recognition section**

Still in `AdvancedSheet.tsx`, inside the `{isMediaTask && (` recognition block, add the VAD control after the `saveAudio` FormField (after its closing `/>`, before the block's closing `</>`):

```tsx
<div className="rounded-lg border p-2 space-y-2">
  <div className="flex flex-row items-center justify-between gap-2">
    <div className="space-y-0.5">
      <p className="text-sm font-medium">{t('vad.label')}</p>
      <p className="text-xs text-muted-foreground">
        {vadEnabled ? t('vad.on') : t('vad.off')}
      </p>
    </div>
    <Switch checked={vadEnabled} onCheckedChange={handleVadChange} />
  </div>
  <p className="text-xs text-muted-foreground">{t('vad.hint')}</p>
</div>
```

> `Switch` is already imported in `AdvancedSheet.tsx`. `t` is the `tasks` namespace translator already in scope.

- [ ] **Step 3: Add the `vad` i18n block (zh + en)**

In `renderer/public/locales/zh/tasks.json`, add a top-level `"vad"` object (e.g. right after the `"section"` object):

```json
  "vad": {
    "label": "语音活动检测（VAD）",
    "on": "更快更稳，减少静音/背景音处的重复或幻觉字幕；时间戳可能略有偏差。",
    "off": "时间戳更贴合语音；但静音/音乐处可能产生重复或幻觉字幕。",
    "hint": "需要严格的字幕时间轴对齐时可关闭。此为全局设置，对所有任务生效。"
  },
```

In `renderer/public/locales/en/tasks.json`, add the matching block at the same place:

```json
  "vad": {
    "label": "Voice activity detection (VAD)",
    "on": "Faster and steadier; fewer repeated/hallucinated lines over silence or background noise. Timestamps may be slightly off.",
    "off": "Timestamps hug the speech more closely, but silence/music may produce repeated or hallucinated lines.",
    "hint": "Turn off when you need strict subtitle timing. This is a global setting and affects all tasks."
  },
```

- [ ] **Step 4: Typecheck + i18n gate**

Run: `npx tsc -p tsconfig.json` → exit 0.
Run: `node scripts/check-i18n.mjs` → parity OK.

- [ ] **Step 5: Manual verification**

Open a media task → Advanced → recognition section shows the VAD switch defaulting to the global value. Toggle it, reopen the Settings page → the global VAD reflects the change (and vice versa). The description line updates between on/off text.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/tasks/AdvancedSheet.tsx renderer/public/locales/zh/tasks.json renderer/public/locales/en/tasks.json
git commit -m "feat(tasks): add global VAD toggle with tradeoff hints to advanced options"
```

---

## Task 6: List / grid task view (T4)

Add a global, persistent List/Grid toggle on the task page. The grid renders thumbnail cards: videos use the existing `media://` protocol as a static `<video>` cover (`#t=1`, zero ffmpeg), audio/subtitle/undecodable files fall back to a large type icon. The grid card also shows the embedded-subtitle badge from Task 4. **Depends on Task 4** (the `embeddedSubtitle` field).

**Files:**

- Modify: `main/helpers/store/types.ts:23-55` (add `taskViewMode`) and `main/helpers/store/index.ts:15-38` (default)
- Modify: `renderer/components/tasks/stageUtils.ts` (export `formatBytes` + `formatMediaDuration`)
- Modify: `renderer/components/tasks/TaskRowList.tsx` (import the two formatters instead of local copies)
- Create: `renderer/components/tasks/TaskGridList.tsx`
- Modify: `renderer/pages/[locale]/tasks/[type].tsx` (view state + toggle + conditional render)
- Modify: `renderer/public/locales/zh/tasks.json` + `en/tasks.json` (add `view` block)

- [ ] **Step 1: Add `taskViewMode` to the store type**

In `main/helpers/store/types.ts`, inside the `settings` object type, add (e.g. after `proxyNoProxy?: string;`):

```ts
    /** 任务列表视图：list=列表，grid=网格（全局统一，跨重启保留） */
    taskViewMode?: 'list' | 'grid';
```

- [ ] **Step 2: Add the default**

In `main/helpers/store/index.ts`, inside `defaults.settings`, add (e.g. after `proxyMode: 'none' as const,`):

```ts
      taskViewMode: 'list' as const,
```

- [ ] **Step 3: Extract the two formatters into `stageUtils.ts` (DRY)**

In `renderer/components/tasks/stageUtils.ts`, add these exported helpers (used by both row and grid views):

```ts
/** 字节数转人类可读（如 1.5 MB）；无效值返回空串 */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 秒转 h:mm:ss / m:ss；无效值返回空串 */
export function formatMediaDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
```

- [ ] **Step 4: Make `TaskRowList.tsx` import the shared formatters**

In `renderer/components/tasks/TaskRowList.tsx`, delete the two local functions `formatBytes` (lines ~45-55) and `formatMediaDuration` (lines ~57-65), and add them to the existing `stageUtils` import:

```tsx
import {
  getFileStages,
  getStageStatus,
  getFilePercent,
  getFileError,
  hasFileError,
  isProofreadReady,
  getRevealPath,
  formatBytes,
  formatMediaDuration,
  type StageDef,
} from './stageUtils';
```

- [ ] **Step 5: Create `TaskGridList.tsx`**

Create `renderer/components/tasks/TaskGridList.tsx` with the full component below. It reuses `stageUtils` and replicates the row's empty state + actions so it works standalone:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  Captions,
  CheckCircle2,
  CircleAlert,
  Clapperboard,
  Edit2,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  Music,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn, isSubtitleFile, isAudioPath } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import {
  getFileStages,
  getStageStatus,
  getFilePercent,
  getFileError,
  hasFileError,
  isProofreadReady,
  getRevealPath,
  formatBytes,
  formatMediaDuration,
  type StageDef,
} from './stageUtils';

interface TaskGridListProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  onProofread: (file: any) => void;
  onDelete: (uuid: string) => void;
  onRetry: (file: any) => void;
}

// 仅在卡片进入视口时挂载 <video>，限制同时存在的解码器数量
function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);
  return { ref, inView };
}

function Cover({ file }: { file: any }) {
  const filePath = file?.filePath || '';
  const isSub = isSubtitleFile(filePath);
  const isAudio = isAudioPath(filePath);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>();

  let Icon = Clapperboard;
  if (isSub) Icon = FileText;
  else if (isAudio) Icon = Music;

  // 仅视频且未解码失败时用 <video> 静态封面；其余/失败用类型大图标
  const showVideo = !isSub && !isAudio && !decodeFailed;

  return (
    <div
      ref={ref}
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted"
    >
      {showVideo && inView ? (
        <video
          src={`media://${encodeURIComponent(filePath)}#t=1`}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
          onError={() => setDecodeFailed(true)}
          onLoadedMetadata={(e) => {
            // 部分容器（mkv/ts/hevc 等）Chromium 解不出画面：videoWidth=0 → 退回图标
            if ((e.currentTarget.videoWidth || 0) === 0) setDecodeFailed(true);
          }}
        />
      ) : (
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      )}
    </div>
  );
}

const TaskGridList: React.FC<TaskGridListProps> = ({
  files,
  typeDef,
  formData,
  taskStatus,
  onProofread,
  onDelete,
  onRetry,
}) => {
  const { t } = useTranslation('tasks');
  const queueBusy =
    taskStatus === 'running' ||
    taskStatus === 'paused' ||
    taskStatus === 'cancelling';

  const handleImport = () => {
    const fileType = typeDef.accepts === 'subtitle' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleOpenFolder = (file: any) => {
    const filePath = getRevealPath(file);
    if (filePath) {
      window?.ipc?.invoke('subtitleMerge:openOutputFolder', { filePath });
    }
  };

  if (!files.length) {
    return (
      <div
        className="flex flex-col cursor-pointer items-center justify-center h-[360px] border-2 border-dashed rounded-lg p-8"
        onClick={handleImport}
      >
        <FileUp className="w-14 h-14 text-muted-foreground/50 mb-4" />
        <p className="text-base text-center text-muted-foreground mb-1">
          {typeDef.accepts === 'subtitle'
            ? t('empty.dragSubtitle')
            : t('empty.dragMedia')}
        </p>
        <p className="text-xs text-center text-muted-foreground/70">
          {typeDef.accepts === 'subtitle'
            ? t('empty.subtitleFormats')
            : t('empty.mediaFormats')}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {files.map((file) => {
        const stages: StageDef[] = getFileStages(file, typeDef, formData);
        const percent = getFilePercent(file, stages);
        const failed = hasFileError(file, stages);
        const rawError = failed ? getFileError(file, stages) : '';
        const errorMsg =
          rawError === 'TASK_INTERRUPTED' ? t('interrupted') : rawError;
        const started = stages.some(
          (s) => getStageStatus(file, s.key) !== 'pending',
        );
        const meta = [
          formatBytes(file?.fileSize),
          formatMediaDuration(file?.duration),
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <div
            key={file?.uuid}
            className={cn(
              'group relative flex flex-col gap-2 rounded-lg border p-2 transition-colors hover:bg-muted/40',
              failed && 'border-destructive/30',
            )}
          >
            <div className="relative">
              <Cover file={file} />
              {file?.embeddedSubtitle && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="absolute left-1 top-1 inline-flex items-center rounded bg-background/80 p-0.5 text-primary backdrop-blur">
                        <Captions className="h-3.5 w-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      {t('row.embeddedSubtitle')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <button
                type="button"
                aria-label={t('row.remove')}
                className="absolute right-1 top-1 rounded bg-background/80 p-0.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-destructive group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                disabled={queueBusy}
                onClick={() => onDelete(file?.uuid)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default truncate text-xs font-medium">
                    {file?.fileName}
                    {file?.fileExtension}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-md">
                  <p className="break-all">{file?.filePath}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {meta && (
              <span className="text-[11px] text-muted-foreground">{meta}</span>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {stages.map((stage) => {
                const status = getStageStatus(file, stage.key);
                return (
                  <span
                    key={stage.key}
                    className={cn(
                      'inline-flex items-center gap-1 text-[11px] whitespace-nowrap',
                      status === 'pending' && 'text-muted-foreground/60',
                      status === 'loading' && 'text-primary font-medium',
                      status === 'done' && 'text-success',
                      status === 'error' && 'text-destructive font-medium',
                    )}
                  >
                    {status === 'loading' && (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    {status === 'done' && <CheckCircle2 className="h-3 w-3" />}
                    {status === 'error' && <CircleAlert className="h-3 w-3" />}
                    {t(stage.labelKey)}
                  </span>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <Progress value={percent} className="h-1.5" />
              <span className="w-[34px] text-right text-[11px] tabular-nums text-muted-foreground">
                {started ? `${percent}%` : '--'}
              </span>
            </div>

            {failed && errorMsg && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="cursor-default truncate text-xs text-destructive">
                      {errorMsg}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-md">
                    <p className="break-all">{errorMsg}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            <div className="mt-auto flex items-center justify-end gap-1">
              {failed && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={queueBusy}
                  onClick={() => onRetry(file)}
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('row.retry')}
                </Button>
              )}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={t('row.proofread')}
                      disabled={!isProofreadReady(file, typeDef)}
                      onClick={() => onProofread(file)}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('row.proofread')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={t('row.openFolder')}
                      onClick={() => handleOpenFolder(file)}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('row.openFolder')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default TaskGridList;
```

- [ ] **Step 6: Wire view state + toggle into the task page**

In `renderer/pages/[locale]/tasks/[type].tsx`:

(a) Add imports near the other component imports:

```tsx
import TaskGridList from '@/components/tasks/TaskGridList';
import { LayoutGrid, List } from 'lucide-react';
```

(b) Add the view-mode state near the other `useState` declarations (e.g. after `const [isDragging, setIsDragging] = useState(false);`):

```tsx
const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
```

(c) Load the persisted view mode in the existing `load()` effect (the one that sets providers + `useLocalWhisper`, lines ~100-110). Extend it:

```tsx
useEffect(() => {
  const load = async () => {
    const storedProviders = await window?.ipc?.invoke(
      'getTranslationProviders',
    );
    setProviders(storedProviders || []);
    const settings = await window?.ipc?.invoke('getSettings');
    setUseLocalWhisper(settings?.useLocalWhisper || false);
    if (
      settings?.taskViewMode === 'grid' ||
      settings?.taskViewMode === 'list'
    ) {
      setViewMode(settings.taskViewMode);
    }
  };
  load();
}, []);
```

(d) Add a persisting toggle handler (near the other handlers, e.g. after `handleStatusChange`):

```tsx
const handleViewModeChange = useCallback((mode: 'list' | 'grid') => {
  setViewMode(mode);
  window?.ipc?.invoke('setSettings', { taskViewMode: mode });
}, []);
```

(e) Add the toggle buttons to the header action group — inside the `<div className="flex items-center gap-2 flex-shrink-0">` that holds Import / Clear / Advanced (after the `Import` button, before `Clear list`):

```tsx
<div className="flex items-center rounded-md border p-0.5">
  <Button
    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
    size="icon"
    className="h-7 w-7"
    aria-label={t('view.list')}
    onClick={() => handleViewModeChange('list')}
  >
    <List className="h-3.5 w-3.5" />
  </Button>
  <Button
    variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
    size="icon"
    className="h-7 w-7"
    aria-label={t('view.grid')}
    onClick={() => handleViewModeChange('grid')}
  >
    <LayoutGrid className="h-3.5 w-3.5" />
  </Button>
</div>
```

(f) Conditionally render the list vs grid. Replace the `<TaskRowList ... />` block (inside the `<ScrollArea>`, lines ~542-552) with:

```tsx
{
  viewMode === 'grid' ? (
    <TaskGridList
      files={files}
      typeDef={typeDef}
      formData={formData}
      taskStatus={taskStatus}
      onProofread={(file) => setProofreadFile(file)}
      onDelete={(uuid) =>
        setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
      }
      onRetry={handleRetry}
    />
  ) : (
    <TaskRowList
      files={files}
      typeDef={typeDef}
      formData={formData}
      taskStatus={taskStatus}
      onProofread={(file) => setProofreadFile(file)}
      onDelete={(uuid) =>
        setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
      }
      onRetry={handleRetry}
    />
  );
}
```

> `useCallback` is already imported in this file; `LayoutGrid`/`List` are new lucide imports.

- [ ] **Step 7: Add the `view` i18n block (zh + en)**

In `renderer/public/locales/zh/tasks.json` add a top-level `"view"` object (e.g. after `"taskCount"`):

```json
  "view": {
    "list": "列表视图",
    "grid": "网格视图"
  },
```

In `renderer/public/locales/en/tasks.json`:

```json
  "view": {
    "list": "List view",
    "grid": "Grid view"
  },
```

- [ ] **Step 8: Typecheck + i18n gate**

Run: `npx tsc -p tsconfig.json` → exit 0 (verify no leftover references to the removed local formatters in `TaskRowList.tsx`).
Run: `node scripts/check-i18n.mjs` → parity OK.

- [ ] **Step 9: Manual verification**

Toggle List/Grid in the header; confirm the choice persists across app restart (global `settings.taskViewMode`). In grid mode: an `.mp4` shows a real first-frame cover; an `.mkv`/`.ts` (Chromium can't decode) shows the `Clapperboard` icon; an audio file shows `Music`; a subtitle file shows `FileText`. Embedded-subtitle files show the captions badge top-left. Delete/retry/proofread/open-folder work the same as the list. Scrolling a large list only mounts `<video>` for cards near the viewport.

- [ ] **Step 10: Commit**

```bash
git add main/helpers/store/types.ts main/helpers/store/index.ts renderer/components/tasks/stageUtils.ts renderer/components/tasks/TaskRowList.tsx renderer/components/tasks/TaskGridList.tsx "renderer/pages/[locale]/tasks/[type].tsx" renderer/public/locales/zh/tasks.json renderer/public/locales/en/tasks.json
git commit -m "feat(tasks): add list/grid task view with media:// thumbnails and type-icon fallback"
```

---

## Final Verification

After all six tasks:

- [ ] `npx tsc -p tsconfig.json` → exit 0
- [ ] `npm run test:engines` → `0 failed`
- [ ] `node scripts/check-i18n.mjs` → zh/en parity OK
- [ ] Walk the per-task manual matrices once end-to-end in `npm run dev`.
