# 多转写引擎（whisper.cpp + faster-whisper）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `feat/resource-hub` 基础上新增 faster-whisper 转写引擎（纯按需下载），通过 EngineRegistry + Python sidecar 实现可扩展多引擎架构，并在资源中心新增 Engines Tab 与 Models Tab 引擎筛选器，同时保证老用户 `modelsPath` / ggml 模型零迁移。

**Architecture:** Electron 主进程通过 `TranscriptionRouter` 路由到 `TranscriptionEngineAdapter`（builtin / fasterWhisper / localCli）；faster-whisper 走 `PythonRuntimeManager` 管理的 PyInstaller sidecar（stdio JSON-lines）；引擎运行时通过 `PyEngineDownloader` 从 `py-engine-v*` Release 按需下载到 `userData/py-engine/current/`；ggml 与 CT2 模型分轨存储。

**Tech Stack:** Electron 30 + Nextron、TypeScript、Python 3.11 + faster-whisper + PyInstaller、GitHub Actions、现有 IPC / electron-store / shadcn/ui。

**上游文档:** `docs/superpowers/specs/2026-06-13-multi-engine-design.md`

**参考实现（只读，不 merge）：** `feat/python-engine-poc` 分支的 `python-engine/`、`main/helpers/pythonEngine/`、`addonDownloader.ts`

**验证说明:** 本仓库无单元测试框架。每 Task 用 `npx tsc --noEmit`（根目录 + renderer）做类型检查；Python 用 `python-engine/smoke_test.py`；功能用 `yarn dev` + DevTools IPC 手工冒烟。最后 Task 跑 `yarn build`。

**提交说明:** 每次 commit 只 `git add` 本 Task 列出的文件，**绝不 `git add .`**。用户未明确要求时不 push。

**分支:** 从当前 `feat/resource-hub` 拉 `feat/multi-engine` 作为开发分支。

---

## 文件结构总览

| 文件                                             | 职责                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `types/engine.ts`                                | `TranscriptionEngine`、`EngineStatus`、`PyEngineManifest` 等共享类型 |
| `main/helpers/pythonRuntime/protocol.ts`         | JSON-lines 协议类型                                                  |
| `main/helpers/pythonRuntime/manager.ts`          | sidecar 生命周期、请求路由、cancel                                   |
| `main/helpers/pythonRuntime/index.ts`            | 命令解析（dev 用 .venv，prod 用 userData）                           |
| `main/helpers/pythonRuntime/downloader.ts`       | 按需下载、断点续传、SHA256、原子安装                                 |
| `main/helpers/pythonRuntime/paths.ts`            | py-engine 目录常量、manifest 读写                                    |
| `main/helpers/engines/types.ts`                  | `TranscriptionEngineAdapter` 接口                                    |
| `main/helpers/engines/registry.ts`               | 引擎注册表                                                           |
| `main/helpers/engines/builtinEngine.ts`          | 包装 `generateSubtitleWithBuiltinWhisper`                            |
| `main/helpers/engines/fasterWhisperEngine.ts`    | sidecar 转写 + SRT 生成                                              |
| `main/helpers/engines/localCliEngine.ts`         | 包装 `generateSubtitleWithLocalWhisper`                              |
| `main/helpers/transcriptionEngine.ts`            | `resolveTranscriptionEngine()` 迁移逻辑                              |
| `main/helpers/transcriptionRouter.ts`            | 统一转写入口                                                         |
| `main/helpers/modelCatalog.ts`                   | ggml / faster-whisper 双轨模型路径与映射                             |
| `main/helpers/ipcEngineHandlers.ts`              | 引擎相关 IPC                                                         |
| `python-engine/main.py`                          | sidecar 入口                                                         |
| `python-engine/engines/faster_whisper_engine.py` | faster-whisper 实现                                                  |
| `renderer/components/resources/EnginesTab.tsx`   | 引擎管理 UI                                                          |
| `renderer/lib/fasterWhisperModels.json`          | faster-whisper 可下载模型目录                                        |

---

## Task 0: 基线检查与新分支

**Files:** 无代码改动

- [ ] **Step 0.1: 创建开发分支**

```bash
cd /Users/xiaodong/Documents/code/SmartSub
git checkout feat/resource-hub
git pull --ff-only origin feat/resource-hub 2>/dev/null || true
git checkout -b feat/multi-engine
```

- [ ] **Step 0.2: 记录类型检查基线**

```bash
npx tsc --noEmit 2>&1 | tail -5; echo "root exit=$?"
npx tsc --noEmit -p renderer/tsconfig.json 2>&1 | tail -5; echo "renderer exit=$?"
```

预期：记下是否已有历史错误；后续 Task 以「不新增错误」为通过标准。

- [ ] **Step 0.3: 对照 POC 只读参考（不 checkout）**

```bash
git show feat/python-engine-poc:python-engine/main.py | head -20
git show feat/python-engine-poc:main/helpers/pythonEngine/manager.ts | head -30
```

---

## Task 1: 共享类型与 Store 字段

**Files:**

- Create: `types/engine.ts`
- Modify: `types/types.ts`
- Modify: `main/helpers/store/types.ts`
- Modify: `main/helpers/store/index.ts`

- [ ] **Step 1.1: 创建 `types/engine.ts`**

```typescript
export type TranscriptionEngine = 'builtin' | 'fasterWhisper' | 'localCli';

export type EngineStatusState =
  | 'ready'
  | 'not_installed'
  | 'downloading'
  | 'error'
  | 'checking';

export interface EngineStatus {
  state: EngineStatusState;
  version?: string;
  message?: string;
}

export interface PyEngineManifest {
  version: string;
  platform: string;
  sha256: string;
  installedAt: string;
}

export type PyEngineDownloadSource = 'github' | 'ghproxy';

export interface PyEngineDownloadProgress {
  status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}
```

