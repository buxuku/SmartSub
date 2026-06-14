# Download Core Unification Implementation Plan (item 4 · Option C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicated download plumbing between `AddonDownloader` and `PyEngineDownloader` by extracting one shared, well-tested core (URL resolution, version compare, and the resumable mirror downloader) — a **behavior-preserving** refactor with no change to download UX, IPC, release artifacts, or the sidecar protocol.

**Architecture:** New `main/helpers/download/` holds three units: `sources.ts` (`resolveReleaseBaseUrl`, replacing two base-URL maps — preserving the different gitcode repo slugs), `versionCompare.ts` (`compareDateVersion`), and `mirrorDownloader.ts` (`MirrorDownloader`: progress math, multi-source fallback loop, and the resumable single-file download with Range/redirect/206/inactivity-timeout/abort). The two downloader classes become thin adapters that keep their exact public APIs, IPC channels, progress fields, and resume-state file shapes, delegating the shared mechanics to the core and keeping only their distinct install semantics (addon = extract; py = verify-checksum → staging → safe swap + preflight).

**Tech Stack:** Electron main process, Node `https`/`http`/`fs`/`tar`, `@tanstack`-free. Tests via `yarn test:engines` (pure logic); critical paths verified by a manual download matrix.

**Spec:** `docs/superpowers/specs/2026-06-14-ui-polish-and-infra-analysis-design.md` §4.1.

> **Why verbatim, not rewrite:** `AddonDownloader.downloadFile` (`addonDownloader.ts:382-567`) and `PyEngineDownloader.downloadFile` (`downloader.ts:628-803`) are byte-for-byte equivalent. The core's `downloadFile` is a verbatim copy of that logic with `this.abortController` owned by the core and state-persistence injected via a hook — this minimizes regression risk.

---

## File Structure

- Create: `main/helpers/download/sources.ts` — `resolveReleaseBaseUrl(source, slugs, tag)`.
- Create: `main/helpers/download/versionCompare.ts` — `normalizeDateVersion`, `compareDateVersion`.
- Create: `main/helpers/download/mirrorDownloader.ts` — `MirrorDownloader` core.
- Modify: `main/helpers/addonDownloader.ts` — use `resolveReleaseBaseUrl`; delegate download mechanics to the core.
- Modify: `main/helpers/pythonRuntime/paths.ts` — use `resolveReleaseBaseUrl`.
- Modify: `main/helpers/pythonRuntime/downloader.ts` — delegate download mechanics to the core.
- Modify: `main/helpers/addonVersions.ts` — use `compareDateVersion`.
- Modify: `scripts/test-engine-units.ts` — unit tests for `resolveReleaseBaseUrl`, `compareDateVersion`, and core progress math.

---

## Task 1: Shared URL resolution (`sources.ts`) — TDD

**Files:**

- Create: `main/helpers/download/sources.ts`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: Write the failing test**

In `scripts/test-engine-units.ts`, add the import after the `downloadSourceOrder` import (currently `:25-28`):

```ts
import { resolveReleaseBaseUrl } from '../main/helpers/download/sources';
```

Add these assertions before the final `console.log` (currently `:165`). The expected strings are the exact current outputs (addon `DOWNLOAD_SOURCES` without trailing slash; py `getPyEngineReleaseBaseUrl`):

```ts
// --- resolveReleaseBaseUrl (addon slugs: gitcode repo differs!) ---
const ADDON = { github: 'buxuku/whisper.cpp', gitcode: 'buxuku1/whisper.node' };
eq(
  resolveReleaseBaseUrl('github', ADDON, 'latest'),
  'https://github.com/buxuku/whisper.cpp/releases/download/latest',
  'url: addon github',
);
eq(
  resolveReleaseBaseUrl('ghproxy', ADDON, 'latest'),
  'https://ghfast.top/https://github.com/buxuku/whisper.cpp/releases/download/latest',
  'url: addon ghproxy',
);
eq(
  resolveReleaseBaseUrl('gitcode', ADDON, 'latest'),
  'https://gitcode.com/buxuku1/whisper.node/releases/download/latest',
  'url: addon gitcode (different repo slug)',
);
// --- resolveReleaseBaseUrl (py slugs) ---
const PY = {
  github: 'buxuku/smartsub-py-engine',
  gitcode: 'buxuku1/smartsub-py-engine',
};
eq(
  resolveReleaseBaseUrl('github', PY, 'latest'),
  'https://github.com/buxuku/smartsub-py-engine/releases/download/latest',
  'url: py github',
);
eq(
  resolveReleaseBaseUrl('ghproxy', PY, 'latest'),
  'https://ghfast.top/https://github.com/buxuku/smartsub-py-engine/releases/download/latest',
  'url: py ghproxy',
);
eq(
  resolveReleaseBaseUrl('gitcode', PY, 'latest'),
  'https://gitcode.com/buxuku1/smartsub-py-engine/releases/download/latest',
  'url: py gitcode',
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:engines`
Expected: FAIL — tsc: "Cannot find module '../main/helpers/download/sources'".

