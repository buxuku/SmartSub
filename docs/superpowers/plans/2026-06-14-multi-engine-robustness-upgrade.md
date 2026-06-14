# 多引擎健壮性收口 · 引擎独立升级 · Windows ping-timeout 修复 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/superpowers/specs/2026-06-14-multi-engine-robustness-upgrade-impl-design.md` 中除 Qwen 外的全部条目，并根治 Windows「ping timeout 15000」。

**Architecture:** 五个 Phase 按优先级推进（0→1→2→3→4）。Phase 0 修复 sidecar 生命周期（ping 根因 + 进程清理 + 预热），是 Phase 2 安全升级的前置；Phase 1 统一取消语义；Phase 2 做安全升级 + 更新检测 + 协议协商（含上游 py-engine 改动）；Phase 3 钳制 faster-whisper 并发；Phase 4 把引擎实现搬进各自 `engines/*.ts` 并收口（signal 入 ctx、模型名映射）。

**Tech Stack:** Electron + nextron(Next.js 14) + TypeScript（主进程 `main/`、渲染 `renderer/`）；Python sidecar（faster-whisper，PyInstaller onedir，独立仓库 `smartsub-py-engine`）；electron-store 持久化；i18n via next-i18next。

---

## 约定（Conventions）

- **两个仓库**：
  - APP = `/Users/xiaodong/Documents/code/SmartSub`（当前仓库，分支 `feat/multi-engine`）。
  - PYENG = `/Users/xiaodong/Documents/code/smartsub-py-engine`（上游，独立提交/发版）。
- **本项目无自动化测试 runner**（无 `test` 脚本、无 jest/vitest）。每个改代码的 Task 用以下校验：
  - APP 类型检查/构建：`npm run build`（= `nextron build --no-pack`，含 tsc）。期望：无类型错误、构建成功。
  - APP i18n：动 locale 后 `npm run check:i18n`。期望：通过。
  - APP 格式：提交时 lint-staged 自动跑 prettier（无需手动）。
  - PYENG 冒烟：`python smoke_test.py`（dev）或 `python smoke_test.py dist/smartsub-engine/smartsub-engine`（冻结）。期望：`smoke ok: {... 'engines': {...}}`。
- **提交粒度**：每个 Task 末尾单独提交（atomic）。APP 与 PYENG 分别在各自仓库提交。
- **不引入** 任何 Qwen3-ASR 代码/依赖/UI。

---

# Phase 0 · 引擎生命周期健壮性（含 ping-timeout 根因修复）

## Task 0.1: py-engine `list_engines()` 改 find_spec（ping 根因修复）

**Files:**

- Modify: `PYENG/engines/__init__.py:22-30`

- [ ] **Step 1: 改写 list_engines 为只探测不导入**

把现有 `list_engines`（内部 `import faster_whisper`）替换为：

```python
import importlib.util

def list_engines():
    """只探测依赖是否可导入，不真正导入（避免重依赖拖慢 ping）。"""
    return {
        "faster_whisper": importlib.util.find_spec("faster_whisper") is not None,
    }
```

保留文件顶部已有的 `import logging` / `log` / `EngineError` / `get_engine` 不变；仅新增 `import importlib.util`（放文件顶部）并替换 `list_engines` 函数体。

- [ ] **Step 2: dev 冒烟验证 ping 立即返回**

Run（PYENG 目录，已装依赖的 venv）：`python smoke_test.py`
Expected：输出 `smoke ok: {'version': '0.1.0', ..., 'engines': {'faster_whisper': True}}`，且瞬时返回（无数秒卡顿）。

若依赖未装（裸环境），应得到 `{'faster_whisper': False}` 且不报错——同样证明未触发重导入。