- [ ] **Step 1.2: 扩展 `types/types.ts` 中 `ISystemInfo`**

在 `ISystemInfo` 接口追加（不删改现有字段）：

```typescript
import type { EngineStatus, TranscriptionEngine } from './engine';

export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
  totalMemoryGB?: number;
  buildInfo?: { version: string; commit?: string };
  // 新增
  fasterWhisperModelsInstalled?: string[];
  fasterWhisperModelsPath?: string;
  transcriptionEngine?: TranscriptionEngine;
  pythonEngineStatus?: EngineStatus;
}
```

- [ ] **Step 1.3: 扩展 `main/helpers/store/types.ts` settings**

在 `settings` 对象类型中追加：

```typescript
import type { TranscriptionEngine } from '../../../types/engine';

// settings 内新增字段：
transcriptionEngine?: TranscriptionEngine;
fasterWhisperDevice?: 'auto' | 'cpu' | 'cuda';
fasterWhisperComputeType?: string;
fasterWhisperModelsPath?: string;
```

- [ ] **Step 1.4: 更新 `main/helpers/store/index.ts` defaults**

在 `settings` defaults 中追加（不修改 `modelsPath` 默认值）：

```typescript
transcriptionEngine: 'builtin' as const,
fasterWhisperDevice: 'auto' as const,
fasterWhisperComputeType: 'auto',
// fasterWhisperModelsPath 不设 default，运行时由 getFasterWhisperModelsPath() 推导
```

- [ ] **Step 1.5: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
```

- [ ] **Step 1.6: Commit**

```bash
git add types/engine.ts types/types.ts main/helpers/store/types.ts main/helpers/store/index.ts
git commit -m "$(cat <<'EOF'
feat: add multi-engine types and store settings fields

Introduce TranscriptionEngine types and extend settings for faster-whisper
without changing existing modelsPath semantics.
EOF
)"
```

---

## Task 2: Python sidecar 源码

**Files:**

- Create: `python-engine/main.py`
- Create: `python-engine/engines/__init__.py`
- Create: `python-engine/engines/faster_whisper_engine.py`
- Create: `python-engine/requirements.txt`
- Create: `python-engine/smartsub-engine.spec`
- Create: `python-engine/smoke_test.py`
- Modify: `.gitignore`

- [ ] **Step 2.1: 创建 `python-engine/requirements.txt`**

```
faster-whisper>=1.1.0
```

- [ ] **Step 2.2: 创建 `python-engine/engines/__init__.py`**

```python
"""引擎注册表。"""

import logging

log = logging.getLogger(__name__)


class EngineError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.engine_error_code = code


def get_engine(name):
    if name == "faster_whisper":
        from engines import faster_whisper_engine
        return faster_whisper_engine
    raise EngineError("engine_not_found", "unknown engine: %s" % name)


def list_engines():
    available = {"faster_whisper": False}
    try:
        import faster_whisper  # noqa: F401
        available["faster_whisper"] = True
    except ImportError:
        pass
    return available
```

- [ ] **Step 2.3: 创建 `python-engine/engines/faster_whisper_engine.py`**

从 POC 参考实现，核心逻辑：

```python
"""faster-whisper 引擎。"""

import logging
import threading

from engines import EngineError

log = logging.getLogger(__name__)
_model_cache = {}
_model_lock = threading.Lock()


def _load_faster_whisper():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError as exc:
        raise EngineError(
            "engine_not_installed",
            "faster-whisper is not installed: %s" % exc,
        )


def _get_model(model, device, compute_type, download_root=None):
    key = (model, device, compute_type, download_root)
    with _model_lock:
        if key not in _model_cache:
            WhisperModel = _load_faster_whisper()
            kwargs = {"device": device, "compute_type": compute_type}
            if download_root:
                kwargs["download_root"] = download_root
            log.info("loading model %s device=%s compute_type=%s", model, device, compute_type)
            _model_cache[key] = WhisperModel(model, **kwargs)
        return _model_cache[key]


def transcribe(params, emit_event, is_cancelled):
    audio_file = params.get("audio_file")
    if not audio_file:
        raise EngineError("invalid_params", "audio_file is required")

    model = _get_model(
        params.get("model", "base"),
        params.get("device", "auto"),
        params.get("compute_type", "auto"),
        params.get("download_root"),
    )

    language = params.get("language")
    if language in (None, "", "auto"):
        language = None

    emit_event("progress", {"percent": 0})
    segments_iter, info = model.transcribe(
        audio_file,
        language=language,
        initial_prompt=params.get("initial_prompt") or None,
        word_timestamps=bool(params.get("word_timestamps", False)),
        vad_filter=bool(params.get("vad", True)),
        vad_parameters={
            "threshold": float(params.get("vad_threshold", 0.5)),
            "min_speech_duration_ms": int(params.get("vad_min_speech_duration_ms", 250)),
            "min_silence_duration_ms": int(params.get("vad_min_speech_duration_ms", 100)),
            "speech_pad_ms": int(params.get("vad_speech_pad_ms", 30)),
        },
    )

    total = float(info.duration or 0) or None
    segments = []
    for seg in segments_iter:
        if is_cancelled():
            return None
        segment = {"start": seg.start, "end": seg.end, "text": seg.text}
        if params.get("word_timestamps") and seg.words:
            segment["words"] = [
                {"start": w.start, "end": w.end, "word": w.word} for w in seg.words
            ]
        segments.append(segment)
        emit_event("segment", segment)
        if total:
            emit_event("progress", {"percent": round(min(seg.end / total * 100, 99.0), 2)})

    return {
        "engine": "faster_whisper",
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": segments,
    }
