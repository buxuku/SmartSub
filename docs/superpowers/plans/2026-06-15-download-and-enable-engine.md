# Download-and-Enable Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per project rule, do NOT dispatch subagents — execute inline.)

**Goal:** After a first-time faster-whisper install finishes and passes cold-start detection, automatically set it as the current engine (when idle); rename the install button to "Download & enable". Upgrade / repair / busy never switch.

**Architecture:** Single renderer component change (`EnginesTab.tsx`) plus i18n. Intent is marked at each download entry point via a `pendingActivateRef`; the `completed` progress handler, after a successful `python-engine:ping`, reuses the existing `set-transcription-engine` IPC to activate. Busy state is read through a `taskBusyRef` (the progress listener's closure holds a stale `taskBusy`). No main-process change.

**Tech Stack:** TypeScript, React 18 (refs), Next.js (nextron), Electron IPC, next-i18next, sonner (toast).

---

## Spec

Design: `docs/superpowers/specs/2026-06-15-download-and-enable-engine-design.md`. Read it before starting.

## Testing Reality (read first)

This repo has **no React component test runner** and is **not tsc-clean at baseline**. Use these scoped gates (run from repo root):

1. **Renderer typecheck** (for `renderer/**` changes):
   ```bash
   npx tsc -p renderer/tsconfig.json --noEmit --incremental false 2>&1 | grep "error TS" > /tmp/rtsc.txt; wc -l < /tmp/rtsc.txt
   ```
   Baseline ≈ **184** pre-existing errors (all in `__tests__/**` and parameter-config files). **Gate:** count stays ≤ 184 **and** `EnginesTab` must not appear:
   ```bash
   grep -E "EnginesTab" /tmp/rtsc.txt   # must print nothing
   ```
2. **i18n parity gate** (for any locale change):
   ```bash
   node scripts/check-i18n.mjs   # no missing/extra keys
   ```
3. **Manual matrix:** the steps in each task.

## Task Order & Dependencies

1. Task 1 — i18n strings (so the component can reference `downloadedBusyHint`).
2. Task 2 — `EnginesTab.tsx` logic (depends on Task 1's key).

---

## Task 1: i18n — rename install button + add busy hint

Rename the existing `download` value to "Download & enable" and add a new `downloadedBusyHint` used when a task is running at completion time. Keys must stay zh/en parallel.

**Files:**

- Modify: `renderer/public/locales/zh/resources.json` (the `engines.fasterWhisper` block, around the `download` key)
- Modify: `renderer/public/locales/en/resources.json` (same)

- [ ] **Step 1: Edit the zh strings**

In `renderer/public/locales/zh/resources.json`, find:

```json
      "download": "下载引擎（约 {{size}}）",
      "downloading": "下载中…",
```

Replace with (change `download` value, insert `downloadedBusyHint` after it):

```json
      "download": "下载并启用（约 {{size}}）",
      "downloadedBusyHint": "引擎已下载完成；当前有任务在运行，结束后可在此「设为当前引擎」。",
      "downloading": "下载中…",
```

- [ ] **Step 2: Edit the en strings**

In `renderer/public/locales/en/resources.json`, find:

```json
      "download": "Download engine (~{{size}})",
      "downloading": "Downloading…",
```

Replace with:

```json
      "download": "Download & enable (~{{size}})",
      "downloadedBusyHint": "Engine downloaded. A task is running — you can set it as current here once it finishes.",
      "downloading": "Downloading…",
```

- [ ] **Step 3: i18n parity gate**

Run: `node scripts/check-i18n.mjs`
Expected: no missing/extra keys (both locales gained `engines.fasterWhisper.downloadedBusyHint`).

- [ ] **Step 4: Commit**

```bash
git add renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "i18n(engines): rename download CTA to 'download & enable' + add busy hint"
```

---

## Task 2: EnginesTab — auto-enable on first install when idle

Add `pendingActivateRef` (intent) and `taskBusyRef` (fresh busy state), mark intent at each entry point, and extend the `completed` branch to activate via `set-transcription-engine` after a successful ping when idle.

**Files:**

- Modify: `renderer/components/resources/EnginesTab.tsx` (import, refs, refresh + listener busy sync, entry-point marking, completed branch)

- [ ] **Step 1: Import `useRef`**

In `renderer/components/resources/EnginesTab.tsx`, change line 1:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
```

to:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 2: Declare the two refs**

After the `verifying` state declaration (currently line 102, `const [verifying, setVerifying] = useState(false);`), add:

```tsx
// 「下载并启用」意图：在各下载入口显式置位，区分安装(true)与升级/修复(false)。
const pendingActivateRef = useRef(false);
// 任务忙碌的最新值：下载进度监听器闭包里的 taskBusy 是旧值，改读这个 ref。
const taskBusyRef = useRef(false);
```

- [ ] **Step 3: Sync `taskBusyRef` in `refresh()`**

In `refresh()`, find (currently line 131):

```tsx
setTaskBusy(isQueueBusy(taskStatus));
```

Replace with:

```tsx
const busy = isQueueBusy(taskStatus);
setTaskBusy(busy);
taskBusyRef.current = busy;
```

- [ ] **Step 4: Sync `taskBusyRef` in the `taskStatusChange` listener**

Find (currently lines 167-169):

```tsx
const unsubTask = window?.ipc?.on('taskStatusChange', (status: string) => {
  setTaskBusy(isQueueBusy(status));
});
```

Replace with:

```tsx
const unsubTask = window?.ipc?.on('taskStatusChange', (status: string) => {
  const busy = isQueueBusy(status);
  setTaskBusy(busy);
  taskBusyRef.current = busy;
});
```

- [ ] **Step 5: Rewrite the `completed` branch to auto-activate**

Find the `completed` branch (currently lines 143-158):

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

Replace with:

```tsx
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需冷启动校验（PyInstaller 首帧加载），期间保持「检测中」，
          // 避免用户以为卡住没反应、且能挡住下载/修复按钮被重复点击。
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          (async () => {
            let pingOk = false;
            try {
              const r = await window?.ipc?.invoke('python-engine:ping');
              pingOk = !!r?.success;
            } catch {
              // 校验失败：忽略错误，交给 refresh() 反映真实状态（broken → 显示修复入口）
            } finally {
              await refresh();
              setVerifying(false);
            }
            // 下载并启用：仅首次安装意图(pendingActivate) + 检测通过(pingOk) 时生效。
            // 任务运行中不切换，仅提示；否则自动设为当前引擎（含 sidecar 预热）。
            if (pendingActivateRef.current && pingOk) {
              if (taskBusyRef.current) {
                toast(t('engines.fasterWhisper.downloadedBusyHint'));
              } else {
                const res = await window?.ipc?.invoke(
                  'set-transcription-engine',
                  'fasterWhisper',
                );
                if (res?.success) {
                  setCurrentEngine('fasterWhisper');
                  window.dispatchEvent(
                    new CustomEvent('transcription-engine-changed'),
                  );
                }
              }
            }
            pendingActivateRef.current = false;
          })();
        } else if (_progress.status === 'error') {
```

- [ ] **Step 6: Mark intent in `handleSelectEngine` (`engine_not_installed` path = install)**

Find (currently lines 199-202):

```tsx
if (result?.error === 'engine_not_installed') {
  setShowDownloadConfirm(true);
  return;
}
```

Replace with:

```tsx
if (result?.error === 'engine_not_installed') {
  // 用户本就在点「设为当前」→ 下载完成后应自动启用
  pendingActivateRef.current = true;
  setShowDownloadConfirm(true);
  return;
}
```

- [ ] **Step 7: Mark intent = false in `handleUpgrade`**

Find the start of `handleUpgrade` (currently lines 258-260):

```tsx
  const handleUpgrade = async () => {
    setShowUpgradeConfirm(false);
    const source = binarySource;
```

Replace with:

```tsx
  const handleUpgrade = async () => {
    // 升级不切换当前引擎；显式清除可能残留的安装意图（如先开了安装确认又取消）
    pendingActivateRef.current = false;
    setShowUpgradeConfirm(false);
    const source = binarySource;
```

- [ ] **Step 8: Mark intent on the install button (true) and repair button (false)**

Find the install button onClick (currently line 677):

```tsx
                        onClick={() => setShowDownloadConfirm(true)}
```

This exact line appears **twice** (install + repair). Disambiguate by surrounding context.

Install button — it sits inside `{!fasterInstalled && !isDownloading && !fasterBroken && !showVerifying && (` and uses the `Download` icon + `download` label. Replace its onClick with:

```tsx
                        onClick={() => {
                          pendingActivateRef.current = true;
                          setShowDownloadConfirm(true);
                        }}
```

Repair button — it sits inside `{fasterBroken && (` and uses the `RefreshCw` icon + `repair` label. Replace its onClick with:

```tsx
                      onClick={() => {
                        pendingActivateRef.current = false;
                        setShowDownloadConfirm(true);
                      }}
```

> If `StrReplace` reports the old string is not unique, include the button's surrounding lines (the `<Button ...>` open through the icon line) in the match so each replacement targets the right button.

- [ ] **Step 9: Renderer typecheck gate**

Run:

```bash
npx tsc -p renderer/tsconfig.json --noEmit --incremental false 2>&1 | grep "error TS" > /tmp/rtsc.txt; wc -l < /tmp/rtsc.txt
grep -E "EnginesTab" /tmp/rtsc.txt
```

Expected: count ≤ 184; the second `grep` prints nothing.

- [ ] **Step 10: Manual verification**

In `npm run dev`:

- (a) Uninstall faster-whisper (if installed), ensure no task running → click **下载并启用**. After progress → 检测中 → 可用, the card flips to **使用中** automatically and the header engine indicator switches to faster-whisper.
- (b) From a non-current state click **设为当前引擎** on an uninstalled engine → confirm download → after completion it becomes current.
- (c) Start a builtin task, then (while it runs) install faster-whisper → on completion it does **not** switch; a toast shows the busy hint; after the task finishes you can set it current manually.
- (d) With faster-whisper installed, click **升级** → after completion the current engine is unchanged.
- (e) Force a broken state and click **修复** → after completion the current engine is unchanged.

- [ ] **Step 11: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx
git commit -m "feat(engines): auto-enable faster-whisper after first install when idle (download & enable)"
```

---

## Final Verification

- [ ] `npx tsc -p renderer/tsconfig.json --noEmit --incremental false` → EnginesTab absent from errors, count ≤ 184
- [ ] `node scripts/check-i18n.mjs` → zh/en parity OK
- [ ] Walk the Task 2 manual matrix once end-to-end in `npm run dev`