- [ ] **Step 3: Create `sources.ts`**

Create `main/helpers/download/sources.ts`:

```ts
import type { BinaryDownloadSource } from '../../../types/addon';

/** 同一发布物在 GitHub 与 GitCode 上的仓库 slug 往往不同，必须分开声明。 */
export interface ReleaseRepoSlugs {
  github: string;
  gitcode: string;
}

/**
 * 统一解析某下载源下的 release 基础 URL（不含末尾斜杠）。
 * - github:  https://github.com/{slugs.github}/releases/download/{tag}
 * - ghproxy: https://ghfast.top/<github url>
 * - gitcode: https://gitcode.com/{slugs.gitcode}/releases/download/{tag}
 */
export function resolveReleaseBaseUrl(
  source: BinaryDownloadSource,
  slugs: ReleaseRepoSlugs,
  tag: string,
): string {
  if (source === 'gitcode') {
    return `https://gitcode.com/${slugs.gitcode}/releases/download/${tag}`;
  }
  const github = `https://github.com/${slugs.github}/releases/download/${tag}`;
  return source === 'ghproxy' ? `https://ghfast.top/${github}` : github;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:engines`
Expected: PASS — `... passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add main/helpers/download/sources.ts scripts/test-engine-units.ts
git commit -m "feat(download): add shared resolveReleaseBaseUrl with parity tests"
```

---

## Task 2: Wire `resolveReleaseBaseUrl` into addon + py URL builders

**Files:**

- Modify: `main/helpers/addonDownloader.ts:24-34,113-121`
- Modify: `main/helpers/pythonRuntime/paths.ts:177-189`

- [ ] **Step 1: Replace addon `DOWNLOAD_SOURCES` with the shared resolver**

In `main/helpers/addonDownloader.ts`, add the import after the `getSourceFallbackOrder` import (currently `:19`):

```ts
import { getSourceFallbackOrder } from './downloadSourceOrder';
import { resolveReleaseBaseUrl } from './download/sources';
```

Replace the `DOWNLOAD_SOURCES` const + `getAddonVersionsUrl` (currently `:21-34`):

```ts
/**
 * 加速包发布仓库（注意：GitCode 镜像用的是 whisper.node 仓库，与 GitHub 不同）。
 */
const ADDON_REPO_SLUGS = {
  github: 'buxuku/whisper.cpp',
  gitcode: 'buxuku1/whisper.node',
};

/** addon release 基础 URL（保留末尾斜杠，兼容旧的拼接方式）。 */
function addonBaseUrl(source: DownloadSource): string {
  return `${resolveReleaseBaseUrl(source, ADDON_REPO_SLUGS, 'latest')}/`;
}

/** addon-versions.json 的下载地址（按源） */
export function getAddonVersionsUrl(source: DownloadSource): string {
  return `${addonBaseUrl(source)}addon-versions.json`;
}
```

- [ ] **Step 2: Update addon `getDownloadUrl`**

Replace the body of `getDownloadUrl` (currently `:113-121`) so it uses `addonBaseUrl`:

```ts
export function getDownloadUrl(
  source: DownloadSource,
  variant: AddonVariant,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const baseUrl = addonBaseUrl(source);
  const fileName = getAddonFileName(variant, downloadType);
  return `${baseUrl}${fileName}`;
}
```

- [ ] **Step 3: Replace py `getPyEngineReleaseBaseUrl`**

In `main/helpers/pythonRuntime/paths.ts`, add an import near the top (after the `PyEngineManifest` type import, currently `:4`):

```ts
import { resolveReleaseBaseUrl } from '../download/sources';
```

Replace the `PY_ENGINE_GITCODE_BASE` const + `getPyEngineReleaseBaseUrl` (currently `:177-189`):

```ts
/** GitCode 镜像 owner 与 GitHub 不同（buxuku1），repo 名相同。 */
const PY_ENGINE_REPO_SLUGS = {
  github: PY_ENGINE_REPO,
  gitcode: 'buxuku1/smartsub-py-engine',
};

function getPyEngineReleaseBaseUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return resolveReleaseBaseUrl(source, PY_ENGINE_REPO_SLUGS, tag);
}
```

- [ ] **Step 4: Typecheck + parity tests still green**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.
Run: `yarn test:engines`
Expected: PASS (parity assertions from Task 1 still hold — they test `resolveReleaseBaseUrl` directly).

- [ ] **Step 5: Commit**

```bash
git add main/helpers/addonDownloader.ts main/helpers/pythonRuntime/paths.ts
git commit -m "refactor(download): route addon + py base URLs through resolveReleaseBaseUrl"
```

---

## Task 3: Shared version compare (`versionCompare.ts`) — TDD

**Files:**

- Create: `main/helpers/download/versionCompare.ts`
- Test: `scripts/test-engine-units.ts`
- Modify: `main/helpers/addonVersions.ts:126-133,166-169,206-208`

- [ ] **Step 1: Write the failing test**

In `scripts/test-engine-units.ts`, add the import (after the `sources` import from Task 1):

```ts
import { compareDateVersion } from '../main/helpers/download/versionCompare';
```

Add assertions before the final `console.log`:

```ts
// --- compareDateVersion (normalizes '-' and '.') ---
eq(compareDateVersion('2026.06.10', '2026-06-10'), 0, 'ver: dot vs dash equal');
eq(compareDateVersion('2026.06.11', '2026.06.10'), 1, 'ver: newer day');
eq(compareDateVersion('2026.06.10', '2026.06.11'), -1, 'ver: older day');
eq(compareDateVersion('2027.01.01', '2026.12.31'), 1, 'ver: cross year');
eq(compareDateVersion('2026.06.10', '2026.06.10'), 0, 'ver: equal');
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:engines`
Expected: FAIL — "Cannot find module '../main/helpers/download/versionCompare'".

- [ ] **Step 3: Create `versionCompare.ts`**

Create `main/helpers/download/versionCompare.ts`:

```ts
/**
 * 统一日期版本比较（addon 与（未来）py 共用）。
 * 把分隔符归一为点号后按字符串比较，适配 YYYY.MM.DD / YYYY-MM-DD。
 */
export function normalizeDateVersion(version: string): string {
  return version.replace(/-/g, '.');
}