```

- [ ] **Step 2.4: 创建 `python-engine/main.py`**

参考 POC 完整骨架：`ping` / `transcribe` / `cancel` / `shutdown`；worker 线程执行 transcribe；stdout 仅 JSON-lines。

- [ ] **Step 2.5: 创建 `python-engine/smartsub-engine.spec`**

PyInstaller onedir；`collect_all` 包含 `faster_whisper`, `ctranslate2`, `tokenizers`, `huggingface_hub`, `av`；`excludes` 去掉 matplotlib/scipy/pandas 等；`console=True`。

- [ ] **Step 2.6: 创建 `python-engine/smoke_test.py`**

```python
#!/usr/bin/env python3
"""对冻结产物或 dev main.py 做 ping 冒烟。"""
import json
import subprocess
import sys


def run_smoke(command, args):
    proc = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdin.write(json.dumps({"id": "1", "method": "ping", "params": {}}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    proc.stdin.write(json.dumps({"method": "shutdown", "params": {}}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=10)
    data = json.loads(line)
    assert "result" in data, data
    assert "engines" in data["result"], data
    print("smoke ok:", data["result"])


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run_smoke(sys.argv[1], sys.argv[2:])
    else:
        run_smoke(sys.executable, ["main.py"])
```

- [ ] **Step 2.7: 更新 `.gitignore`**

追加：

```
python-engine/.venv/
python-engine/dist/
python-engine/build/
python-engine/__pycache__/
python-engine/**/*.pyc
```

- [ ] **Step 2.8: 本地 dev 冒烟（可选，需本机 Python 3.11）**

```bash
cd python-engine
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python smoke_test.py
```

- [ ] **Step 2.9: Commit**

```bash
git add python-engine/ .gitignore
git commit -m "$(cat <<'EOF'
feat: add python-engine sidecar source for faster-whisper

PyInstaller-ready sidecar with JSON-lines protocol and faster-whisper engine.
EOF
)"
```

---

## Task 3: Python 引擎 CI 工作流

**Files:**

- Create: `.github/workflows/python-engine.yml`

- [ ] **Step 3.1: 创建 `.github/workflows/python-engine.yml`**

参考 POC 与 spec §4.4，矩阵四平台：

```yaml
name: Build Python Engine

on:
  workflow_dispatch:
  push:
    tags:
      - 'py-engine-v*'

jobs:
  build_engine:
    name: Engine ${{ matrix.artifact_suffix }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            artifact_suffix: macos-arm64
          - os: macos-15-intel
            artifact_suffix: macos-x64
          - os: windows-2022
            artifact_suffix: windows-x64
          - os: ubuntu-22.04
            artifact_suffix: linux-x64
    defaults:
      run:
        working-directory: python-engine
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip
          cache-dependency-path: python-engine/requirements.txt
      - run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt pyinstaller
      - run: pyinstaller --clean --noconfirm smartsub-engine.spec
      - run: python smoke_test.py dist/smartsub-engine/smartsub-engine$([[ "$RUNNER_OS" == "Windows" ]] && echo .exe)
        shell: bash
      - run: tar -czf smartsub-engine-${{ matrix.artifact_suffix }}.tar.gz -C dist smartsub-engine
        shell: bash
      - run: |
          cd ..
          sha256sum python-engine/smartsub-engine-*.tar.gz > checksums.sha256
        shell: bash
      - uses: actions/upload-artifact@v4
        with:
          name: py-engine-${{ matrix.artifact_suffix }}
          path: |
            python-engine/smartsub-engine-${{ matrix.artifact_suffix }}.tar.gz
            checksums.sha256

  publish_engine:
    needs: build_engine
    if: startsWith(github.ref, 'refs/tags/py-engine-v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts
          merge-multiple: true
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: ${{ github.ref_name }}
          files: artifacts/**
```

- [ ] **Step 3.2: Commit**

```bash
git add .github/workflows/python-engine.yml
git commit -m "$(cat <<'EOF'
ci: add python-engine build workflow for cross-platform sidecar releases
EOF
)"
```

---

## Task 4: PythonRuntime 协议与 Manager

**Files:**

- Create: `main/helpers/pythonRuntime/protocol.ts`
- Create: `main/helpers/pythonRuntime/paths.ts`
- Create: `main/helpers/pythonRuntime/manager.ts`
- Create: `main/helpers/pythonRuntime/index.ts`

- [ ] **Step 4.1: 创建 `main/helpers/pythonRuntime/protocol.ts`**

```typescript
export interface EngineRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineErrorPayload {
  code: string;
  message: string;
}

export interface EngineResponse {
  id: string;
  result?: unknown;
  error?: EngineErrorPayload;
}

export type EngineMessage = EngineResponse | EngineNotification;

export interface PingResult {
  version: string;
  python: string;
  frozen: boolean;
  engines: Record<string, boolean>;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; word: string }>;
}

export interface TranscribeResult {
  engine: string;
  language?: string;
  languageProbability?: number;
  duration?: number;
  segments: TranscribeSegment[];
}

export interface TranscribeHandlers {
  onProgress?: (percent: number) => void;
  onSegment?: (segment: TranscribeSegment) => void;
}
```

- [ ] **Step 4.2: 创建 `main/helpers/pythonRuntime/paths.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { PyEngineManifest } from '../../../types/engine';

export const PY_ENGINE_TAG = 'py-engine-v0.1.0';

export function getPyEngineRoot(): string {
  return path.join(app.getPath('userData'), 'py-engine');
}

export function getPyEngineCurrentDir(): string {
  return path.join(getPyEngineRoot(), 'current');
}

export function getPyEngineBinaryName(): string {
  return process.platform === 'win32'
    ? 'smartsub-engine.exe'
    : 'smartsub-engine';
}

export function getPyEngineBinaryPath(): string {
  return path.join(getPyEngineCurrentDir(), getPyEngineBinaryName());
}

export function getPyEngineCacheDir(): string {
  return path.join(app.getPath('userData'), 'py-engine-cache');
}

export function isPyEngineInstalled(): boolean {
  return fs.existsSync(getPyEngineBinaryPath());
}

export function readPyEngineManifest(): PyEngineManifest | null {
  const manifestPath = path.join(getPyEngineRoot(), 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as PyEngineManifest;
  } catch {
    return null;
  }
}

export function writePyEngineManifest(manifest: PyEngineManifest): void {
  const root = getPyEngineRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

export function getPyEngineArtifactSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function getPyEngineDownloadUrl(
  source: 'github' | 'ghproxy',
  tag: string = PY_ENGINE_TAG,
): string {
  const asset = `smartsub-engine-${getPyEngineArtifactSuffix()}.tar.gz`;
  const base = `https://github.com/buxuku/SmartSub/releases/download/${tag}/${asset}`;
  if (source === 'ghproxy') {
    return `https://ghfast.top/${base}`;
  }
  return base;
}
```

- [ ] **Step 4.3: 创建 `main/helpers/pythonRuntime/manager.ts`**

参考 POC `PythonEngineManager`，实现：

- `buildSanitizedEnv()` — 清除 `PYTHONPATH`/`CONDA_*` 等
- `ensureStarted()` — spawn + ping
- `request()` / `transcribe()` / `cancel()` / `stop()`
- `handleLine()` — 解析 JSON-lines，分发 result/error/event
- `handleExit()` — reject 全部 pending

导出 `PythonEngineError` 类（`code` 字段）。

- [ ] **Step 4.4: 创建 `main/helpers/pythonRuntime/index.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from '../storeManager';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  getPyEngineBinaryPath,
  getPyEngineCacheDir,
  getPyEngineCurrentDir,
  isPyEngineInstalled,
} from './paths';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (app.isPackaged) {
    if (!isPyEngineInstalled()) {
      throw new Error('Python engine is not installed');
    }
    const command = getPyEngineBinaryPath();
    return {
      command,
      args: [],
      cwd: getPyEngineCurrentDir(),
      env: { HF_HOME: getPyEngineCacheDir() },
    };
  }

  const engineDir = path.join(app.getAppPath(), 'python-engine');
  const venvPython =
    process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
  const fallback = process.platform === 'win32' ? 'python' : 'python3';
  return {
    command: fs.existsSync(venvPython) ? venvPython : fallback,
    args: [path.join(engineDir, 'main.py')],
    cwd: engineDir,
    env: { HF_HOME: getPyEngineCacheDir() },
  };
}

let manager: PythonRuntimeManager | null = null;

export function getPythonRuntimeManager(): PythonRuntimeManager {
  if (!manager) {
    manager = new PythonRuntimeManager(resolveEngineCommand, (msg, level) =>
      logMessage(msg, level),
    );
  }
  return manager;
}

export async function shutdownPythonRuntime(): Promise<void> {
  if (manager) await manager.stop();
}
```

- [ ] **Step 4.5: 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 4.6: Commit**

```bash
git add main/helpers/pythonRuntime/
git commit -m "$(cat <<'EOF'
feat: add PythonRuntimeManager with JSON-lines sidecar protocol
EOF
)"
```

---

## Task 5: PyEngineDownloader

**Files:**

- Create: `main/helpers/pythonRuntime/downloader.ts`

- [ ] **Step 5.1: 实现 `PyEngineDownloader` 类**

仿 `main/helpers/addonDownloader.ts` 结构，核心方法：

```typescript
export class PyEngineDownloader {
  async download(source: PyEngineDownloadSource, tag?: string): Promise<void>;
  cancel(): void;
  getProgress(): PyEngineDownloadProgress;
}
```

下载流程：

1. URL = `getPyEngineDownloadUrl(source, tag)`
2. 断点续传到 `userData/py-engine/downloads/temp.tar.gz`
3. 状态持久化 `userData/py-engine-download-state.json`
4. 下载 checksums（同 tag Release）校验 SHA256
5. 解压到 `userData/py-engine/staging/`
6. 确认入口二进制存在 → `fs.rmSync(current)` → `fs.renameSync(staging, current)`
7. 写入 `manifest.json`
8. 发送 `py-engine-download-progress` 到 mainWindow

- [ ] **Step 5.2: 导出单例**

```typescript
let instance: PyEngineDownloader | null = null;
export function getPyEngineDownloader(
  mainWindow?: BrowserWindow,
): PyEngineDownloader;
```

- [ ] **Step 5.3: Commit**

```bash
git add main/helpers/pythonRuntime/downloader.ts
git commit -m "$(cat <<'EOF'
feat: add PyEngineDownloader with resume and checksum verification
EOF
)"
```

---

## Task 6: 引擎抽象层与转写路由

**Files:**

- Create: `main/helpers/transcriptionEngine.ts`
- Create: `main/helpers/engines/types.ts`
- Create: `main/helpers/engines/registry.ts`
- Create: `main/helpers/engines/builtinEngine.ts`
- Create: `main/helpers/engines/fasterWhisperEngine.ts`
- Create: `main/helpers/engines/localCliEngine.ts`
- Create: `main/helpers/transcriptionRouter.ts`
- Modify: `main/helpers/subtitleGenerator.ts`
- Modify: `main/helpers/fileProcessor.ts`

- [ ] **Step 6.1: 创建 `main/helpers/transcriptionEngine.ts`**

```typescript
import type { TranscriptionEngine } from '../../types/engine';
import type { StoreType } from './store/types';

export function resolveTranscriptionEngine(
  settings: StoreType['settings'] | undefined,
): TranscriptionEngine {
  if (settings?.transcriptionEngine) return settings.transcriptionEngine;
  return settings?.useLocalWhisper ? 'localCli' : 'builtin';
}
```

- [ ] **Step 6.2: 创建 `main/helpers/engines/types.ts`**

```typescript
import type { TranscriptionEngine, EngineStatus } from '../../../types/engine';
import type { IpcMainInvokeEvent } from 'electron';
import type { IFiles } from '../../../types';

export interface TranscribeContext {
  event: IpcMainInvokeEvent;
  file: IFiles;
  formData: Record<string, unknown>;
  hasOpenAiWhisper: boolean;
}

export interface TranscriptionEngineAdapter {
  id: TranscriptionEngine;
  displayName: string;
  requiresRuntime: boolean;
  isAvailable(): Promise<EngineStatus>;
  transcribe(ctx: TranscribeContext): Promise<string>;
  cancelActive?(): void;
}
```

- [ ] **Step 6.3: 创建三个 adapter**

- `builtinEngine.ts` — 调用现有 `generateSubtitleWithBuiltinWhisper`
- `localCliEngine.ts` — 调用现有 `generateSubtitleWithLocalWhisper`
- `fasterWhisperEngine.ts` — 新建 `generateSubtitleWithFasterWhisper`（从 POC 参考）：

  - `ensureStarted()` 检查 `engines.faster_whisper`
  - 参数含 `engine`, `audio_file`, `model`, `language`, `device`, `compute_type`, VAD 字段
  - `toFasterWhisperModel()` 剥掉 `-q5_0` 等量化后缀
  - segments → `formatSrtContent` → 写 srt 文件
  - 进度/分段事件映射到 `taskProgressChange` / `taskFileChange`

- [ ] **Step 6.4: 创建 `main/helpers/engines/registry.ts`**

```typescript
import { builtinEngineAdapter } from './builtinEngine';
import { fasterWhisperEngineAdapter } from './fasterWhisperEngine';
import { localCliEngineAdapter } from './localCliEngine';
import { resolveTranscriptionEngine } from '../transcriptionEngine';
import { store } from '../storeManager';

const adapters = [
  builtinEngineAdapter,
  fasterWhisperEngineAdapter,
  localCliEngineAdapter,
];

export function getEngineAdapter(id: string) {
  return adapters.find((a) => a.id === id);
}

export function getActiveEngineAdapter() {
  const id = resolveTranscriptionEngine(store.get('settings'));
  return getEngineAdapter(id) ?? builtinEngineAdapter;
}

export function listEngineAdapters() {
  return adapters;
}
```

- [ ] **Step 6.5: 创建 `main/helpers/transcriptionRouter.ts`**

```typescript
import { getActiveEngineAdapter } from './engines/registry';
import type { TranscribeContext } from './engines/types';

export async function routeTranscription(
  ctx: TranscribeContext,
): Promise<string> {
  const adapter = getActiveEngineAdapter();
  const status = await adapter.isAvailable();
  if (status.state !== 'ready') {
    throw new Error(
      `${adapter.displayName} is not available: ${status.message || status.state}`,
    );
  }
  return adapter.transcribe(ctx);
}
```

- [ ] **Step 6.6: 修改 `main/helpers/fileProcessor.ts`**

将 `generateSubtitle` 改为：

```typescript
import { routeTranscription } from './transcriptionRouter';

async function generateSubtitle(event, file, formData, hasOpenAiWhisper) {
  try {
    return await routeTranscription({
      event,
      file,
      formData,
      hasOpenAiWhisper,
    });
  } catch (error) {
    onError(event, file, 'extractSubtitle', error);
    throw error;
  }
}
```

删除对 `generateSubtitleWithBuiltinWhisper` 等的直接 import。

- [ ] **Step 6.7: 类型检查 + Commit**

```bash
npx tsc --noEmit
git add main/helpers/transcriptionEngine.ts main/helpers/engines/ main/helpers/transcriptionRouter.ts main/helpers/subtitleGenerator.ts main/helpers/fileProcessor.ts
git commit -m "$(cat <<'EOF'
feat: add engine registry and transcription router for multi-engine support
EOF
)"
```

---

## Task 7: 双轨模型目录（含老用户兼容）

**Files:**

- Create: `main/helpers/modelCatalog.ts`
- Create: `renderer/lib/fasterWhisperModels.json`
- Modify: `main/helpers/whisper.ts`（仅追加，不改 `getModelsInstalled`）
- Modify: `main/helpers/systemInfoManager.ts`

- [ ] **Step 7.1: 创建 `main/helpers/modelCatalog.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { store } from './storeManager';
import { getPath } from './whisper';

/** ggml 路径：语义不变，复用 getPath('modelsPath') */
export function getGgmlModelsPath(): string {
  return getPath('modelsPath') as string;
}

export function getFasterWhisperModelsPath(): string {
  const settings = store.get('settings');
  const userData = app.getPath('userData');
  const resolved =
    settings?.fasterWhisperModelsPath ||
    path.join(userData, 'faster-whisper-models');
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/** 扫描 HF 缓存目录，返回逻辑模型 id 列表 */
export function getFasterWhisperModelsInstalled(): string[] {
  const root = getFasterWhisperModelsPath();
  const cache = path.join(app.getPath('userData'), 'py-engine-cache');
  const dirs = [root, cache];
  const found = new Set<string>();
  const prefix = 'models--Systran--faster-whisper-';

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        found.add(entry.slice(prefix.length).replace(/-/g, '.'));
      }
      // 也支持直接以模型 id 命名的子目录（手动导入）
      if (fs.existsSync(path.join(dir, entry, 'model.bin'))) {
        found.add(entry);
      }
    }
  }
  return Array.from(found).sort();
}

/** ggml 模型名 → faster-whisper id */
export function toFasterWhisperModelId(ggmlName: string): string {
  const base = ggmlName
    .toLowerCase()
    .replace(/-q\d+_\d+$/, '')
    .replace(/\.en$/, '.en');
  const map: Record<string, string> = {
    'large-v3-turbo': 'large-v3-turbo',
    'large-v3': 'large-v3',
    'large-v2': 'large-v2',
    'large-v1': 'large-v1',
  };
  return map[base] || base;
}
```

**硬性约束：** 不修改 `getModelsInstalled()`、`getPath()`、`deleteModel()` 的任何逻辑。

- [ ] **Step 7.2: 创建 `renderer/lib/fasterWhisperModels.json`**

```json
[
  { "id": "tiny", "size": "~75MB", "tier": "fast" },
  { "id": "base", "size": "~145MB", "tier": "fast" },
  { "id": "small", "size": "~466MB", "tier": "balanced" },
  { "id": "medium", "size": "~1.5GB", "tier": "balanced" },
  { "id": "large-v3", "size": "~3GB", "tier": "accurate" },
  { "id": "large-v3-turbo", "size": "~1.6GB", "tier": "accurate" }
]
```

- [ ] **Step 7.3: 扩展 `main/helpers/systemInfoManager.ts` getSystemInfo**

```typescript
import { resolveTranscriptionEngine } from './transcriptionEngine';
import {
  getFasterWhisperModelsInstalled,
  getFasterWhisperModelsPath,
} from './modelCatalog';
import { isPyEngineInstalled, readPyEngineManifest } from './pythonRuntime/paths';

// getSystemInfo handler 返回追加：
fasterWhisperModelsInstalled: getFasterWhisperModelsInstalled(),
fasterWhisperModelsPath: getFasterWhisperModelsPath(),
transcriptionEngine: resolveTranscriptionEngine(store.get('settings')),
pythonEngineStatus: {
  state: isPyEngineInstalled() ? 'ready' : 'not_installed',
  version: readPyEngineManifest()?.version,
},
```

- [ ] **Step 7.4: Commit**

```bash
git add main/helpers/modelCatalog.ts renderer/lib/fasterWhisperModels.json main/helpers/systemInfoManager.ts
git commit -m "$(cat <<'EOF'
feat: add dual-track model catalog with ggml path backward compatibility
EOF
)"
```

---

## Task 8: 引擎 IPC Handlers

**Files:**

- Create: `main/helpers/ipcEngineHandlers.ts`
- Modify: `main/background.ts`

- [ ] **Step 8.1: 创建 `main/helpers/ipcEngineHandlers.ts`**

注册以下 IPC：

| Channel                           | 说明                                     |
| --------------------------------- | ---------------------------------------- |
| `get-transcription-engine`        | 返回当前引擎 id                          |
| `set-transcription-engine`        | 设置引擎；fasterWhisper 时检查安装状态   |
| `get-engine-status`               | 列出所有 adapter 的 `isAvailable()`      |
| `start-py-engine-download`        | `{ source, tag? }` 开始下载              |
| `cancel-py-engine-download`       | 取消下载                                 |
| `get-py-engine-download-progress` | 返回当前进度                             |
| `uninstall-py-engine`             | 删除 `current/` + manifest，stop sidecar |
| `python-engine:ping`              | dev 调试用                               |
| `set-faster-whisper-settings`     | 更新 device / compute_type               |

`set-transcription-engine` 逻辑：

```typescript
ipcMain.handle(
  'set-transcription-engine',
  async (_event, engine: TranscriptionEngine) => {
    if (engine === 'fasterWhisper' && !isPyEngineInstalled()) {
      return { success: false, error: 'engine_not_installed' };
    }
    const settings = store.get('settings');
    store.set('settings', {
      ...settings,
      transcriptionEngine: engine,
      useLocalWhisper: engine === 'localCli',
    });
    return { success: true };
  },
);
```

- [ ] **Step 8.2: 修改 `main/background.ts`**

```typescript
import {
  registerEngineIpcHandlers,
  setMainWindowForEngine,
} from './helpers/ipcEngineHandlers';
import { shutdownPythonRuntime } from './helpers/pythonRuntime';

// createWindow 后：
registerEngineIpcHandlers();
setMainWindowForEngine(mainWindow);

// app.on('before-quit'):
await shutdownPythonRuntime();
```

- [ ] **Step 8.3: DevTools 冒烟**

```bash
yarn dev
```

Console：

```javascript
await window.ipc.invoke('get-engine-status');
await window.ipc.invoke('get-transcription-engine');
```

- [ ] **Step 8.4: Commit**

```bash
git add main/helpers/ipcEngineHandlers.ts main/background.ts
git commit -m "$(cat <<'EOF'
feat: register engine IPC handlers and wire python runtime lifecycle
EOF
)"
```

---

## Task 9: 资源中心 Engines Tab

**Files:**

- Create: `renderer/components/resources/EnginesTab.tsx`
- Modify: `renderer/pages/[locale]/resources.tsx`
- Modify: `renderer/public/locales/zh/resources.json`
- Modify: `renderer/public/locales/en/resources.json`

- [ ] **Step 9.1: 扩展 i18n — `renderer/public/locales/zh/resources.json`**

在 `tab` 中追加 `"engines": "引擎"`，并新增：

```json
"engines": {
  "title": "转写引擎",
  "description": "选择用于语音转文字的引擎。默认 whisper.cpp 已内置；faster-whisper 需额外下载。",
  "builtin": {
    "name": "whisper.cpp（内置）",
    "desc": "默认引擎，支持 ggml 量化模型与 GPU 加速",
    "statusReady": "已就绪"
  },
  "fasterWhisper": {
    "name": "faster-whisper",
    "desc": "基于 CTranslate2，速度更快，模型按需从 HuggingFace 下载",
    "notInstalled": "未安装",
    "installed": "已安装 v{{version}}",
    "download": "下载引擎（约 {{size}}）",
    "downloading": "下载中…",
    "uninstall": "卸载",
    "select": "设为当前引擎",
    "selected": "当前引擎",
    "device": "计算设备",
    "computeType": "精度",
    "downloadConfirm": "将下载 faster-whisper 引擎运行时（约 170MB），是否继续？"
  },
  "localCli": {
    "name": "本地命令行",
    "desc": "使用自行安装的 Whisper 兼容 CLI",
    "configure": "配置命令"
  },
  "switchBlocked": "有任务正在运行，请等待完成后再切换引擎"
}
```

英文 `en/resources.json` 同步翻译。

- [ ] **Step 9.2: 更新 `renderer/pages/[locale]/resources.tsx`**

```typescript
export const RESOURCE_TABS = [
  'overview',
  'engines',   // 新增，放在 models 前
  'models',
  'providers',
  'acceleration',
] as const;

