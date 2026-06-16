# Three-Layer Base Distribution (CI bundling + remote base) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (①) Make the app's release CI actually fetch + bundle the Python base (PBS) per platform so released installers work; and (②) build/publish a downloadable remote base package in the engine repo + add an app-side base downloader/auto-update/UI so the bundled base can be upgraded (or replaced) at runtime.

**Architecture:** Layer 1 (Python base) stays **bundled-primary**: the app CI fetches PBS via `scripts/fetch-python-base.mjs` and electron-builder bundles `extraResources/py-base/`. ② adds a **remote-optional** path: the engine repo CI builds `smartsub-base-<suffix>.tar.gz` and records it in `manifest.json.basePackage`; the app downloads it to `userData/py-base/current`, which `resolvePyBaseDir()` already prefers over the bundled base. All download/verify/extract/macOS-resign/atomic-swap/mirror-fallback logic is reused from the existing `PyEngineDownloader`.

**Tech Stack:** GitHub Actions, electron-builder, Node (`fetch-python-base.mjs`, `check-bundle-size.mjs`), Python stdlib (`build_base_package.py`), TypeScript (Electron main + React renderer), `tar`, `MirrorDownloader`, `codesign` (ad-hoc).

---

## File Structure

**① App CI base bundling**

- Modify: `.github/workflows/release.yml` — add per-platform "Prepare Python base" step + post-build size gate.

**② Engine repo (produce)**

- Create: `build_base_package.py` — download PBS `install_only`, trim, ad-hoc sign, lay out base dir.
- Modify: `.github/workflows/release.yml` — add `build_base` matrix job + base artifacts in checksums + `basePackage` in manifest.

**② App (types / paths / fetch / update / consume / UI)**

- Modify: `types/engine.ts` — `RemoteBaseArtifact`, `RemoteEngineManifest.basePackage`, `PyBaseDownloadProgress`, `PyBaseUpdateInfo`, `PyBaseStatus`.
- Modify: `main/helpers/pythonRuntime/paths.ts` — base artifact name/URL helpers + user base manifest read/write.
- Create: `main/helpers/pythonRuntime/baseDownloader.ts` — `PyBaseDownloader` (mirror of `PyEngineDownloader`, target `userData/py-base/current`).
- Modify: `main/helpers/pythonRuntime/autoUpdateCheck.ts` — add `maybeAutoCheckPyBaseUpdate`.
- Modify: `main/helpers/ipcEngineHandlers.ts` — base IPC: start/cancel/progress/check-update/uninstall + `get-py-base-status`.
- Modify: `main/background.ts` — call `maybeAutoCheckPyBaseUpdate` next to engine check.
- Create: `renderer/components/resources/BaseRuntimeCard.tsx` — base status + download/upgrade UI (mirror `FunasrEngineCard`, simpler).
- Modify: `renderer/components/resources/EnginesTab.tsx` — render `BaseRuntimeCard`.
- Modify: `renderer/public/locales/{zh,en}/resources.json` — `engines.base.*` strings.

---

## Part ① — App release CI: fetch+bundle base + size gate

### Task 1: Add base fetch + size gate to app `release.yml`

**Files:**

- Modify: `.github/workflows/release.yml` (build job, after "Compile application code" ~line 117; size gate after "Build Electron app" ~line 130)

- [ ] **Step 1: Insert "Prepare Python base" before "Build Electron app"**

After the `Compile application code` step and before `Build Electron app`, add (bash maps the matrix os/arch to fetch-python-base flags):

```yaml
- name: Prepare Python base (PBS)
  shell: bash
  run: |
    if [[ "${{ matrix.os_build_arg }}" == "mac" ]]; then PLAT=darwin; fi
    if [[ "${{ matrix.os_build_arg }}" == "win" ]]; then PLAT=win32; fi
    if [[ "${{ matrix.os_build_arg }}" == "linux" ]]; then PLAT=linux; fi
    yarn base:fetch --platform "$PLAT" --arch "${{ matrix.arch }}"
    ls extraResources/py-base
```