/** a<b → -1；a>b → 1；相等 → 0 */
export function compareDateVersion(a: string, b: string): number {
  const na = normalizeDateVersion(a);
  const nb = normalizeDateVersion(b);
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:engines`
Expected: PASS.

- [ ] **Step 5: Use it in `addonVersions.ts`**

In `main/helpers/addonVersions.ts`, add the import after the `getSourceFallbackOrder` import (currently `:23`):

```ts
import { compareDateVersion } from './download/versionCompare';
```

Delete the local `normalizeVersion` function (currently `:126-133`). Then change the comparison in `checkVersionUpdate` (currently `:166-169`) from:

```ts
// 标准化版本号格式后再比较，避免 "2026.02.06" vs "2026-02-06" 因分隔符不同导致误判
const normalizedRemote = normalizeVersion(remoteInfo.version);
const normalizedLocal = normalizeVersion(installedInfo.remoteVersion);
const hasUpdate = normalizedRemote > normalizedLocal;
```

to:

```ts
// 统一日期版本比较，避免 "2026.02.06" vs "2026-02-06" 因分隔符不同导致误判
const hasUpdate =
  compareDateVersion(remoteInfo.version, installedInfo.remoteVersion) > 0;
```

And change the builtin-vulkan comparison (currently `:206-208`) from:

```ts
const hasUpdate =
  normalizeVersion(remoteVulkan.version) > normalizeVersion(builtinVersion);
```

to:

```ts
const hasUpdate = compareDateVersion(remoteVulkan.version, builtinVersion) > 0;
```

- [ ] **Step 6: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS — no "normalizeVersion is not defined" (all call sites replaced; confirm with `rg "normalizeVersion" main/helpers/addonVersions.ts` → no matches).
Run: `yarn test:engines`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add main/helpers/download/versionCompare.ts main/helpers/addonVersions.ts scripts/test-engine-units.ts
git commit -m "refactor(download): extract shared compareDateVersion used by addon updates"
```

---

## Task 4: Shared mirror downloader core (`mirrorDownloader.ts`) — TDD

**Files:**

- Create: `main/helpers/download/mirrorDownloader.ts`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: Write the failing test (progress math, deterministic)**

In `scripts/test-engine-units.ts`, add the import:

```ts
import { MirrorDownloader } from '../main/helpers/download/mirrorDownloader';
```

Add assertions before the final `console.log` (percent is time-independent; call `resetForDownload()` first so the 1s speed gate is skipped within the same ms):

```ts
// --- MirrorDownloader.updateProgress percent math ---
{
  const md = new MirrorDownloader(() => {});
  md.resetForDownload();
  md.updateProgress({ total: 200, downloaded: 50 });
  eq(md.getProgress().progress, 25, 'mirror: 50/200 -> 25%');
  md.updateProgress({ downloaded: 200 });
  eq(md.getProgress().progress, 100, 'mirror: 200/200 -> 100%');
  eq(md.getProgress().status, 'idle', 'mirror: status unchanged by bytes');
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:engines`
Expected: FAIL — "Cannot find module '../main/helpers/download/mirrorDownloader'".

- [ ] **Step 3: Create `mirrorDownloader.ts`**

Create `main/helpers/download/mirrorDownloader.ts` (the `downloadFile` body is the verbatim merge of the two existing implementations):

```ts
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { getSourceFallbackOrder } from '../downloadSourceOrder';
import type { BinaryDownloadSource } from '../../../types/addon';

export type MirrorStatus =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'completed'
  | 'error';

export interface MirrorProgress {
  status: MirrorStatus;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}

/** 下载过程中回报字节，供适配层持久化各自的续传 state 形状。 */
export interface DownloadFileHooks {
  onBytes?: (downloaded: number, total: number) => void;
}

type LogFn = (msg: string, level: 'info' | 'warning' | 'error') => void;

/**
 * 镜像下载核心：进度数学 + 多源回退 + 断点续传单文件下载（Range/重定向/206/
 * 60s 无活动超时/30s 连接超时/abort）。不感知 addon/py 的产物语义。
 */
export class MirrorDownloader {
  private abortController: AbortController | null = null;
  private progress: MirrorProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };
  private lastSpeedCalcTime = 0;
  private lastSpeedCalcBytes = 0;

  constructor(private readonly emit: (p: MirrorProgress) => void) {}

  getProgress(): MirrorProgress {
    return { ...this.progress };
  }

  /** 每次下载前重置 abort 控制器与速度基线。 */
  resetForDownload(): void {
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;
  }

  updateProgress(update: Partial<MirrorProgress>): void {
    this.progress = { ...this.progress, ...update };

    const now = Date.now();
    if (now - this.lastSpeedCalcTime >= 1000) {
      const bytesPerSecond =
        ((this.progress.downloaded - this.lastSpeedCalcBytes) * 1000) /
        (now - this.lastSpeedCalcTime);
      this.progress.speed = Math.max(0, bytesPerSecond);

      if (bytesPerSecond > 0 && this.progress.total > 0) {
        const remainingBytes = this.progress.total - this.progress.downloaded;
        this.progress.eta = Math.ceil(remainingBytes / bytesPerSecond);
      }

      this.lastSpeedCalcTime = now;
      this.lastSpeedCalcBytes = this.progress.downloaded;
    }

    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }

    this.emit({ ...this.progress });
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateProgress({ status: 'idle' });
  }

  /**
   * 按所选源 + 回退顺序依次尝试 attempt；isTerminalError 命中时不再换源（取消/协议）。
   */
  async runWithFallback<T>(
    source: BinaryDownloadSource,
    attempt: (s: BinaryDownloadSource) => Promise<T>,
    isTerminalError: (e: unknown) => boolean,
    logLabel: string,
    log: LogFn,
  ): Promise<T> {
    const order = getSourceFallbackOrder(source);
    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      try {
        if (i > 0) log(`${logLabel} falling back to source: ${s}`, 'warning');
        return await attempt(s);
      } catch (error) {
        if (isTerminalError(error)) throw error;
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        log(
          `${logLabel} from ${s} failed: ${msg}; ${
            i < order.length - 1 ? 'trying next source' : 'no more sources'
          }`,
          'warning',
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 断点续传单文件下载。resolve 为 destPath。取消时 reject('Download cancelled')。 */
  downloadFile(
    url: string,
    destPath: string,
    startByte: number,
    hooks?: DownloadFileHooks,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        'User-Agent': 'SmartSub-Electron',
      };
      if (startByte > 0) {
        headers['Range'] = `bytes=${startByte}-`;
      }

      const INACTIVITY_TIMEOUT = 60000;
      let inactivityTimer: NodeJS.Timeout | null = null;
      let isCompleted = false;

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (!isCompleted) {
          inactivityTimer = setTimeout(() => {
            if (!isCompleted) {
              request.destroy();
              reject(
                new Error('Download timeout: no data received for 60 seconds'),
              );
            }
          }, INACTIVITY_TIMEOUT);
        }
      };

      const clearInactivityTimer = () => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
        }
      };

      const request = protocol.get(url, { headers }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          clearInactivityTimer();
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, destPath, startByte, hooks)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode && response.statusCode >= 400) {
          clearInactivityTimer();
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        let totalSize = 0;
        if (response.statusCode === 206) {
          const contentRange = response.headers['content-range'];
          if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) totalSize = parseInt(match[1], 10);
          }
        } else {
          const contentLength = response.headers['content-length'];
          if (contentLength)
            totalSize = parseInt(contentLength, 10) + startByte;
        }

        this.updateProgress({ total: totalSize, downloaded: startByte });
        hooks?.onBytes?.(startByte, totalSize);

        const writeStream = fs.createWriteStream(destPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });

        let downloadedBytes = startByte;
        resetInactivityTimer();

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          this.updateProgress({ downloaded: downloadedBytes });
          resetInactivityTimer();
          hooks?.onBytes?.(downloadedBytes, totalSize);
        });

        response.on('end', () => {
          clearInactivityTimer();
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          isCompleted = true;
          clearInactivityTimer();
          resolve(destPath);
        });

        writeStream.on('error', (err) => {
          isCompleted = true;
          clearInactivityTimer();
          reject(err);
        });

        if (this.abortController) {
          this.abortController.signal.addEventListener('abort', () => {
            isCompleted = true;
            clearInactivityTimer();
            request.destroy();
            writeStream.close();
            reject(new Error('Download cancelled'));
          });
        }
      });

      request.on('error', (err) => {
        isCompleted = true;
        clearInactivityTimer();
        reject(err);
      });

      request.setTimeout(30000, () => {
        // 仅用于建立连接；一旦开始接收数据由 inactivityTimer 接管
      });

      resetInactivityTimer();
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:engines`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/helpers/download/mirrorDownloader.ts scripts/test-engine-units.ts
git commit -m "feat(download): add shared MirrorDownloader core with progress unit test"
```

---

## Task 5: Refactor `AddonDownloader` onto the core

**Files:**

- Modify: `main/helpers/addonDownloader.ts:124-567,743-754`

> Keep unchanged: `getAddonFileName`, `addonBaseUrl`, `getDownloadUrl`, `getAddonVersionsUrl`, `readDownloadState`/`saveDownloadState`, `cleanVersionDir`, `extractFile`, `renameNodeFile`, `gunzipFile`, `calculateFileChecksum`, `verifyChecksum`, `getAddonDownloader`. The class keeps the same public methods (`setMainWindow`, `getProgress`, `cancel`, `download`).

- [ ] **Step 1: Import the core and the progress type**

In `main/helpers/addonDownloader.ts`, add after the `resolveReleaseBaseUrl` import (from Task 2):

```ts
import { MirrorDownloader } from './download/mirrorDownloader';
```

- [ ] **Step 2: Replace the class fields + constructor + progress/cancel/getProgress**

Replace the top of the class (currently `:126-213`, i.e. fields through `cancel()`) with:

```ts
export class AddonDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'addon-download-progress',
          p as DownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getProgress(): DownloadProgress {
    return this.core.getProgress() as DownloadProgress;
  }

  cancel(): void {
    this.core.cancel();
  }
```

This deletes the old `abortController`, `currentProgress`, `lastSpeedCalcTime`, `lastSpeedCalcBytes` fields and the `sendProgress`/`updateProgress` methods.

- [ ] **Step 3: Replace `download` to delegate fallback to the core**

Replace the `download` method (currently `:219-248`) with:

```ts
  /**
   * 执行下载：按所选源 + 回退顺序依次尝试，任一源成功即返回。
   * 用户取消（Download cancelled）不回退，直接抛出。
   */
  async download(
    source: DownloadSource,
    variant: AddonVariant,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<string> {
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s, variant, downloadType),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
        'Download cancelled',
      'Addon download',
      logMessage,
    );
  }