// import EnginesTab
<TabsTrigger value="engines">{t('tab.engines')}</TabsTrigger>
<TabsContent value="engines"><EnginesTab /></TabsContent>
```

`getStaticProps` locales 已含 `resources`，无需改。

- [ ] **Step 9.3: 创建 `renderer/components/resources/EnginesTab.tsx`**

三张 `Card`，每张含：

- 名称 / 描述 / 状态 Badge
- 「设为当前」Button（已选中显示 disabled +「当前引擎」）
- faster-whisper 卡片额外：
  - 未安装 → 「下载引擎」Button → `AlertDialog` 确认 → `start-py-engine-download`
  - 下载中 → `Progress` 条（监听 `py-engine-download-progress`）
  - 已安装 → 版本号 + 「卸载」
  - 展开区：`Select` device / compute_type → `set-faster-whisper-settings`

刷新逻辑：`useEffect` 调 `get-engine-status` + `get-transcription-engine`。

切换引擎调 `set-transcription-engine`；若返回 `engine_not_installed` 则引导下载。

- [ ] **Step 9.4: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
node scripts/check-i18n.mjs
```

- [ ] **Step 9.5: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx renderer/pages/[locale]/resources.tsx renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "$(cat <<'EOF'
feat: add Engines tab to resource hub for transcription engine management
EOF
)"
```

---

## Task 10: Models Tab 引擎筛选器

**Files:**

- Modify: `renderer/components/resources/ModelsTab.tsx`
- Modify: `renderer/public/locales/zh/modelsControl.json`
- Modify: `renderer/public/locales/en/modelsControl.json`

- [ ] **Step 10.1: i18n 追加模型筛选文案**

`modelsControl.json` 追加：

```json
"engineFilter": {
  "label": "引擎",
  "builtin": "whisper.cpp",
  "fasterWhisper": "faster-whisper"
},
"fasterWhisperModelTip": "faster-whisper 使用 HuggingFace CT2 模型，与 ggml 模型分开存放",
"fasterWhisperModelsPath": "faster-whisper 模型路径"
```

- [ ] **Step 10.2: ModelsTab 顶部加 Segmented Control**

```typescript
type ModelEngineFilter = 'builtin' | 'fasterWhisper';
const [engineFilter, setEngineFilter] = useState<ModelEngineFilter>('builtin');
```

- `engineFilter === 'builtin'` → **现有逻辑完全不变**（同一 JSX 分支，不改动 ggml 列表渲染代码）
- `engineFilter === 'fasterWhisper'` → 读取 `fasterWhisperModels.json`；已安装状态用 `systemInfo.fasterWhisperModelsInstalled`；下载按钮调新 IPC `download-faster-whisper-model`（Task 10.3 实现）

路径展示：

- builtin → `systemInfo.modelsPath`
- fasterWhisper → `systemInfo.fasterWhisperModelsPath`

- [ ] **Step 10.3: 新增 IPC `download-faster-whisper-model`**

在 `ipcEngineHandlers.ts`：

```typescript
ipcMain.handle(
  'download-faster-whisper-model',
  async (event, { model, source }) => {
    const manager = getPythonRuntimeManager();
    await manager.ensureStarted();
    // 触发一次 transcribe ping 或专用 preload 请求，让 sidecar 下载模型
    // 简化实现：调用 transcribe 的 preload 参数 { engine: 'faster_whisper', model, preload_only: true }
    // 或在 faster_whisper_engine 增加 preload handler
  },
);
```

**最简 v1 实现：** 在 `faster_whisper_engine.py` 增加 `preload` method，只 `_get_model()` 不转写；IPC 调 `manager.request('preload', { model })`。

- [ ] **Step 10.4: Commit**

```bash
git add renderer/components/resources/ModelsTab.tsx renderer/public/locales/zh/modelsControl.json renderer/public/locales/en/modelsControl.json main/helpers/ipcEngineHandlers.ts python-engine/
git commit -m "$(cat <<'EOF'
feat: add engine filter to Models tab with separate faster-whisper catalog
EOF
)"
```

---

## Task 11: Overview 联动与任务页模型下拉

**Files:**

- Modify: `renderer/components/resources/OverviewTab.tsx`
- Modify: `renderer/components/Models.tsx`
- Modify: `renderer/components/tasks/InlineConfigBar.tsx`

- [ ] **Step 11.1: OverviewTab 增加引擎卡片**

在现有三卡后追加第四卡「转写引擎」：

- 显示当前引擎名称（builtin → whisper.cpp / fasterWhisper / localCli）
- faster-whisper 未安装时黄色警告
- 「管理」按钮 → `onNavigateTab('engines')`

- [ ] **Step 11.2: 修改 `renderer/components/Models.tsx`**

新增 props：

```typescript
interface IProps {
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
  transcriptionEngine?: 'builtin' | 'fasterWhisper' | 'localCli';
  useLocalWhisper?: boolean;
}
```

`getAvailableModels()` 逻辑：

```typescript
const engine =
  props.transcriptionEngine ?? (props.useLocalWhisper ? 'localCli' : 'builtin');