- [ ] **Step 2: Add a size gate after "Build Electron app"**

Immediately after the `Build Electron app` step (before "Stage Artifacts"):

```yaml
- name: Bundle size gate (<=200MB)
  shell: bash
  run: yarn size:check
```

- [ ] **Step 3: Static validation**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('yaml ok')"`
Expected: `yaml ok` (no parse error). If `js-yaml` isn't installed, skip — visual review of indentation is enough.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(app): fetch+bundle PBS base per platform and enforce 200MB size gate"
```

---

## Part ② — Remote base package

### Task 2 (engine repo): `build_base_package.py`

**Files:**

- Create: `/Users/xiaodong/code/github.com/buxuku/smartsub-py-engine/build_base_package.py`

- [ ] **Step 1: Write the script (PBS download + trim + ad-hoc sign, stdlib only)**

Mirror `fetch-python-base.mjs` (same PBS release `20250610`, same trim list, same `python/` flatten) so the downloaded base matches the bundled base layout. PBS `install_only` root is `python/`; we flatten it to `OUT_DIR`.

```python
#!/usr/bin/env python3
"""Build a relocatable, trimmed PBS base for SmartSub Layer 1.

Usage:
  python build_base_package.py <OUT_DIR> <TRIPLE>

TRIPLE ∈ aarch64-apple-darwin | x86_64-apple-darwin |
         x86_64-pc-windows-msvc-shared | x86_64-unknown-linux-gnu
Mirrors scripts/fetch-python-base.mjs in the app repo (same PBS release + trim).
"""
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PYTHON_VERSION = "3.12.10"
PBS_RELEASE = "20250610"

TRIM = [
    "lib/python3.12/test", "lib/python3.12/idlelib", "lib/python3.12/tkinter",
    "lib/python3.12/lib2to3", "lib/python3.12/ensurepip",
    "lib/python3.12/turtledemo",
    "Lib/test", "Lib/idlelib", "Lib/tkinter", "Lib/lib2to3", "Lib/ensurepip",
]