```

- [ ] **Step 4: Replace `downloadFromSource` to use the core (and delete the old `downloadFile`)**

Replace `downloadFromSource` (currently `:253-377`) AND delete the entire old `downloadFile` method (currently `:382-567`) with this single new `downloadFromSource`:

```ts
  /**
   * 从单一源执行下载（断点续传 + 进度走共享核心；解压沿用 addon 专属逻辑）
   */
  private async downloadFromSource(
    source: DownloadSource,
    variant: AddonVariant,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<string> {
    const url = getDownloadUrl(source, variant, downloadType);
    const addonsDir = path.join(app.getPath('userData'), 'addons');
    const versionDir = getAddonVersionDir(variant);

    fs.mkdirSync(versionDir, { recursive: true });

    this.core.resetForDownload();
    this.core.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    try {
      const existingState = readDownloadState();
      let startByte = 0;
      let tempPath: string;

      if (
        existingState &&
        existingState.url === url &&
        fs.existsSync(existingState.tempPath)
      ) {
        tempPath = existingState.tempPath;
        const stat = fs.statSync(tempPath);
        startByte = stat.size;

        if (existingState.total > 0 && stat.size >= existingState.total) {
          logMessage('Download already complete, skipping to extraction', 'info');
          this.core.updateProgress({
            downloaded: stat.size,
            total: existingState.total,
            progress: 100,
            status: 'extracting',
          });
          await this.extractFile(tempPath, versionDir, downloadType);
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          saveDownloadState(null);
          this.core.updateProgress({ status: 'completed', progress: 100 });
          logMessage(`Addon extracted to ${versionDir}`, 'info');
          return versionDir;
        }

        this.core.updateProgress({
          downloaded: startByte,
          total: existingState.total,
        });
        logMessage(`Resuming download from byte ${startByte}`, 'info');
      } else {
        tempPath = path.join(addonsDir, `temp-${variant.replace(/\./g, '')}`);
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
          logMessage(`Cleaned up old temp file: ${tempPath}`, 'info');
        }
      }

      const startedAt = new Date().toISOString();
      const downloadedPath = await this.core.downloadFile(
        url,
        tempPath,
        startByte,
        {
          onBytes: (downloaded, total) =>
            saveDownloadState({
              url,
              destPath: tempPath,
              tempPath,
              downloaded,
              total,
              variant,
              downloadType,
              startedAt,
              lastUpdatedAt: new Date().toISOString(),
            }),
        },
      );

      this.core.updateProgress({ status: 'extracting' });
      await this.extractFile(downloadedPath, versionDir, downloadType);
      if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
      saveDownloadState(null);

      this.core.updateProgress({ status: 'completed', progress: 100 });
      logMessage(`Addon downloaded and extracted to ${versionDir}`, 'info');
      return versionDir;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage === 'Download cancelled') {
        this.core.updateProgress({ status: 'idle', error: 'Download cancelled' });
        throw error;
      }
      this.core.updateProgress({ status: 'error', error: errorMessage });
      logMessage(`Download error: ${errorMessage}`, 'error');
      throw error;
    }
  }