- [ ] **Step 3: 提交（PYENG 仓库）**

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
git add engines/__init__.py
git commit -m "fix(ping): probe faster_whisper via find_spec to keep ping fast (no eager import)"
```

---

## Task 0.2: app `PythonRuntimeManager` —— 启动超时/进程清理/重试

**Files:**

- Modify: `APP/main/helpers/pythonRuntime/manager.ts:46`（超时常量）
- Modify: `APP/main/helpers/pythonRuntime/manager.ts:102-144`（`start()`）

- [ ] **Step 1: 调整启动超时常量**

把 `manager.ts:46`：

```ts
export const STARTUP_TIMEOUT_MS = 15_000;
```

改为：

```ts
// 冷启动 ping 超时：Windows PyInstaller onedir 首次加载 + 杀软扫描可能较久。
// 重依赖已推迟到首个 transcribe（见 py-engine list_engines/find_spec），ping 本身很快，
// 这里给足冗余并配合一次重试，彻底消除"偶发冷启动超时"。
export const START_PING_TIMEOUT_MS = 60_000;
```

并全局把对 `STARTUP_TIMEOUT_MS` 的引用改为 `START_PING_TIMEOUT_MS`（本文件 `start()` 内一处；用编辑器查找确认无其它引用）。

- [ ] **Step 2: 重写 `start()`：防重入覆盖 + 启动 ping 失败 kill 进程 + 重试一次**

把现有 `start()`（`manager.ts:102-144`）整体替换为：

```ts
private async start(): Promise<PingResult> {
  // 防重入：若残留旧进程（如上次 ping 超时未清理），先杀掉，避免孤儿 + 引用覆盖。
  if (this.proc) {
    try {
      this.proc.kill();
    } catch {
      // already exited
    }
    this.proc = null;
  }

  const attempt = async (): Promise<PingResult> => {
    const cmd = this.resolveCommand();
    this.logger(
      `Starting python engine: ${cmd.command} ${cmd.args.join(' ')}`,
      'info',
    );

    const proc = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: { ...buildSanitizedEnv(), ...(cmd.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    proc.on('error', (error) => {
      this.handleExit(`spawn error: ${error.message}`);
    });
    proc.on('exit', (code, signal) => {
      this.handleExit(`exited with code=${code} signal=${signal}`);
    });

    createInterface({ input: proc.stdout }).on('line', (line) => {
      this.handleLine(line);
    });
    createInterface({ input: proc.stderr }).on('line', (line) => {
      this.logger(line, 'info');
    });

    try {
      const info = await this.request<PingResult>('ping', {}, {
        timeoutMs: START_PING_TIMEOUT_MS,
      });
      this.lastPingInfo = info;
      this.logger(
        `Python engine ready: version=${info.version} python=${info.python} engines=${JSON.stringify(info.engines)}`,
        'info',
      );
      return info;
    } catch (error) {
      // 关键：ping 失败（超时/退出）时务必杀掉仍在启动的进程，避免孤儿 + 二次 spawn + Windows 文件锁。
      if (this.proc === proc) {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        this.proc = null;
        this.lastPingInfo = null;
      }
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (firstError) {
    this.logger(
      `Python engine start failed, retrying once: ${firstError}`,
      'warning',
    );
    return attempt();
  }
}
```

> 说明：`request` 超时回调本身已 `pending.delete(id)` 并 reject（`manager.ts:175-185`），无需改；进程清理统一在 `start()` 的 catch 里做。`handleExit` 会把 `pending` 全部 reject 并置 `proc=null`，与上面的显式 kill 协同安全（重复置 null 无害）。

- [ ] **Step 3: 类型检查**

Run（APP 目录）：`npm run build`
Expected：构建通过，无 `STARTUP_TIMEOUT_MS` 未定义等类型错误。

- [ ] **Step 4: 提交（APP 仓库）**

```bash
cd /Users/xiaodong/Documents/code/SmartSub
git add main/helpers/pythonRuntime/manager.ts
git commit -m "fix(py-runtime): kill orphan on ping timeout, raise cold-start timeout to 60s, retry once"
```

---

## Task 0.3: 预热（warmup）—— 批处理开始前 / 切换引擎后

**Files:**

- Modify: `APP/main/helpers/taskProcessor.ts:227-232`（首次进入处理时）
- Modify: `APP/main/helpers/ipcEngineHandlers.ts:37-56`（`set-transcription-engine` 成功后）

- [ ] **Step 1: 批处理开始前非阻塞预热**

在 `taskProcessor.ts` 处理启动处（`if (!isProcessing) { isProcessing = true; ... }`，约 227-232 行）内、`processNextTasks(event)` 之前加入：

```ts
// 预热 sidecar：把冷启动成本移出首个文件关键路径（faster-whisper 等需运行时引擎）。
try {
  const activeAdapter = getActiveEngineAdapter();
  if (activeAdapter.requiresRuntime) {
    void getPythonRuntimeManager()
      .ensureStarted()
      .catch((e) =>
        logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
      );
  }
} catch (e) {
  logMessage(`engine warmup skipped: ${e}`, 'warning');
}
```

确认 `taskProcessor.ts` 顶部已 import：`getActiveEngineAdapter`（来自 `./engines/registry`，文件已用于 cancel）、`getPythonRuntimeManager`（来自 `./pythonRuntime`）、`logMessage`（来自 `./storeManager`）。缺哪个补哪个 import。

- [ ] **Step 2: 切换到 faster-whisper 后预热**

在 `ipcEngineHandlers.ts` 的 `set-transcription-engine` handler 中，`store.set('settings', ...)` 成功、`return { success: true }` 之前加入：

```ts
if (engine === 'fasterWhisper') {
  void getPythonRuntimeManager()
    .ensureStarted()
    .catch((e) =>
      logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
    );
}
```

`getPythonRuntimeManager` 已在该文件 import（`ipcEngineHandlers.ts:8-11`）。

- [ ] **Step 3: 类型检查**

Run：`npm run build`
Expected：通过。

- [ ] **Step 4: 提交**

```bash
git add main/helpers/taskProcessor.ts main/helpers/ipcEngineHandlers.ts
git commit -m "feat(py-runtime): warm up sidecar before batch start and on switch to faster-whisper"
```

- [ ] **Step 5: 手动冒烟（Phase 0 整体，Windows 优先）**

1. 删除 `userData/py-engine/current/` 后重新下载安装；首个 faster-whisper 任务不报 ping 超时。
2. 重启电脑后首次跑 faster-whisper：不超时，或日志见 "retrying once" 后成功。
3. 任务运行中用任务管理器 kill `smartsub-engine.exe`，再起新任务：进程数恢复为 1（无第二常驻进程）。

---

# Phase 1 · 取消语义统一（localCli 可中断）

## Task 1.1: `generateSubtitleWithLocalWhisper` 改 spawn + 可取消

**Files:**

- Modify: `APP/main/helpers/subtitleGenerator.ts:1`（imports）
- Modify: `APP/main/helpers/subtitleGenerator.ts:189-244`（函数体）

- [ ] **Step 1: 引入 spawn 与活动子进程引用**

`subtitleGenerator.ts` 顶部把 `import { exec } from 'child_process';` 改为：

```ts
import { exec, spawn, type ChildProcess } from 'child_process';
```

并在模块级 `activeFasterWhisperTranscribeId` 附近新增：

```ts
let activeLocalCliChild: ChildProcess | null = null;

export function cancelLocalCliTranscription(): void {
  const child = activeLocalCliChild;
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      // 杀整棵进程树（whisper CLI 常 fork 子进程）
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // 进程可能已退出
  }
  activeLocalCliChild = null;
}
```

- [ ] **Step 2: 用 spawn 重写转写主体（接 signal + 记录 child）**

把 `generateSubtitleWithLocalWhisper` 的 `return new Promise(...) { exec(...) }`（189-244 行的 Promise 部分）替换为 spawn 版：

```ts
return new Promise<string>((resolve, reject) => {
  const signal = getTaskContext()?.signal;
  if (signal?.aborted) {
    reject(new TaskCancelledError());
    return;
  }

  const child = spawn(runShell, { shell: true, windowsHide: true });
  activeLocalCliChild = child;
  let stderrBuf = '';
  let cancelled = false;

  const onAbort = () => {
    cancelled = true;
    cancelLocalCliTranscription();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout?.on('data', (d) => logMessage(`localCli stdout: ${d}`, 'info'));
  child.stderr?.on('data', (d) => {
    stderrBuf += String(d);
  });

  child.on('error', (error) => {
    signal?.removeEventListener('abort', onAbort);
    if (activeLocalCliChild === child) activeLocalCliChild = null;
    if (cancelled || signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    logMessage(`generate subtitle error: ${error}`, 'error');
    reject(error);
  });

  child.on('close', (code, sig) => {
    signal?.removeEventListener('abort', onAbort);
    if (activeLocalCliChild === child) activeLocalCliChild = null;

    if (cancelled || signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    if (code !== 0) {
      logMessage(
        `localCli exited code=${code} signal=${sig}: ${stderrBuf}`,
        'error',
      );
      reject(
        new Error(
          `whisper command failed (code=${code}): ${stderrBuf.slice(0, 500)}`,
        ),
      );
      return;
    }
    if (stderrBuf.trim()) {
      logMessage(`generate subtitle stderr: ${stderrBuf}`, 'warning');
    }
    logMessage(`generate subtitle done!`, 'info');

    const md5BaseName = path.basename(tempAudioFile, '.wav');
    const tempSrtFile = path.join(directory, `${md5BaseName}.srt`);
    if (fs.existsSync(tempSrtFile)) {
      fs.renameSync(tempSrtFile, srtFile);
    }
    event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
    resolve(srtFile);
  });
});
```

确认 `TaskCancelledError` 与 `getTaskContext` 已在文件顶部 import（`subtitleGenerator.ts:14-20` 已 import）。保留函数前半段（runShell 拼装、`taskFileChange: 'loading'` 发送）不变。

- [ ] **Step 3: 类型检查**

Run：`npm run build`
Expected：通过。

- [ ] **Step 4: 提交**

```bash
git add main/helpers/subtitleGenerator.ts
git commit -m "feat(localCli): run whisper via spawn with abort support and child tracking"
```

---

## Task 1.2: `cancelActive` 升为接口必选 + localCli 接线

**Files:**

- Modify: `APP/main/helpers/engines/types.ts:18`
- Modify: `APP/main/helpers/engines/localCliEngine.ts`
- Modify: `APP/main/helpers/engines/builtinEngine.ts`
- Modify: `APP/main/helpers/taskProcessor.ts:286`

- [ ] **Step 1: 接口必选化**

`engines/types.ts` 把 `cancelActive?(): void;` 改为：

```ts
  /** 中断进行中的转写。builtin=signal 原生中断(no-op)、faster=sidecar 取消、localCli=kill child。 */
  cancelActive(): void;
```

- [ ] **Step 2: localCli 实现 cancelActive**

`engines/localCliEngine.ts`：import 增加 `cancelLocalCliTranscription`，并加 `cancelActive`：

```ts
import {
  generateSubtitleWithLocalWhisper,
  cancelLocalCliTranscription,
} from '../subtitleGenerator';
// ...
export const localCliEngineAdapter: TranscriptionEngineAdapter = {
  id: 'localCli',
  displayName: 'Local Whisper CLI',
  requiresRuntime: false,
  async isAvailable(): Promise<EngineStatus> {
    /* 不变 */
  },
  async transcribe(ctx: TranscribeContext): Promise<string> {
    return generateSubtitleWithLocalWhisper(ctx.event, ctx.file, ctx.formData);
  },
  cancelActive(): void {
    cancelLocalCliTranscription();
  },
};
```

- [ ] **Step 3: builtin 提供 no-op cancelActive**

`engines/builtinEngine.ts` 在 adapter 内补：

```ts
  cancelActive(): void {
    // builtin 经 whisperParams.signal 原生中断，无需额外动作。
  },
```

- [ ] **Step 4: 去掉调用处可选链**

`taskProcessor.ts:286` 把 `getActiveEngineAdapter().cancelActive?.();` 改为 `getActiveEngineAdapter().cancelActive();`（仍保留外层 try/catch）。

- [ ] **Step 5: 类型检查**

Run：`npm run build`
Expected：通过（所有 adapter 均实现 `cancelActive`，无 TS2741 缺属性错误）。

- [ ] **Step 6: 提交**

```bash
git add main/helpers/engines/types.ts main/helpers/engines/localCliEngine.ts main/helpers/engines/builtinEngine.ts main/helpers/taskProcessor.ts
git commit -m "feat(engines): make cancelActive required; wire localCli child kill"
```

- [ ] **Step 7: 手动冒烟**

配置 localCli 引擎并开始转写，点取消：whisper 子进程立即结束（`ps`/任务管理器验证），任务标记 cancelled，无残留半截 srt。

---

# Phase 2 · 安全升级 + 更新检测 + 协议协商（§4.3 一步到位）

## Task 2.1: py-engine 版本单一源 + ping 返回 protocol/engine 版本

**Files:**

- Create: `PYENG/_version.py`
- Modify: `PYENG/main.py:26-35`（imports/常量）、`PYENG/main.py:64-74`（`handle_ping`）

- [ ] **Step 1: 新建 `_version.py`**

```python
# 引擎版本与协议版本的单一来源（main.py 与 CI 都从这里读）。
ENGINE_VERSION = "0.1.0"
PROTOCOL_VERSION = 1
```

- [ ] **Step 2: main.py 引用 \_version 并扩展 ping**

`main.py` 顶部把 `ENGINE_VERSION = "0.1.0"`（第 28 行）删除，改为从模块导入（放在 `from engines import ...` 附近）：

```python
from _version import ENGINE_VERSION, PROTOCOL_VERSION
```

`handle_ping`（第 64-73 行）的 result 增加两个字段：

```python
def handle_ping(req_id, params):
    emit_result(
        req_id,
        {
            "version": ENGINE_VERSION,
            "engineVersion": ENGINE_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "frozen": bool(getattr(sys, "frozen", False)),
            "engines": list_engines(),
        },
    )
```

- [ ] **Step 3: 确保 PyInstaller 打包包含 `_version`**

`smartsub-engine.spec`：`_version.py` 是被 `main.py` 直接 `import` 的顶层模块，PyInstaller 默认能分析到，无需额外配置。若冻结后报 `ModuleNotFoundError: _version`，在 spec 的 `hiddenimports` 列表加 `"_version"`。

- [ ] **Step 4: dev 冒烟**

Run：`python smoke_test.py`
Expected：`smoke ok: {... 'engineVersion': '0.1.0', 'protocolVersion': 1, ...}`。

- [ ] **Step 5: 提交（PYENG）**

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
git add _version.py main.py smartsub-engine.spec
git commit -m "feat(protocol): single version source; ping returns engineVersion + protocolVersion"
```

---

## Task 2.2: py-engine CI 生成 `manifest.json` 发布资产

**Files:**

- Modify: `PYENG/.github/workflows/release.yml`（`publish_latest` job，76-95 行附近）

- [ ] **Step 1: 在生成 checksums 后生成 manifest.json**

把 `publish_latest` 的 "Generate checksums" 步骤替换/扩展为下面两步（manifest 需读取 `_version.py`，故先 checkout 源码）：

在 `download-artifact` 步骤后、`Generate checksums` 前插入 checkout：

```yaml
- uses: actions/checkout@v4
  with:
    path: src
```

把 checksums 步骤改为同时产出 manifest.json：

```yaml
- name: Generate checksums and manifest
  shell: bash
  run: |
    cd artifacts
    sha256sum smartsub-engine-*.tar.gz > checksums.sha256
    cat checksums.sha256
    ENGINE_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.ENGINE_VERSION)")
    PROTOCOL_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.PROTOCOL_VERSION)")
    BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    GIT_SHA=$(echo "${GITHUB_SHA}" | cut -c1-7)
    python3 - "$ENGINE_VERSION" "$PROTOCOL_VERSION" "$BUILT_AT" "$GIT_SHA" <<'PY'
    import json, os, sys, hashlib
    engine_version, protocol_version, built_at, git_sha = sys.argv[1:5]
    plat = {
      "smartsub-engine-windows-x64.tar.gz": "windows-x64",
      "smartsub-engine-macos-arm64.tar.gz": "macos-arm64",
      "smartsub-engine-macos-x64.tar.gz": "macos-x64",
      "smartsub-engine-linux-x64.tar.gz": "linux-x64",
    }
    artifacts = {}
    for fname, key in plat.items():
        if not os.path.exists(fname):
            continue
        data = open(fname, "rb").read()
        artifacts[key] = {
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    manifest = {
        "engineVersion": engine_version,
        "protocolVersion": int(protocol_version),
        "builtAt": built_at,
        "gitSha": git_sha,
        "engines": ["faster_whisper"],
        "artifacts": artifacts,
    }
    json.dump(manifest, open("manifest.json", "w"), indent=2)
    print(json.dumps(manifest, indent=2))
    PY
```

`Publish latest release` 的 `files: artifacts/*` 已含 `manifest.json`，无需改。

- [ ] **Step 2: 提交（PYENG）**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish manifest.json (engineVersion/protocolVersion/builtAt/artifacts)"
```

> 注：CI 实际产物只能在 push/dispatch 后于 GitHub Actions 验证。本 Task 仅保证语法/逻辑正确；真正发布在合并后触发。

---

## Task 2.3: app 类型扩展 + 协议支持区间

**Files:**

- Modify: `APP/main/helpers/pythonRuntime/protocol.ts:25-30`（`PingResult`）
- Modify: `APP/types/engine.ts`（`PyEngineManifest` + 新增类型）
- Create: `APP/main/helpers/pythonRuntime/protocolSupport.ts`

- [ ] **Step 1: PingResult 增字段**

`protocol.ts` 的 `PingResult` 改为：

```ts
export interface PingResult {
  version: string;
  engineVersion?: string;
  protocolVersion?: number;
  python: string;
  frozen: boolean;
  engines: Record<string, boolean>;
}
```

- [ ] **Step 2: 扩展 manifest 与新增更新信息类型**

`types/engine.ts` 把 `PyEngineManifest` 扩展，并新增 `RemoteEngineManifest` / `PyEngineUpdateInfo`：

```ts
export interface PyEngineManifest {
  version: string; // 兼容历史（可能为 'latest'）
  platform: string;
  sha256: string;
  installedAt: string;
  engineVersion?: string;
  protocolVersion?: number;
  builtAt?: string;
  gitSha?: string;
}

export interface RemoteEngineManifest {
  engineVersion: string;
  protocolVersion: number;
  builtAt: string;
  gitSha?: string;
  engines: string[];
  artifacts: Record<string, { sizeBytes: number; sha256: string }>;
}

export interface PyEngineUpdateInfo {
  installed: boolean;
  hasUpdate: boolean;
  localManifest: PyEngineManifest | null;
  remoteManifest: RemoteEngineManifest | null;
  remoteHash: string | null;
  protocolSupported: boolean;
}
```

- [ ] **Step 3: 新建 protocolSupport.ts**

```ts
import type { RemoteEngineManifest } from '../../../types/engine';

export const SUPPORTED_PROTOCOL_MIN = 1;
export const SUPPORTED_PROTOCOL_MAX = 1;

export function isProtocolSupported(
  version: number | undefined | null,
): boolean {
  return (
    typeof version === 'number' &&
    version >= SUPPORTED_PROTOCOL_MIN &&
    version <= SUPPORTED_PROTOCOL_MAX
  );
}

/** 远端无 manifest（老 release）时放行（向后兼容）；有则按区间判定。 */
export function isRemoteProtocolInstallable(
  remote: RemoteEngineManifest | null,
): boolean {
  if (!remote || typeof remote.protocolVersion !== 'number') return true;
  return isProtocolSupported(remote.protocolVersion);
}
```

- [ ] **Step 4: 类型检查**

Run：`npm run build`
Expected：通过。

- [ ] **Step 5: 提交**

```bash
git add main/helpers/pythonRuntime/protocol.ts types/engine.ts main/helpers/pythonRuntime/protocolSupport.ts
git commit -m "feat(protocol): extend PingResult/manifest types and protocol support range"
```

---

## Task 2.4: app paths —— manifest.json URL

**Files:**

- Modify: `APP/main/helpers/pythonRuntime/paths.ts:186-195`

- [ ] **Step 1: 新增 getPyEngineManifestUrl**

在 `getPyEngineChecksumsUrl` 之后新增（与之同构）：

```ts
export function getPyEngineManifestUrl(
  source: 'github' | 'ghproxy',
  tag: string = PY_ENGINE_TAG,
): string {
  const base = `${getPyEngineReleaseBaseUrl(tag)}/manifest.json`;
  if (source === 'ghproxy') {
    return `https://ghfast.top/${base}`;
  }
  return base;
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/pythonRuntime/paths.ts
git commit -m "feat(py-engine): add manifest.json release URL helper"
```

---

## Task 2.5: app manager —— 启动期协议区间校验

**Files:**

- Modify: `APP/main/helpers/pythonRuntime/manager.ts`（`start()` 内 ping 成功之后）

- [ ] **Step 1: ping 成功后校验协议**

在 Task 0.2 重写的 `attempt()` 内，`this.lastPingInfo = info;` 之后、`return info;` 之前插入：

```ts
if (
  typeof info.protocolVersion === 'number' &&
  !isProtocolSupported(info.protocolVersion)
) {
  // 协议超出 app 支持区间：停机并报错，提示用户升级 SmartSub（而非崩溃）。
  try {
    proc.kill();
  } catch {
    // already exited
  }
  this.proc = null;
  this.lastPingInfo = null;
  throw new PythonEngineError(
    'protocol_unsupported',
    `engine protocolVersion=${info.protocolVersion} not supported by this SmartSub`,
  );
}
```

文件顶部 import：`import { isProtocolSupported } from './protocolSupport';`。

> 注意：`protocol_unsupported` 抛出后会被上面 catch 的"重试一次"再跑一遍——这没意义但无害（第二次仍判定 unsupported）。为避免无谓重试，可在外层 retry 处对 `error.code === 'protocol_unsupported'` 直接 rethrow 不重试：把 `start()` 末尾 `catch (firstError)` 改为：

```ts
} catch (firstError) {
  if (firstError instanceof PythonEngineError && firstError.code === 'protocol_unsupported') {
    throw firstError;
  }
  this.logger(`Python engine start failed, retrying once: ${firstError}`, 'warning');
  return attempt();
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/pythonRuntime/manager.ts
git commit -m "feat(protocol): reject engine startup when protocolVersion is unsupported"
```

---

## Task 2.6: downloader —— checkUpdate + 安全升级（停机/备份/swap/自检/回滚）

**Files:**

- Modify: `APP/main/helpers/pythonRuntime/downloader.ts`（imports、`download()` 前置协议校验、`verifyExtractAndInstall` 重写、新增 `checkUpdate`、新增 `getPreviousDir`）

- [ ] **Step 1: 增加 imports 与目录助手**

`downloader.ts` 顶部 import 增补：

```ts
import {
  getPythonRuntimeManager,
  shutdownPythonRuntime,
} from '../pythonRuntime';
import { isRemoteProtocolInstallable } from './protocolSupport';
import { getPyEngineManifestUrl, readPyEngineManifest } from './paths';
import type {
  RemoteEngineManifest,
  PyEngineUpdateInfo,
} from '../../../types/engine';
```

并在 `getPyEngineStagingDir` 旁新增：

```ts
function getPyEnginePreviousDir(): string {
  return path.join(getPyEngineRoot(), 'previous');
}

async function fetchRemoteManifest(
  source: PyEngineDownloadSource,
): Promise<RemoteEngineManifest | null> {
  try {
    const text = await fetchHttpText(getPyEngineManifestUrl(source));
    return JSON.parse(text) as RemoteEngineManifest;
  } catch (error) {
    logMessage(
      `No remote py-engine manifest.json (ok for old releases): ${error}`,
      'info',
    );
    return null;
  }
}
```

`getPyEngineRoot` 已在文件顶部 import（`downloader.ts:14-23`），确认 `PyEngineDownloadSource` 已 import（已在 `types/engine` import 中）。

- [ ] **Step 2: download() 下载前做协议预检**

在 `download()` 方法体最前面（`const resolvedTag = PY_ENGINE_TAG;` 之后）加入：

```ts
const remoteManifest = await fetchRemoteManifest(source);
if (!isRemoteProtocolInstallable(remoteManifest)) {
  const msg = 'engine_protocol_unsupported';
  this.updateProgress({ status: 'error', error: msg });
  throw new Error(msg);
}
```

- [ ] **Step 3: 重写 verifyExtractAndInstall 为安全升级流程**

把 `verifyExtractAndInstall`（`downloader.ts:321-380`）整体替换为：

```ts
private async verifyExtractAndInstall(
  tarPath: string,
  source: PyEngineDownloadSource,
  tag: string,
): Promise<void> {
  const artifactName = getArtifactFileName();
  const checksumsUrl = getPyEngineChecksumsUrl(source, tag);
  const checksumsContent = await fetchHttpText(checksumsUrl);
  const expectedChecksum = parseExpectedChecksum(checksumsContent, artifactName);
  if (!expectedChecksum) {
    throw new Error(`Checksum for ${artifactName} not found in release checksums`);
  }

  const actualChecksum = await calculateFileChecksum(tarPath);
  if (actualChecksum.toLowerCase() !== expectedChecksum) {
    throw new Error(`Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  // 关键：先停机，解 Windows 文件锁（依赖 Phase 0：无孤儿进程）。
  await shutdownPythonRuntime();

  // 解压到 staging 并校验二进制存在。
  const stagingDir = getPyEngineStagingDir();
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  await tar.extract({ file: tarPath, cwd: stagingDir });
  normalizePyEngineLayout(stagingDir);
  const stagingBinary = path.join(stagingDir, getPyEngineBinaryName());
  if (!fs.existsSync(stagingBinary) || !fs.statSync(stagingBinary).isFile()) {
    throw new Error(`Engine binary ${getPyEngineBinaryName()} not found after extraction`);
  }

  const currentDir = getPyEngineCurrentDir();
  const previousDir = getPyEnginePreviousDir();

  // 备份旧版本到 previous/（不直接删，便于回滚）。
  const hadCurrent = fs.existsSync(currentDir);
  if (hadCurrent) {
    if (fs.existsSync(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
    fs.renameSync(currentDir, previousDir);
  }

  try {
    fs.renameSync(stagingDir, currentDir);
    normalizePyEngineLayout(currentDir);

    const remoteManifest = await fetchRemoteManifest(source);
    writePyEngineManifest({
      version: tag,
      platform: getPyEngineArtifactSuffix(),
      sha256: expectedChecksum,
      installedAt: new Date().toISOString(),
      engineVersion: remoteManifest?.engineVersion,
      protocolVersion: remoteManifest?.protocolVersion,
      builtAt: remoteManifest?.builtAt,
      gitSha: remoteManifest?.gitSha,
    });

    // 自检：起新版本 + ping（含协议校验，见 manager）。
    await getPythonRuntimeManager().ensureStarted();
    await shutdownPythonRuntime(); // 自检通过后释放，等真正转写时再起

    // 成功：清掉备份。
    if (fs.existsSync(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
  } catch (selfCheckError) {
    logMessage(`Py-engine self-check failed, rolling back: ${selfCheckError}`, 'error');
    // 回滚：删坏的 current，previous 改回 current。
    try {
      await shutdownPythonRuntime();
    } catch {
      // ignore
    }
    if (fs.existsSync(currentDir)) {
      fs.rmSync(currentDir, { recursive: true, force: true });
    }
    if (hadCurrent && fs.existsSync(previousDir)) {
      fs.renameSync(previousDir, currentDir);
      normalizePyEngineLayout(currentDir);
    }
    throw new Error(`Engine install failed and was rolled back: ${selfCheckError}`);
  }
}
```

> 说明：原 `verifyExtractAndInstall` 里的 `tag` 参数仍用于 manifest.version；`writePyEngineManifest` 的扩展字段在 Task 2.3 已加。`fetchRemoteManifest` 在 download() 前置已拉过一次，这里为简单再拉一次（小文件，可接受；如需优化可把 download() 拉到的 manifest 传进来）。

- [ ] **Step 4: 新增 checkUpdate**

在 `PyEngineDownloader` 类内新增方法：

```ts
async checkUpdate(source: PyEngineDownloadSource): Promise<PyEngineUpdateInfo> {
  const localManifest = readPyEngineManifest();
  let remoteHash: string | null = null;
  try {
    const checksums = await fetchHttpText(getPyEngineChecksumsUrl(source, PY_ENGINE_TAG));
    remoteHash = parseExpectedChecksum(checksums, getArtifactFileName());
  } catch (error) {
    logMessage(`checkUpdate: failed to fetch checksums: ${error}`, 'warning');
  }
  const remoteManifest = await fetchRemoteManifest(source);
  const hasUpdate = !!(remoteHash && localManifest?.sha256 && remoteHash !== localManifest.sha256);
  return {
    installed: !!localManifest,
    hasUpdate,
    localManifest,
    remoteManifest,
    remoteHash,
    protocolSupported: isRemoteProtocolInstallable(remoteManifest),
  };
}
```

- [ ] **Step 5: 类型检查**

Run：`npm run build`
Expected：通过。注意潜在循环依赖（`downloader` ← `pythonRuntime/index` ← ...）；若出现运行期循环，改为在方法内 `await import('../pythonRuntime')` 动态导入 `shutdownPythonRuntime`/`getPythonRuntimeManager`。

- [ ] **Step 6: 提交**

```bash
git add main/helpers/pythonRuntime/downloader.ts
git commit -m "feat(upgrade): safe install/upgrade with shutdown, previous backup, ping self-check, rollback; add checkUpdate"
```

---

## Task 2.7: taskProcessor 导出忙碌状态

**Files:**

- Modify: `APP/main/helpers/taskProcessor.ts`（模块级，靠近 `activeTasksCount`/`processingQueue` 定义处导出函数）

- [ ] **Step 1: 导出 isTranscriptionBusy**

新增导出函数（放在模块顶层变量定义之后）：

```ts
export function isTranscriptionBusy(): boolean {
  return activeTasksCount > 0 || processingQueue.length > 0;
}
```

确认 `activeTasksCount`、`processingQueue` 为模块级变量（`getTaskStatus` 已用它们，见 `taskProcessor.ts:303-316`）。

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/taskProcessor.ts
git commit -m "feat(tasks): export isTranscriptionBusy for upgrade guard"
```

---

## Task 2.8: IPC —— 检查更新 + 升级忙碌守卫 + 版本状态

**Files:**

- Modify: `APP/main/helpers/ipcEngineHandlers.ts`

- [ ] **Step 1: imports**

`ipcEngineHandlers.ts` 顶部 import 增补：

```ts
import { isTranscriptionBusy } from './taskProcessor';
import type { PyEngineDownloadSource } from '../../types/engine';
```

（`PyEngineDownloadSource` 已 import 则跳过。）

- [ ] **Step 2: 下载/升级前忙碌守卫**

在 `start-py-engine-download` handler 内、`getPyEngineDownloader(...)` 之前加入：

```ts
if (isTranscriptionBusy()) {
  return { success: false, error: 'engine_busy' };
}
```

- [ ] **Step 3: 新增 check-py-engine-update handler**

在 `registerEngineIpcHandlers` 内新增：

```ts
ipcMain.handle(
  'check-py-engine-update',
  async (_event, { source }: { source: PyEngineDownloadSource }) => {
    try {
      const info = await getPyEngineDownloader(
        mainWindow || undefined,
      ).checkUpdate(source);
      return { success: true, info };
    } catch (error) {
      logMessage(`check py-engine update failed: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  },
);
```

- [ ] **Step 4: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/ipcEngineHandlers.ts
git commit -m "feat(ipc): check-py-engine-update handler + block download/upgrade while busy"
```

---

## Task 2.9: preload 暴露新 IPC 通道

**Files:**

- Modify: APP preload/桥接文件（定位：搜索 `start-py-engine-download` 在 `APP/main/**` 的 preload/bridge 注册处）

- [ ] **Step 1: 定位 preload 白名单**

Run（在 APP 搜索）：确认 `window.ipc.invoke` 是否对 channel 有白名单。若 `start-py-engine-download` 等已通过通用 `invoke` 透传（无白名单），则本 Task 跳过（无需改）。若存在 channel 白名单数组，把 `'check-py-engine-update'` 加入。

> 现有渲染层 `window?.ipc?.invoke('start-py-engine-download', ...)` 已工作（`EnginesTab.tsx:208`），通常说明 invoke 为通用透传。多数情况下本 Task 为"确认无需改动"。

- [ ] **Step 2: 若改动则提交**

```bash
git add -A
git commit -m "chore(ipc): allow check-py-engine-update channel in preload (if whitelisted)"
```

---

## Task 2.10: EnginesTab UI —— 版本展示 + 检查更新/升级 + i18n

**Files:**

- Modify: `APP/renderer/components/resources/EnginesTab.tsx`
- Modify: `APP/renderer/public/locales/zh/resources.json`
- Modify: `APP/renderer/public/locales/en/resources.json`

- [ ] **Step 1: i18n 新键**

在 `zh/resources.json` 的 `engines.fasterWhisper` 节点增（en 同结构译文）：

```json
"installedVersion": "已安装 {{version}}",
"builtAt": "构建于 {{date}}",
"checkUpdate": "检查更新",
"checking": "检查中…",
"updateAvailable": "有新版本可用",
"upToDate": "已是最新",
"upgrade": "升级",
"serialNote": "为避免显存争用，faster-whisper 转写将串行执行（并发=1）。",
"protocolUnsupported": "该引擎版本需要更新的 SmartSub，请先升级 SmartSub。",
"engineBusy": "有转写任务进行中，无法下载/升级，请先停止任务。"
```

en：

```json
"installedVersion": "Installed {{version}}",
"builtAt": "Built {{date}}",
"checkUpdate": "Check for updates",
"checking": "Checking…",
"updateAvailable": "Update available",
"upToDate": "Up to date",
"upgrade": "Upgrade",
"serialNote": "To avoid VRAM contention, faster-whisper runs transcription serially (concurrency = 1).",
"protocolUnsupported": "This engine build requires a newer SmartSub. Please upgrade SmartSub first.",
"engineBusy": "A transcription task is running; cannot download/upgrade. Stop tasks first."
```

Run：`npm run check:i18n`
Expected：通过（zh/en 键齐全）。

- [ ] **Step 2: 状态与处理函数**

在 `EnginesTab` 组件内新增 state 与 handler：

```ts
const [updateInfo, setUpdateInfo] = useState<{
  hasUpdate: boolean;
  protocolSupported: boolean;
} | null>(null);
const [checkingUpdate, setCheckingUpdate] = useState(false);

const handleCheckUpdate = async () => {
  setCheckingUpdate(true);
  try {
    const source = resolvePyEngineDownloadSource(downSource);
    const res = await window?.ipc?.invoke('check-py-engine-update', { source });
    if (res?.success && res.info) {
      setUpdateInfo({
        hasUpdate: res.info.hasUpdate,
        protocolSupported: res.info.protocolSupported,
      });
      if (!res.info.protocolSupported)
        toast.error(t('engines.fasterWhisper.protocolUnsupported'));
      else if (res.info.hasUpdate)
        toast.info(t('engines.fasterWhisper.updateAvailable'));
      else toast.success(t('engines.fasterWhisper.upToDate'));
    } else {
      toast.error(res?.error || 'check failed');
    }
  } finally {
    setCheckingUpdate(false);
  }
};

const handleUpgrade = async () => {
  // 升级复用下载流程（downloader 内部含停机/备份/swap/自检/回滚）。
  await handleStartDownload();
};
```

`handleStartDownload`（已存在，`EnginesTab.tsx:205-214`）若返回 `engine_busy` 错误，提示 `t('engines.fasterWhisper.engineBusy')`：在其 `if (!result?.success)` 分支把通用 toast 改为：

```ts
if (!result?.success) {
  toast.error(
    result?.error === 'engine_busy'
      ? t('engines.fasterWhisper.engineBusy')
      : result?.error || 'Failed to start download',
  );
}
```

- [ ] **Step 3: 版本展示替换 vlatest**

在 faster-whisper 卡片 `body` 内（`fasterInstalled` 为真时），版本来源为 `fasterStatus?.version`（来自 manifest，Task 2.11 会让其返回 `engineVersion`）。展示：

```tsx
{
  fasterInstalled && (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        {t('engines.fasterWhisper.installedVersion', {
          version:
            fasterStatus?.version && fasterStatus.version !== 'latest'
              ? `v${fasterStatus.version}`
              : '—',
        })}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5"
        disabled={checkingUpdate || taskBusy}
        onClick={handleCheckUpdate}
      >
        <RefreshCw
          className={cn('h-3.5 w-3.5', checkingUpdate && 'animate-spin')}
        />
        {checkingUpdate
          ? t('engines.fasterWhisper.checking')
          : t('engines.fasterWhisper.checkUpdate')}
      </Button>
      {updateInfo?.hasUpdate && updateInfo.protocolSupported && (
        <Button
          size="sm"
          className="h-7 gap-1.5"
          disabled={taskBusy || isDownloading}
          onClick={handleUpgrade}
        >
          <Download className="h-3.5 w-3.5" />
          {t('engines.fasterWhisper.upgrade')}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 串行提示（与 Phase 3 联动，先放这里）**

在 faster-whisper 卡片 `body` 末尾加：

```tsx
{
  currentEngine === 'fasterWhisper' && (
    <p className="text-xs text-muted-foreground">
      {t('engines.fasterWhisper.serialNote')}
    </p>
  );
}
```

- [ ] **Step 5: 类型检查 + i18n + 提交**

Run：`npm run build` → 通过；`npm run check:i18n` → 通过。

```bash
git add renderer/components/resources/EnginesTab.tsx renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "feat(ui): engine version display, check-update/upgrade actions, serial note, i18n"
```

---

## Task 2.11: engine-status 返回真实版本

**Files:**

- Modify: `APP/main/helpers/engines/fasterWhisperEngine.ts:17-29`

- [ ] **Step 1: isAvailable 优先返回 engineVersion**

把 `return { state: 'ready', version: manifest?.version };` 改为：

```ts
return {
  state: 'ready',
  version:
    manifest?.engineVersion ||
    (manifest?.version !== 'latest' ? manifest?.version : undefined),
};
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/fasterWhisperEngine.ts
git commit -m "feat(engines): report real engineVersion in faster-whisper status"
```

---

## Task 2.12: 启动后每日节流自动检查

**Files:**

- Modify: `APP/main/helpers/ipcEngineHandlers.ts`（`setMainWindowForEngine` 或注册处触发）
- Modify: `APP/main/helpers/store/types.ts`（如需为 `lastPyEngineUpdateCheckAt` 增类型）

- [ ] **Step 1: 节流自动检查函数**

在 `ipcEngineHandlers.ts` 新增（模块级），并在 `setMainWindowForEngine` 末尾调用 `void maybeAutoCheckUpdate();`：

```ts
async function maybeAutoCheckUpdate(): Promise<void> {
  try {
    if (!isPyEngineInstalled()) return;
    const settings = store.get('settings') || {};
    const last = Number(settings.lastPyEngineUpdateCheckAt || 0);
    const now = Date.now();
    if (now - last < 24 * 60 * 60 * 1000) return; // 每日一次
    store.set('settings', { ...settings, lastPyEngineUpdateCheckAt: now });

    const downSource =
      (store.get('downSource') as 'github' | 'ghproxy') || 'github';
    const info = await getPyEngineDownloader(
      mainWindow || undefined,
    ).checkUpdate(downSource);
    if (info.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-engine-update-available', info);
    }
  } catch (error) {
    logMessage(`auto update check failed (silent): ${error}`, 'info');
  }
}
```

> 注：`downSource` 实际持久化在渲染层 localStorage（`EnginesTab` 用 `useLocalStorageState('downSource')`），主进程不一定可读。简化：主进程自动检查固定用 `'github'`（弱网失败静默）；UI 手动检查仍按用户 `downSource`。若要尊重用户镜像，后续可把 downSource 同步进 electron-store（YAGNI，本期固定 github）。据此把上面 `downSource` 行改为 `const downSource = 'github' as const;`。

- [ ] **Step 2: store 类型（如有强类型）**

若 `store/types.ts` 的 settings 是强类型接口，给它加可选字段 `lastPyEngineUpdateCheckAt?: number;`。若为宽松类型则跳过。

- [ ] **Step 3: 渲染层监听 update-available（可选轻量）**

`EnginesTab` 的 `useEffect` 内补一个监听，把 `updateInfo` 置为有更新：

```ts
const unsubUpd = window?.ipc?.on('py-engine-update-available', (info: any) => {
  setUpdateInfo({
    hasUpdate: !!info?.hasUpdate,
    protocolSupported: info?.protocolSupported !== false,
  });
});
// cleanup 里 unsubUpd?.();
```

- [ ] **Step 4: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/ipcEngineHandlers.ts main/helpers/store/types.ts renderer/components/resources/EnginesTab.tsx
git commit -m "feat(upgrade): daily throttled auto update check with UI signal"
```

- [ ] **Step 5: 手动冒烟（Phase 2 整体）**

1. 旧安装（manifest.version='latest'）：卡片不再显示 vlatest；点检查更新可判定。
2. 临时把本地 `manifest.json` 的 `sha256` 改成任意值 → 点检查更新 → 显示"有新版本"。
3. 模拟升级：点升级走下载→安装；Windows 上 sidecar 曾运行过也不报文件锁。
4. 运行中转写时点下载/升级 → 提示 engineBusy 被拒。
5. 人为损坏 staging（或断网中断自检）→ 验证回滚后旧版仍可用。

---

# Phase 3 · faster-whisper 并发钳制（§2.5）

## Task 3.1: processNextTasks 按引擎钳制有效并发

**Files:**

- Modify: `APP/main/helpers/taskProcessor.ts:382` 附近（`availableSlots` 计算处）

- [ ] **Step 1: 计算 effectiveMax**

把 `const availableSlots = maxConcurrentTasks - activeTasksCount;`（约 382 行）替换为：

```ts
// faster-whisper 共享单 sidecar + 单模型，并发推理易争用显存/OOM → 钳制为 1。
const activeEngineId = getActiveEngineAdapter().id;
const effectiveMax =
  activeEngineId === 'fasterWhisper' ? 1 : maxConcurrentTasks;
const availableSlots = effectiveMax - activeTasksCount;
```

`getActiveEngineAdapter` 已 import（`taskProcessor.ts` cancel 处已用）。

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/taskProcessor.ts
git commit -m "feat(tasks): clamp effective concurrency to 1 for faster-whisper"
```

- [ ] **Step 3: 手动冒烟**

并发设为 3 + 选 faster-whisper + 投 3 个文件：同一时刻仅 1 个文件在转写（进度/日志验证）；切到 builtin 仍可 3 并发。

> 串行 UI 提示已在 Task 2.10 Step 4 落地（serialNote）。

---

# Phase 4 · 引擎自包含重构 + 收口（§2.4 / §2.6 / §2.7）

> 原则：**行为保持式重构**。每个 Task 后 `npm run build` 通过 + 对应引擎手动冒烟（转写 + 取消）一致。

## Task 4.1: 模型名显式映射表（§2.6）

**Files:**

- Create: `APP/main/helpers/engines/modelMap.ts`
- Modify: `APP/main/helpers/subtitleGenerator.ts:61-63`（`toFasterWhisperModel`）

- [ ] **Step 1: 新建 modelMap.ts**

```ts
import { logMessage } from '../storeManager';

/** ggml 模型名（去量化后缀后） → faster-whisper(CT2) 模型名 */
export const GGML_TO_CT2: Record<string, string> = {
  tiny: 'tiny',
  'tiny.en': 'tiny.en',
  base: 'base',
  'base.en': 'base.en',
  small: 'small',
  'small.en': 'small.en',
  medium: 'medium',
  'medium.en': 'medium.en',
  'large-v1': 'large-v1',
  'large-v2': 'large-v2',
  'large-v3': 'large-v3',
  'large-v3-turbo': 'large-v3-turbo',
};

export function toFasterWhisperModel(model?: string): string {
  const base = (model || 'base').toLowerCase().replace(/-q\d+_\d+$/, '');
  const mapped = GGML_TO_CT2[base];
  if (!mapped) {
    logMessage(
      `toFasterWhisperModel: no explicit mapping for "${base}", using as-is`,
      'warning',
    );
  }
  return mapped ?? base;
}
```

- [ ] **Step 2: subtitleGenerator 改为复用映射表**

删除 `subtitleGenerator.ts:61-63` 的本地 `toFasterWhisperModel`，改从 modelMap 引入：

```ts
import { toFasterWhisperModel } from './engines/modelMap';
```

（`generateSubtitleWithFasterWhisper` 内调用处不变。）

- [ ] **Step 3: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/modelMap.ts main/helpers/subtitleGenerator.ts
git commit -m "refactor(engines): explicit ggml->CT2 model name map"
```

---

## Task 4.2: signal 显式入 TranscribeContext（§2.7）

**Files:**

- Modify: `APP/main/helpers/engines/types.ts`（`TranscribeContext`）
- Modify: `APP/main/helpers/transcriptionRouter.ts`

- [ ] **Step 1: ctx 增 signal**

`types.ts` 的 `TranscribeContext` 增字段：

```ts
export interface TranscribeContext {
  event: IpcMainInvokeEvent;
  file: IFiles;
  formData: Record<string, unknown>;
  hasOpenAiWhisper: boolean;
  signal?: AbortSignal;
}
```

- [ ] **Step 2: router 注入 signal**

`transcriptionRouter.ts` 在调用 `adapter.transcribe(ctx)` 前注入（从 taskContext 取）：

```ts
import { getActiveEngineAdapter } from './engines/registry';
import { getTaskContext } from './taskContext';
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
  return adapter.transcribe({
    ...ctx,
    signal: ctx.signal ?? getTaskContext()?.signal,
  });
}
```

> 本 Task 只注入；各引擎消费 `ctx.signal` 在 4.3/4.4/4.5 搬家时一并改（届时把内部 `getTaskContext()?.signal` 换成入参 signal，保留 `getTaskContext()` 兜底）。

- [ ] **Step 3: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/types.ts main/helpers/transcriptionRouter.ts
git commit -m "refactor(engines): inject AbortSignal into TranscribeContext via router"
```

---

## Task 4.3: builtin transcribe 搬进 builtinEngine.ts

**Files:**

- Modify: `APP/main/helpers/engines/builtinEngine.ts`
- Modify: `APP/main/helpers/subtitleGenerator.ts`（移除 builtin 函数）

- [ ] **Step 1: 移动函数**

把 `generateSubtitleWithBuiltinWhisper`（`subtitleGenerator.ts:249-393`）整体移动到 `builtinEngine.ts`，作为模块内函数（非 export 或 export 皆可，adapter 直接调用）。移动时仅做以下最小修改：

- 该函数内所有 `getTaskContext()?.signal` 改为优先用入参 `signal`（把签名改为 `generateSubtitleWithBuiltinWhisper(event, file, formData, signal?)`，由 adapter 传 `ctx.signal`）。其它逻辑（VAD 装配、`whisperAsync`、取消判定、srt 写出）保持不变。
- 依赖的 import（`loadWhisperAddon`/`getPath`、`logMessage`/`store`、`getExtraResourcesPath`、`formatSrtContent`、VAD helper、`getNumericSetting`、`getWhisperLanguage`、`isWhisper*`/`TaskCancelledError`/`throwIfTaskCancelled`）从其原模块/共享工具 import。`getNumericSetting`/`getWhisperLanguage` 暂仍可从 `subtitleGenerator`（共享工具）import（Task 4.6 统一）。

adapter 调用改为：

```ts
async transcribe(ctx: TranscribeContext): Promise<string> {
  return generateSubtitleWithBuiltinWhisper(ctx.event, ctx.file, ctx.formData, ctx.signal);
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/builtinEngine.ts main/helpers/subtitleGenerator.ts
git commit -m "refactor(engines): move builtin whisper transcribe into builtinEngine.ts"
```

- [ ] **Step 3: 冒烟**：builtin 引擎转写 + 取消行为与重构前一致。

---

## Task 4.4: faster-whisper transcribe 搬进 fasterWhisperEngine.ts

**Files:**

- Modify: `APP/main/helpers/engines/fasterWhisperEngine.ts`
- Modify: `APP/main/helpers/subtitleGenerator.ts`（移除 faster 函数 + cancel）

- [ ] **Step 1: 移动函数**

把 `generateSubtitleWithFasterWhisper`（`subtitleGenerator.ts:68-184`）与 `activeFasterWhisperTranscribeId`/`cancelFasterWhisperTranscription`（22-29）移动到 `fasterWhisperEngine.ts`。最小修改：

- 函数签名加 `signal?: AbortSignal`，内部 `getTaskContext()?.signal` 改为优先用入参（保留兜底）。
- import：`getPythonRuntimeManager`、`getFasterWhisperModelsPath`/`resolveCt2ModelSnapshotDir`（`../modelCatalog`）、`toFasterWhisperModel`（`./modelMap`）、`secondsToSrtTime`/`getNumericSetting`/`getWhisperLanguage`（共享工具）、`formatSrtContent`（`../fileUtils`）、`logMessage`/`store`、`TaskCancelledError`。

adapter：

```ts
async transcribe(ctx: TranscribeContext): Promise<string> {
  return generateSubtitleWithFasterWhisper(ctx.event, ctx.file, ctx.formData, ctx.signal);
}
cancelActive(): void {
  cancelFasterWhisperTranscription();
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/fasterWhisperEngine.ts main/helpers/subtitleGenerator.ts
git commit -m "refactor(engines): move faster-whisper transcribe into fasterWhisperEngine.ts"
```

- [ ] **Step 3: 冒烟**：faster-whisper 转写 + 逐段取消一致。

---

## Task 4.5: localCli transcribe 搬进 localCliEngine.ts（re-home）

**Files:**

- Modify: `APP/main/helpers/engines/localCliEngine.ts`
- Modify: `APP/main/helpers/subtitleGenerator.ts`（移除 localCli 函数 + cancel）

- [ ] **Step 1: 移动函数**

把 Phase 1 改造后的 `generateSubtitleWithLocalWhisper` 与 `activeLocalCliChild`/`cancelLocalCliTranscription` 移动到 `localCliEngine.ts`。最小修改：

- 函数签名加 `signal?: AbortSignal`，内部 `getTaskContext()?.signal` 改为优先用入参（保留兜底）。
- import：`spawn`/`ChildProcess`（child_process）、`path`/`fs`、`store`、`logMessage`、`getWhisperLanguage`（共享工具）、`TaskCancelledError`/`getTaskContext`。

adapter：

```ts
async transcribe(ctx: TranscribeContext): Promise<string> {
  return generateSubtitleWithLocalWhisper(ctx.event, ctx.file, ctx.formData, ctx.signal);
}
cancelActive(): void {
  cancelLocalCliTranscription();
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/engines/localCliEngine.ts main/helpers/subtitleGenerator.ts
git commit -m "refactor(engines): re-home localCli transcribe into localCliEngine.ts"
```

- [ ] **Step 3: 冒烟**：localCli 转写 + 取消一致。

---

## Task 4.6: subtitleGenerator 退化为共享工具 + 收尾

**Files:**

- Modify: `APP/main/helpers/subtitleGenerator.ts`
- Modify: 任何仍从 `subtitleGenerator` import 引擎函数的文件（grep 校验）

- [ ] **Step 1: 收敛共享工具**

`subtitleGenerator.ts` 此时应只剩共享工具：`secondsToSrtTime`、`getWhisperLanguage`、`getNumericSetting`，并新增 VAD 装配 helper（从 builtin/faster 抽公共部分，可选）：

```ts
export function buildVadParams(settings: any) {
  return {
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
}
```

确保导出 `secondsToSrtTime`/`getWhisperLanguage`/`getNumericSetting`（被各引擎 import）。删除文件内已不再使用的 import（`exec`/`spawn`/`getPythonRuntimeManager`/`loadWhisperAddon` 等随函数搬走的依赖）。

- [ ] **Step 2: 校验无反向依赖**

Run（grep）：搜索 `from '../subtitleGenerator'` 与 `from './subtitleGenerator'`，确认引用的只剩共享工具（无 `generateSubtitleWith*`）。各 `engines/*.ts` 不再从 subtitleGenerator import 引擎函数。

- [ ] **Step 3: 类型检查 + 提交**

Run：`npm run build` → 通过。

```bash
git add main/helpers/subtitleGenerator.ts main/helpers/engines/*.ts
git commit -m "refactor(engines): reduce subtitleGenerator to shared utils; engines are self-contained"
```

- [ ] **Step 4: 回归冒烟（Phase 4 整体）**

三引擎各跑一次转写 + 取消，结果/行为与重构前一致；`large-v3-turbo` 模型名解析正确。

---

# 收尾验收（对照 spec §10）

- [ ] Windows 冷启动不再 ping 超时；偶发慢启动自动重试成功；无孤儿/双进程。
- [ ] 三引擎均可取消（含 localCli kill child）。
- [ ] 升级：停机→备份→swap→自检→失败回滚；运行中禁止升级；显示真实 engineVersion（无 vlatest）。
- [ ] ping 返 protocolVersion；安装前 + 启动期双重区间校验；超区间拒装/拒启并提示升级 SmartSub。
- [ ] 更新检测：手动按钮 + 每日节流自动；sha256 比对判定。
- [ ] faster-whisper 有效并发=1，不再 OOM。
- [ ] 引擎自包含；subtitleGenerator 仅共享工具；signal 入 ctx；模型名显式映射。
- [ ] `npm run build` + `npm run check:i18n` 通过；PYENG `smoke_test.py` 通过。
- [ ] 无任何 Qwen3-ASR 代码/依赖/UI。