def adhoc_sign(out: Path):
    if sys.platform != "darwin":
        return
    count = 0
    for p in out.rglob("*"):
        if p.is_file() and (p.suffix in (".so", ".dylib") or p.name == "python3"):
            subprocess.run(["codesign", "--force", "--sign", "-", str(p)],
                           check=False, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            count += 1
    print(f"ad-hoc signed {count} mach-o files")


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: build_base_package.py <OUT_DIR> <TRIPLE>")
    out = Path(sys.argv[1])
    triple = sys.argv[2]
    asset = f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-{triple}-install_only.tar.gz"
    url = (f"https://github.com/astral-sh/python-build-standalone/releases/"
           f"download/{PBS_RELEASE}/{asset}")

    tmp = Path(tempfile.mkdtemp(prefix="pbs-"))
    tar_path = tmp / asset
    print(f"Fetching {url}")
    urllib.request.urlretrieve(url, tar_path)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    with tarfile.open(tar_path, "r:gz") as tf:
        tf.extractall(tmp)
    py_dir = tmp / "python"
    for entry in py_dir.iterdir():
        dest = out / entry.name
        if entry.is_dir():
            shutil.copytree(entry, dest)
        else:
            shutil.copy2(entry, dest)

    for rel in TRIM:
        shutil.rmtree(out / rel, ignore_errors=True)
    for pc in out.rglob("__pycache__"):
        shutil.rmtree(pc, ignore_errors=True)

    adhoc_sign(out)
    print(f"base ready at {out} ({triple})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Local smoke (mac host)**

```bash
cd /Users/xiaodong/code/github.com/buxuku/smartsub-py-engine
python3 build_base_package.py /tmp/py-base aarch64-apple-darwin
/tmp/py-base/bin/python3 -c "import ssl, ctypes, sqlite3, lzma; print('base ok')"
du -sh /tmp/py-base
```

Expected: `base ok`, size ≈ 40–70MB.

- [ ] **Step 3: Commit (engine repo)**

```bash
git add build_base_package.py
git commit -m "build(base): add PBS base packager (download+trim+adhoc-sign)"
```

### Task 3 (engine repo): `build_base` CI job + manifest `basePackage`

**Files:**

- Modify: `/Users/xiaodong/code/github.com/buxuku/smartsub-py-engine/.github/workflows/release.yml`

- [ ] **Step 1: Add a `build_base` job (after `build_engine`)**

Triple is derived from `artifact_suffix`. PBS download is platform-agnostic (pure download+trim), so all four targets can run on `ubuntu-latest` except macOS, which must run on macОS for `codesign`. Keep per-target runners for correct ad-hoc signing.

```yaml
build_base:
  name: base ${{ matrix.target.artifact_suffix }}
  runs-on: ${{ matrix.target.os }}
  strategy:
    fail-fast: false
    matrix:
      target:
        - {
            os: macos-latest,
            artifact_suffix: macos-arm64,
            triple: aarch64-apple-darwin,
          }
        - {
            os: macos-15-intel,
            artifact_suffix: macos-x64,
            triple: x86_64-apple-darwin,
          }
        - {
            os: windows-2022,
            artifact_suffix: windows-x64,
            triple: x86_64-pc-windows-msvc-shared,
          }
        - {
            os: ubuntu-22.04,
            artifact_suffix: linux-x64,
            triple: x86_64-unknown-linux-gnu,
          }
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: '3.12'
    - name: Build base
      run: python build_base_package.py dist/py-base ${{ matrix.target.triple }}
    - name: Archive (contents at top level, no wrapper dir)
      shell: bash
      run: tar -czf smartsub-base-${{ matrix.target.artifact_suffix }}.tar.gz -C dist/py-base .
    - uses: actions/upload-artifact@v4
      with:
        name: py-base-${{ matrix.target.artifact_suffix }}
        path: smartsub-base-${{ matrix.target.artifact_suffix }}.tar.gz
        if-no-files-found: error
```

- [ ] **Step 2: `publish_latest` needs `build_base`**

Change `needs: build_engine` to:

```yaml
needs: [build_engine, build_base]
```

- [ ] **Step 3: checksums already globs `smartsub-*.tar.gz`** — base archives are named `smartsub-base-*.tar.gz`, so `sha256sum smartsub-*.tar.gz > checksums.sha256` covers them with no change. (Confirm by reading the existing step.)

- [ ] **Step 4: Add `basePackage` to the generated manifest**

In the inline `python3 - ... <<'PY'` block, after building `per_engine`, add a base section. Insert this helper + manifest key:

```python
          def base_artifacts():
              out = {}
              for suf in suffixes:
                  fname = f"smartsub-base-{suf}.tar.gz"
                  if not os.path.exists(fname):
                      continue
                  data = open(fname, "rb").read()
                  out[suf] = {"sizeBytes": len(data),
                              "sha256": hashlib.sha256(data).hexdigest()}
              return out
```

And add to the `manifest = {...}` dict (alongside `enginePackages`):

```python
              "basePackage": {
                  "pythonVersion": python_version,
                  "pythonAbi": "cp312",
                  "pbsRelease": "20250610",
                  "artifacts": base_artifacts(),
              },
```

- [ ] **Step 5: Commit (engine repo)**

```bash
git add .github/workflows/release.yml
git commit -m "ci(base): build+publish smartsub-base-<platform> and add manifest.basePackage"
```

### Task 4 (app): manifest + progress + status types

**Files:**

- Modify: `types/engine.ts:33-67` (add types near `RemoteEngineArtifact`/`PyBaseManifest`)

- [ ] **Step 1: Add base remote/progress/status types**

Append after `RemoteEngineManifest` (keep `RemoteEngineArtifact` reuse) and extend the manifest:

```ts
export interface RemoteBasePackage {
  pythonVersion: string;
  pythonAbi: string;
  pbsRelease?: string;
  artifacts: Record<string, RemoteEngineArtifact>;
}
```

Add `basePackage` to `RemoteEngineManifest`:

```ts
  pythonVersion?: string;
  pythonAbi?: string;
  engineId?: string;
  /** 三层 Layer1：可下载基座包（按平台 artifacts）。 */
  basePackage?: RemoteBasePackage;
```

Add progress + update-info + status (mirroring `PyEngineDownloadProgress`):

```ts
export interface PyBaseDownloadProgress {
  status:
    | 'idle'
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'completed'
    | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}

export interface PyBaseUpdateInfo {
  hasUpdate: boolean;
  localManifest: PyBaseManifest | null;
  remoteBase: RemoteBasePackage | null;
  remoteHash: string | null;
}

export interface PyBaseStatus {
  state: EngineStatusState; // 'ready' | 'not_installed' | 'downloading' | 'error' | 'checking'
  source: 'builtin' | 'downloaded' | 'none';
  pythonVersion?: string;
}
```

- [ ] **Step 2: Type-check** — `npx tsc --noEmit 2>&1 | rg -c "^(main|types)/"` ⇒ ≤ 104 (baseline).
- [ ] **Step 3: Commit** — `git add types/engine.ts && git commit -m "feat(types): add remote base package + base download/status types"`

### Task 5 (app): base path/URL helpers + user base manifest IO

**Files:**

- Modify: `main/helpers/pythonRuntime/paths.ts` (append after `getEngineDownloadUrl`, ~line 162)

- [ ] **Step 1: Add base artifact + URL + manifest helpers**

```ts
import type { PyBaseManifest } from '../../../types/engine';

/** 基座产物名：smartsub-base-<suffix>.tar.gz */
export function getBaseArtifactName(): string {
  return `smartsub-base-${getPyEngineArtifactSuffix()}.tar.gz`;
}

export function getBaseDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${getBaseArtifactName()}`;
}

/** 下载基座的本地 manifest（写在 userData/py-base/current 内，随目录 swap/rollback）。 */
export function getUserPyBaseManifestPath(): string {
  return path.join(getUserPyBaseDir(), 'manifest.json');
}

export function readUserPyBaseManifest(): PyBaseManifest | null {
  const p = getUserPyBaseManifestPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PyBaseManifest;
  } catch {
    return null;
  }
}