```

- [ ] **Step 5: Remove now-unused imports**

`download()` no longer calls `getSourceFallbackOrder` directly, and `downloadFile` (which used `https`/`http`) is gone. Run:
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: may report unused `https`, `http`, and `getSourceFallbackOrder` (if `noUnusedLocals` is on) — remove those imports from `addonDownloader.ts`. `zlib` (gunzip), `tar` (extract), `createHash` (checksum), `getEffectivePlatform`, `getAddonVersionDir`, `fs`, `path`, `app`, `BrowserWindow` remain in use. Re-run until PASS.

- [ ] **Step 6: Verify the resume-state shape is unchanged**

Run: `rg -n "saveDownloadState\(" main/helpers/addonDownloader.ts`
Expected: the `saveDownloadState({...})` object includes exactly `url, destPath, tempPath, downloaded, total, variant, downloadType, startedAt, lastUpdatedAt` (same fields as the `DownloadState` type at `types/addon.ts:301-320`) — so existing in-flight resume files stay compatible.

- [ ] **Step 7: Tests + build**

Run: `yarn test:engines`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add main/helpers/addonDownloader.ts
git commit -m "refactor(download): AddonDownloader delegates to shared MirrorDownloader core"
```

---

## Task 6: Refactor `PyEngineDownloader` onto the core

**Files:**

- Modify: `main/helpers/pythonRuntime/downloader.ts:160-395,574,628-803`

> Keep unchanged: `parseExpectedChecksum`, `fetchHttpText`, `readDownloadState`/`saveDownloadState`, `fetchRemoteManifest`, `checkUpdate`, `buildLocalManifest`, `verifyExtractAndInstall`, `installFromStaging` (one line changes — see Step 5), `rollback`. Public methods (`setMainWindow`, `getProgress`, `cancel`, `download`, `checkUpdate`) keep their signatures.

- [ ] **Step 1: Import the core**

In `main/helpers/pythonRuntime/downloader.ts`, add after the `getSourceFallbackOrder` import (currently `:34`):

```ts
import { MirrorDownloader } from '../download/mirrorDownloader';
```

- [ ] **Step 2: Replace the class fields + constructor + progress/cancel/getProgress**

Replace the top of the class (currently `:160-229`, fields through `cancel()`) with:

```ts
export class PyEngineDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'py-engine-download-progress',
          p as PyEngineDownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getProgress(): PyEngineDownloadProgress {
    return this.core.getProgress() as PyEngineDownloadProgress;
  }

  cancel(): void {
    this.core.cancel();
  }
```

This deletes the old `abortController`, `currentProgress`, `lastSpeedCalcTime`, `lastSpeedCalcBytes` fields and the `sendProgress`/`updateProgress` methods.

- [ ] **Step 3: Replace `download` to delegate fallback to the core**

Replace the `download` method (currently `:235-268`) with:

```ts
  /**
   * 安装/升级：按所选源 + 回退顺序依次尝试。
   * 用户取消与协议不支持（protocol_unsupported）属终止类错误，不再换源。
   */
  async download(source: PyEngineDownloadSource): Promise<void> {
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
          'Download cancelled' ||
        (error instanceof PythonEngineError &&
          error.code === 'protocol_unsupported'),
      'Py-engine download',
      logMessage,
    );
  }
```

- [ ] **Step 4: Replace `downloadFromSource` to use the core (and delete the old `downloadFile`)**

Replace `downloadFromSource` (currently `:270-395`) AND delete the entire old `downloadFile` method (currently `:628-803`) with this single new `downloadFromSource`:

```ts
  private async downloadFromSource(
    source: PyEngineDownloadSource,
  ): Promise<void> {
    const resolvedTag = PY_ENGINE_TAG;
    const url = getPyEngineDownloadUrl(source, resolvedTag);
    const tempPath = getTempTarPath();
    const downloadsDir = getPyEngineDownloadsDir();

    // 安装/升级前协议区间校验：拉远端 manifest，超出 app 支持区间则拒装并提示升级 SmartSub。
    const remoteManifest = await this.fetchRemoteManifest(source, resolvedTag);
    if (!isRemoteProtocolInstallable(remoteManifest)) {
      const err = new PythonEngineError(
        'protocol_unsupported',
        `engine protocolVersion=${remoteManifest?.protocolVersion} requires a newer SmartSub`,
      );
      this.core.updateProgress({ status: 'error', error: 'protocol_unsupported' });
      logMessage(`Py-engine install blocked: ${err.message}`, 'error');
      throw err;
    }

    fs.mkdirSync(downloadsDir, { recursive: true });

    this.core.resetForDownload();
    this.core.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    try {
      const existingState = readDownloadState();
      let startByte = 0;
      let downloadedPath = tempPath;

      if (
        existingState &&
        existingState.url === url &&
        fs.existsSync(existingState.tempPath)
      ) {
        downloadedPath = existingState.tempPath;
        const stat = fs.statSync(downloadedPath);
        startByte = stat.size;

        if (existingState.total > 0 && stat.size >= existingState.total) {
          logMessage(
            'Py-engine download already complete, verifying checksum',
            'info',
          );
          this.core.updateProgress({
            downloaded: stat.size,
            total: existingState.total,
            progress: 100,
            status: 'extracting',
          });
          await this.verifyExtractAndInstall(
            downloadedPath,
            source,
            resolvedTag,
            remoteManifest,
          );
          if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
          saveDownloadState(null);
          this.core.updateProgress({ status: 'completed', progress: 100 });
          return;
        }

        this.core.updateProgress({
          downloaded: startByte,
          total: existingState.total,
        });
        logMessage(`Resuming py-engine download from byte ${startByte}`, 'info');
      } else if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        logMessage(`Cleaned up old py-engine temp file: ${tempPath}`, 'info');
      }

      const startedAt = new Date().toISOString();
      downloadedPath = await this.core.downloadFile(url, tempPath, startByte, {
        onBytes: (downloaded, total) =>
          saveDownloadState({
            url,
            destPath: tempPath,
            tempPath,
            downloaded,
            total,
            tag: resolvedTag,
            source,
            startedAt,
            lastUpdatedAt: new Date().toISOString(),
          }),
      });

      this.core.updateProgress({ status: 'extracting' });
      await this.verifyExtractAndInstall(
        downloadedPath,
        source,
        resolvedTag,
        remoteManifest,
      );

      if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
      saveDownloadState(null);

      this.core.updateProgress({ status: 'completed', progress: 100 });
      logMessage('Py-engine downloaded and installed', 'info');
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage === 'Download cancelled') {
        this.core.updateProgress({ status: 'idle', error: 'Download cancelled' });
        throw error;
      }
      this.core.updateProgress({ status: 'error', error: errorMessage });
      logMessage(`Py-engine download error: ${errorMessage}`, 'error');
      throw error;
    }
  }
```