if (engine === 'fasterWhisper') {
  return props.fasterWhisperModelsInstalled || [];
}
if (engine === 'localCli') {
  return models.map((m) => m.name); // 现有
}
return props.modelsInstalled || []; // builtin：仅已安装 ggml
```

- [ ] **Step 11.3: 修改 `InlineConfigBar.tsx`**

传入新 props：

```typescript
<Models
  transcriptionEngine={systemInfo?.transcriptionEngine}
  fasterWhisperModelsInstalled={systemInfo?.fasterWhisperModelsInstalled}
  modelsInstalled={systemInfo?.modelsInstalled}
  useLocalWhisper={useLocalWhisper}
  ...
/>
```

- [ ] **Step 11.4: Commit**

```bash
git add renderer/components/resources/OverviewTab.tsx renderer/components/Models.tsx renderer/components/tasks/InlineConfigBar.tsx renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "$(cat <<'EOF'
feat: wire engine-aware model dropdown and overview engine card
EOF
)"
```

---

## Task 12: 收尾 — package.json scripts、文档、全量验证

**Files:**

- Modify: `package.json`
- Modify: `docs/docs/configuration/models.md`（简短补充双引擎说明）

- [ ] **Step 12.1: 添加开发脚本 `package.json`**

```json
"engine:build": "node scripts/build-py-engine.js",
"engine:smoke": "cd python-engine && python smoke_test.py"
```

并创建 `scripts/build-py-engine.js`（从 POC 参考，调用 PyInstaller）。

- [ ] **Step 12.2: 确认 `electron-builder.yml` 不含 py-engine**

确认 `extraResources` 无 `py-engine/` 条目（spec 要求零 bundle）。

- [ ] **Step 12.3: 全量类型检查**

```bash
npx tsc --noEmit
npx tsc --noEmit -p renderer/tsconfig.json
node scripts/check-i18n.mjs
```

- [ ] **Step 12.4: 生产构建**

```bash
yarn build
```

- [ ] **Step 12.5: 手工冒烟清单**

| #   | 场景                                            | 预期                                                   |
| --- | ----------------------------------------------- | ------------------------------------------------------ |
| 1   | 老用户升级（无新 settings 字段）                | 默认 builtin；`modelsPath` 下 ggml 仍显示在 Models Tab |
| 2   | 资源中心 → 引擎 Tab                             | 显示三引擎卡片；whisper.cpp 为当前                     |
| 3   | 下载 faster-whisper（需先有 py-engine Release） | 进度条 → 安装完成 → 可切换                             |
| 4   | 切换引擎后 Models Tab 筛选                      | ggml / faster-whisper 列表各自独立                     |
| 5   | faster-whisper + tiny 转写                      | 产出 SRT；任务卡片有进度                               |
| 6   | 切换回 builtin + 已有 ggml 模型                 | 正常转写，无回归                                       |
| 7   | DevTools `python-engine:ping`                   | 返回 engines.faster_whisper=true（安装后）             |

- [ ] **Step 12.6: Commit**

```bash
git add package.json scripts/build-py-engine.js docs/docs/configuration/models.md
git commit -m "$(cat <<'EOF'
chore: add py-engine build scripts and document dual-engine model paths
EOF
)"
```

---

## Spec 覆盖自检

| Spec 章节      | 对应 Task                         |
| -------------- | --------------------------------- |
| §3 模块设计    | Task 4–6                          |
| §4 分发/CI     | Task 3, 5                         |
| §5 模型兼容    | Task 7, 10（builtin 分支零改动）  |
| §6 Engines Tab | Task 9                            |
| §7 转写链路    | Task 6, 8                         |
| §8 Store 迁移  | Task 1, 6.1                       |
| §9 风险规避    | Task 4 env 消毒, 5 校验, 6 cancel |
| §10 测试       | Task 2 smoke, 12 冒烟清单         |
| §11 实施顺序   | Task 0–12 顺序                    |

无 TBD / 占位符。

---

## 执行方式

**Plan 已保存至 `docs/superpowers/plans/2026-06-13-multi-engine.md`。两种执行方式：**

1. **Subagent-Driven（推荐）** — 每个 Task 派发独立 subagent，Task 间做代码审查，迭代快
2. **Inline Execution** — 在本会话按 Task 顺序直接实现，每 2–3 个 Task 设检查点

你想用哪种方式开始？