export function writeUserPyBaseManifest(m: PyBaseManifest): void {
  fs.mkdirSync(getUserPyBaseDir(), { recursive: true });
  fs.writeFileSync(getUserPyBaseManifestPath(), JSON.stringify(m, null, 2));
}

/** 当前生效基座来源（用于 UI / 状态）。 */
export function getPyBaseSource(): 'builtin' | 'downloaded' | 'none' {
  if (fs.existsSync(getPyBasePythonPath(getUserPyBaseDir())))
    return 'downloaded';
  if (fs.existsSync(getPyBasePythonPath(getBuiltinPyBaseDir())))
    return 'builtin';
  return 'none';
}
```

Note: `getPyEngineReleaseBaseUrl` is module-private; export it OR reuse via a new exported wrapper. Add `export` to its declaration (line 29) so `baseDownloader.ts` can build URLs.

- [ ] **Step 2: Type-check** ⇒ ≤ 104. **Commit** — `git add main/helpers/pythonRuntime/paths.ts && git commit -m "feat(paths): base artifact/url helpers + user base manifest IO"`

### Task 6 (app): `PyBaseDownloader`

**Files:**

- Create: `main/helpers/pythonRuntime/baseDownloader.ts`

- [ ] **Step 1: Implement the downloader (mirror `PyEngineDownloader`; target = `userData/py-base/current`)**

Key differences vs engine downloader: no protocol gate, no sidecar self-check loop (but **shutdown sidecar before swap**, since the running sidecar uses the base interpreter), self-check = interpreter import probe, atomic swap to `getUserPyBaseDir()`.

```ts
import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as tar from 'tar';
import { logMessage } from '../storeManager';
import { calculateFileChecksum } from '../addonDownloader';
import type {
  PyBaseDownloadProgress,
  PyBaseManifest,
  PyBaseUpdateInfo,
  PyEngineDownloadSource,
  RemoteEngineManifest,
} from '../../../types/engine';
import {
  PY_ENGINE_TAG,
  getBaseArtifactName,
  getBaseDownloadUrl,
  getPyBasePythonPath,
  getPyEngineChecksumsUrl,
  getPyEngineManifestUrl,
  getPyEngineArtifactSuffix,
  getUserPyBaseDir,
  readUserPyBaseManifest,
  writeUserPyBaseManifest,
} from './paths';
import { adhocResignDir } from './macSign';
import { shutdownPythonRuntime } from './index';
import { getSourceFallbackOrder } from '../downloadSourceOrder';
import { MirrorDownloader } from '../download/mirrorDownloader';