- [ ] **Step 5: Fix the `verifying` progress call inside `installFromStaging`**

In `installFromStaging` (currently `:574`), change `this.updateProgress({ status: 'verifying' });` to:

```ts
this.core.updateProgress({ status: 'verifying' });
```

- [ ] **Step 6: Remove now-unused imports**

`downloadFile` (which used `https`/`http`) is gone, but `fetchHttpText` (module-level) still uses `https`/`http` — so keep them. Run:
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS. If `noUnusedLocals` flags anything, remove only the genuinely unused import. `tar`, `fs`, `path`, `getSourceFallbackOrder` (used by `fetchRemoteManifest`/`checkUpdate`), `PythonEngineError`, runtime helpers all remain used.

- [ ] **Step 7: Verify resume-state shape unchanged**

Run: `rg -n "saveDownloadState\(\{" main/helpers/pythonRuntime/downloader.ts`
Expected: the object includes exactly `url, destPath, tempPath, downloaded, total, tag, source, startedAt, lastUpdatedAt` (matching `PyEngineDownloadState` at `downloader.ts:36-46`).

- [ ] **Step 8: Tests + build**

Run: `yarn test:engines`
Expected: PASS.
Run: `yarn build`
Expected: no new TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add main/helpers/pythonRuntime/downloader.ts
git commit -m "refactor(download): PyEngineDownloader delegates to shared MirrorDownloader core"
```

---

## Task 7: Whole-plan verification (behavior-preserving acceptance)

- [ ] **Step 1: Unit tests + build**

Run: `yarn test:engines && yarn build`
Expected: tests `... 0 failed`; build no new TS errors.

- [ ] **Step 2: Confirm no renderer/IPC drift**

Run: `rg -n "addon-download-progress|py-engine-download-progress" main renderer`
Expected: the IPC channel names are unchanged and still used by both main (emit) and renderer (listeners). No renderer files were modified by this plan.

- [ ] **Step 3: Manual download matrix (critical paths)**

On macOS dev (and, if available, Windows), for BOTH addon (Settings → GPU acceleration download) and py-engine (Engines → faster-whisper download):

1. **Fresh download** completes; progress %, speed, ETA update; engine/addon installs.
2. **Resume:** kill the app mid-download, relaunch, re-trigger → it resumes from the partial temp file (log "Resuming … from byte N"), completes.
3. **Mirror fallback:** temporarily make `github` unreachable (e.g. block the host) with source = GitHub → it falls back through gitcode/ghproxy and still completes (log "falling back to source").
4. **Cancel** mid-download → status returns to idle, no source fallback, no crash.
5. **py-engine upgrade** path: with a sidecar previously run, trigger upgrade → stop → swap → ping self-check → success (or rollback on induced failure) still works.

- [ ] **Step 4: Format + commit**

Run: `yarn format`

```bash
git add -A
git commit -m "style: prettier formatting for download core unification"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §4.1.2 (1) `sources.ts` → Tasks 1-2; (2) `mirrorDownloader.ts` → Tasks 4-6; (3) thin adapters with unchanged public APIs/IPC → Tasks 5-6; (4) `versionCompare.ts` → Task 3. §4.1.3 robustness constraints: public API/IPC/progress unchanged (Tasks 5-6 Steps 2), resume-state compatibility verified (Tasks 5/6 Steps 6-7), addon keeps no-checksum (extract logic untouched), timeouts/redirect/206/abort copied verbatim (Task 4 Step 3), terminal-error semantics preserved (Tasks 5-6 Step 3), gitcode slug difference preserved (Task 1 test + Task 2). §4.1.4 tests → Tasks 1/3/4 unit tests + Task 7 manual matrix.
- **No placeholders:** full code for `sources.ts`, `versionCompare.ts`, `mirrorDownloader.ts`, and both refactored `downloadFromSource`/`download` methods.
- **Type consistency:** `resolveReleaseBaseUrl(source: BinaryDownloadSource, slugs: ReleaseRepoSlugs, tag)` identical across `sources.ts`, the tests, and both call sites (`addonBaseUrl`, `getPyEngineReleaseBaseUrl`). `MirrorDownloader` API (`resetForDownload`, `updateProgress`, `cancel`, `runWithFallback`, `downloadFile`, `getProgress`) identical between definition (Task 4) and both adapters (Tasks 5-6). `MirrorProgress.status` (MirrorStatus) is a subset of both `DownloadStatus` and `PyEngineDownloadProgress.status`, so the cast in each emit callback is sound. `onBytes(downloaded, total)` hook signature matches between core and both adapters' `saveDownloadState` closures.

```

```