function scratchRoot(): string {
  return path.join(app.getPath('userData'), 'py-base', '.cache');
}
function tempTar(): string {
  return path.join(scratchRoot(), 'downloads', 'base.tar.gz');
}
function stagingDir(): string {
  return path.join(scratchRoot(), 'staging');
}
function previousDir(): string {
  return path.join(scratchRoot(), 'previous');
}

function fetchHttpText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          const loc = res.headers.location;
          if (loc) {
            fetchHttpText(loc).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function parseChecksum(content: string, name: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?\s*(.+)$/);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

export class PyBaseDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'py-base-download-progress',
          p as PyBaseDownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }
  getProgress(): PyBaseDownloadProgress {
    return this.core.getProgress() as PyBaseDownloadProgress;
  }
  cancel(): void {
    this.core.cancel();
  }

  async download(source: PyEngineDownloadSource): Promise<void> {
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
        'Download cancelled',
      'Py-base download',
      logMessage,
    );
  }

  private async fetchRemoteManifest(
    source: PyEngineDownloadSource,
  ): Promise<RemoteEngineManifest | null> {
    for (const s of getSourceFallbackOrder(source)) {
      try {
        return JSON.parse(
          await fetchHttpText(getPyEngineManifestUrl(s)),
        ) as RemoteEngineManifest;
      } catch (e) {
        logMessage(`py-base manifest from ${s} unavailable: ${e}`, 'info');
      }
    }
    return null;
  }

  async checkUpdate(source: PyEngineDownloadSource): Promise<PyBaseUpdateInfo> {
    const localManifest = readUserPyBaseManifest();
    let remoteHash: string | null = null;
    for (const s of getSourceFallbackOrder(source)) {
      try {
        remoteHash = parseChecksum(
          await fetchHttpText(getPyEngineChecksumsUrl(s)),
          getBaseArtifactName(),
        );
        if (remoteHash) break;
      } catch (e) {
        logMessage(
          `py-base checkUpdate checksums ${s} failed: ${e}`,
          'warning',
        );
      }
    }
    const remote = await this.fetchRemoteManifest(source);
    const remoteBase = remote?.basePackage ?? null;
    const hasUpdate = !!(
      remoteHash &&
      localManifest?.sha256 &&
      remoteHash.toLowerCase() !== localManifest.sha256.toLowerCase()
    );
    return { hasUpdate, localManifest, remoteBase, remoteHash };
  }

  private async downloadFromSource(
    source: PyEngineDownloadSource,
  ): Promise<void> {
    const url = getBaseDownloadUrl(source);
    const tar0 = tempTar();
    fs.mkdirSync(path.dirname(tar0), { recursive: true });

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

    const remote = await this.fetchRemoteManifest(source);
    const downloaded = await this.core.downloadFile(url, tar0, 0, {});
    this.core.updateProgress({ status: 'extracting' });
    await this.verifyExtractInstall(downloaded, source, remote);
    if (fs.existsSync(downloaded)) fs.unlinkSync(downloaded);
    this.core.updateProgress({ status: 'completed', progress: 100 });
    logMessage('Py-base downloaded and installed', 'info');
  }

  private async verifyExtractInstall(
    tarPath: string,
    source: PyEngineDownloadSource,
    remote: RemoteEngineManifest | null,
  ): Promise<void> {
    const name = getBaseArtifactName();
    const expected = parseChecksum(
      await fetchHttpText(getPyEngineChecksumsUrl(source)),
      name,
    );
    if (!expected) throw new Error(`Checksum for ${name} not found`);
    const actual = await calculateFileChecksum(tarPath);
    if (actual.toLowerCase() !== expected)
      throw new Error(`Checksum mismatch: ${expected} vs ${actual}`);

    const staging = stagingDir();
    if (fs.existsSync(staging))
      fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await tar.extract({ file: tarPath, cwd: staging });

    if (!fs.existsSync(getPyBasePythonPath(staging))) {
      throw new Error(
        'Invalid base package: interpreter missing after extract',
      );
    }

    const current = getUserPyBaseDir();
    const prev = previousDir();
    const hadPrev = fs.existsSync(current);

    await shutdownPythonRuntime(); // base interpreter may be in use

    if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(prev), { recursive: true });
    if (hadPrev) fs.renameSync(current, prev);

    fs.mkdirSync(path.dirname(current), { recursive: true });
    try {
      fs.renameSync(staging, current);
    } catch (e) {
      if (hadPrev && !fs.existsSync(current) && fs.existsSync(prev)) {
        fs.renameSync(prev, current);
      }
      throw e;
    }

    adhocResignDir(current);

    // self-check: interpreter imports critical stdlib
    this.core.updateProgress({ status: 'verifying' });
    try {
      execFileSync(
        getPyBasePythonPath(current),
        ['-c', 'import ssl, ctypes, sqlite3, lzma'],
        { stdio: 'ignore' },
      );
    } catch (selfCheck) {
      logMessage(
        `Py-base self-check failed, rolling back: ${selfCheck}`,
        'error',
      );
      fs.rmSync(current, { recursive: true, force: true });
      if (hadPrev && fs.existsSync(prev)) fs.renameSync(prev, current);
      throw selfCheck;
    }

    const manifest: PyBaseManifest = {
      pythonVersion: remote?.basePackage?.pythonVersion ?? '3.12.10',
      platform: getPyEngineArtifactSuffix(),
      sha256: expected,
      installedAt: new Date().toISOString(),
      source: 'downloaded',
    };
    writeUserPyBaseManifest(manifest);
    if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
  }
}

let instance: PyBaseDownloader | null = null;
export function getPyBaseDownloader(
  mainWindow?: BrowserWindow,
): PyBaseDownloader {
  if (!instance) instance = new PyBaseDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
```

- [ ] **Step 2: Type-check** ⇒ ≤ 104 (verify `MirrorDownloader.downloadFile(url, dest, startByte, { onBytes? })` signature matches; the engine downloader calls it the same way). **Lint** the new file.
- [ ] **Step 3: Commit** — `git add main/helpers/pythonRuntime/baseDownloader.ts && git commit -m "feat(base): PyBaseDownloader (download/verify/extract/resign/atomic-swap to userData)"`

### Task 7 (app): base IPC handlers + status

**Files:**

- Modify: `main/helpers/ipcEngineHandlers.ts` (imports + warm base downloader in `setMainWindowForEngine` + new handlers before the final log)

- [ ] **Step 1: Imports + warm-up**

Add imports:

```ts
import { getPyBaseDownloader } from './pythonRuntime/baseDownloader';
import { getPyBaseSource, isPyBaseReady } from './pythonRuntime/paths';
import type { PyBaseStatus } from '../../types/engine';
```

In `setMainWindowForEngine`, after the two engine warmups:

```ts
getPyBaseDownloader(window);
```

- [ ] **Step 2: Handlers (add inside `registerEngineIpcHandlers`)**

```ts
ipcMain.handle('get-py-base-status', async (): Promise<PyBaseStatus> => {
  const source = getPyBaseSource();
  return {
    state: isPyBaseReady() ? 'ready' : 'not_installed',
    source,
  };
});

ipcMain.handle(
  'start-py-base-download',
  async (_event, { source }: { source: PyEngineDownloadSource }) => {
    try {
      if (isTranscriptionBusy())
        return { success: false, error: 'engine_busy' };
      getPyBaseDownloader(mainWindow || undefined)
        .download(source)
        .catch((e) => logMessage(`Py-base download failed: ${e}`, 'error'));
      return { success: true, started: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle(
  'check-py-base-update',
  async (_event, { source }: { source: PyEngineDownloadSource }) => {
    try {
      const info = await getPyBaseDownloader(
        mainWindow || undefined,
      ).checkUpdate(source);
      return { success: true, info };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle('cancel-py-base-download', async () => {
  try {
    getPyBaseDownloader(mainWindow || undefined).cancel();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('get-py-base-download-progress', async () => {
  try {
    return getPyBaseDownloader(mainWindow || undefined).getProgress();
  } catch {
    return null;
  }
});
```

- [ ] **Step 3: Type-check** ⇒ ≤ 104. **Commit** — `git add main/helpers/ipcEngineHandlers.ts && git commit -m "feat(base): IPC for base status/download/update/cancel/progress"`

### Task 8 (app): daily base auto-update check

**Files:**

- Modify: `main/helpers/pythonRuntime/autoUpdateCheck.ts`
- Modify: `main/background.ts` (call site, next to `maybeAutoCheckPyEngineUpdate`)

- [ ] **Step 1: Add `maybeAutoCheckPyBaseUpdate`**

```ts
import { getPyBaseDownloader } from './baseDownloader';
import { readUserPyBaseManifest } from './paths';

/** 仅当已存在「下载基座」时才检查升级（内置基座不弹更新，避免噪声）。 */
export async function maybeAutoCheckPyBaseUpdate(
  mainWindow: BrowserWindow,
  source: PyEngineDownloadSource = 'github',
): Promise<void> {
  if (!readUserPyBaseManifest()) return; // 仅下载基座参与日常升级检查
  try {
    const info = await getPyBaseDownloader(mainWindow).checkUpdate(source);
    if (info.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-base-update-available', info);
      logMessage('py-base update available (daily auto-check)', 'info');
    }
  } catch (error) {
    logMessage(`py-base daily update-check failed: ${error}`, 'warning');
  }
}
```

- [ ] **Step 2: Call it in `background.ts`** wherever `maybeAutoCheckPyEngineUpdate(mainWindow)` is invoked, add `void maybeAutoCheckPyBaseUpdate(mainWindow);` (import it). Find the existing call: `rg -n "maybeAutoCheckPyEngineUpdate" main/background.ts`.

- [ ] **Step 3: Type-check** ⇒ ≤ 104. **Commit** — `git add main/helpers/pythonRuntime/autoUpdateCheck.ts main/background.ts && git commit -m "feat(base): daily auto-update check for downloaded base"`

### Task 9 (app UI): BaseRuntimeCard + EnginesTab + i18n

**Files:**

- Create: `renderer/components/resources/BaseRuntimeCard.tsx`
- Modify: `renderer/components/resources/EnginesTab.tsx`
- Modify: `renderer/public/locales/zh/resources.json`, `renderer/public/locales/en/resources.json`

- [ ] **Step 1: `BaseRuntimeCard.tsx`** (mirror `FunasrEngineCard` structure via `EngineCardShell`; shows source = builtin/downloaded, a "检查更新"/"升级基座" button, progress bar, listens to `py-base-download-progress` + `py-base-update-available`).

Responsibilities (full component, mirror `FunasrEngineCard` imports/state):

- On mount: `window.ipc.invoke('get-py-base-status')` → show `ready` + source badge.
- Button "检查更新": `check-py-base-update` → if `hasUpdate`, enable "升级基座".
- Button "升级基座"/"下载基座": `start-py-base-download` `{ source: 'github' }`; subscribe to `py-base-download-progress`; on `completed`, re-fetch status.
- `useEffect` cleanup removes listeners (same pattern as `FunasrEngineCard`).

(Implementer: copy `FunasrEngineCard.tsx` as the skeleton; replace engine/model logic with the four base IPC channels above; drop the model section. Keep `EngineCardShell` for consistent visuals.)

- [ ] **Step 2: Render it in `EnginesTab.tsx`** — import `BaseRuntimeCard` and place it first in the engines grid (it's Layer 1, logically above the engine cards). Filter `py-base-download-progress` is card-local, no change to engine listeners.

- [ ] **Step 3: i18n** — add to both locales under `engines`:

```json
"base": {
  "name": "Python 运行时基座",
  "description": "所有本地引擎共享的 Python 运行环境（已随应用内置，可在线升级）",
  "builtin": "已内置",
  "downloaded": "已升级（下载版）",
  "checkUpdate": "检查更新",
  "upgrade": "升级基座",
  "downloading": "下载中…",
  "upToDate": "已是最新",
  "updateAvailable": "有可用更新"
}
```

(English mirror with translated values.)

- [ ] **Step 4: i18n gate** — `npm run check:i18n` ⇒ pass. **Type-check** renderer (its own tsconfig) ⇒ no new errors. **Commit** — `git add renderer/components/resources/BaseRuntimeCard.tsx renderer/components/resources/EnginesTab.tsx renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json && git commit -m "feat(base): base runtime card (status + online upgrade) + i18n"`

### Task 10: Verify + push

- [ ] **Step 1: Full type-check** — `npx tsc --noEmit 2>&1 | rg -c "^(main|types)/"` ⇒ ≤ 104; renderer tsc ⇒ no new errors.
- [ ] **Step 2: Lint** the touched files; **`npm run check:i18n`** ⇒ pass.
- [ ] **Step 3: Push** both repos (after explicit user approval): app `feat/three-layer-p0`, engine `feat/three-layer-p0`.
- [ ] **Step 4 (optional, user-gated): trigger engine CI** to publish the base package, then verify `manifest.json.basePackage` + `smartsub-base-*` assets on the `latest` release.

---

## Self-Review

**1. Spec coverage:**

- Spec §3.3 "内置为主 + 远程覆盖升级" → ① bundles (Task 1); ② downloads to `userData/py-base/current` which `resolvePyBaseDir` already prefers (Task 6).
- Spec §10 三维版本协调 → manifest carries `pythonVersion`/`pythonAbi`/`pbsRelease` (Task 3); base manifest stores sha256 for update diff (Task 6/8).
- Spec §9 macOS 无证书 → ad-hoc sign in `build_base_package.py` (Task 2) + `adhocResignDir` on download (Task 6).
- Engine repo manifest/checksum reuse (Task 3) — base archives match `smartsub-*.tar.gz` glob.

**2. Placeholder scan:** UI card (Task 9) references "copy FunasrEngineCard skeleton" — acceptable since exact IPC channels + behaviors are enumerated; all main-process code is complete.

**3. Type consistency:**

- `getPyBaseDownloader(mainWindow?)` used identically in IPC (Task 7) + auto-update (Task 8).
- `PyBaseDownloadProgress` / `PyBaseUpdateInfo` / `PyBaseStatus` defined in Task 4, consumed in Tasks 6–9.
- Channels: `py-base-download-progress`, `py-base-update-available`, `get-py-base-status`, `start/cancel/check-py-base-*`, `get-py-base-download-progress` — consistent main↔renderer.
- `MirrorDownloader.downloadFile(url, dest, startByte, { onBytes? })` + `runWithFallback` + `resetForDownload` + `updateProgress` + `getProgress` reused exactly as in `PyEngineDownloader`.

**Risks:**

- `MirrorDownloader.downloadFile` 4th arg shape: confirm against `download/mirrorDownloader.ts` before Task 6 (engine downloader passes `{ onBytes }`).
- Base swap while sidecar running → `shutdownPythonRuntime()` before rename (Windows lock); Task 6 does this.
- Engine CI `build_base` runner cost (4 extra runners per release) — acceptable; base rarely changes, but it rebuilds each release (rolling latest). Optional later: only build base on demand.
