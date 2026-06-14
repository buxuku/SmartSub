# 多引擎健壮性收口 · 引擎独立升级（§4.3 一步到位）· Windows ping-timeout 根因修复 —— 实现设计

> 状态：实现设计（已通过 brainstorming 决策，待写实现计划）
> 日期：2026-06-14
> 分支：`feat/multi-engine`
> 关联：`docs/superpowers/specs/2026-06-14-multi-engine-review-qwen-upgrade.md`（分析/决策）、上游 `smartsub-py-engine`（本机 `/Users/xiaodong/Documents/code/smartsub-py-engine`）
> 范围：落地分析文档中**除 Qwen3-ASR 以外**的全部条目，外加用户新增的 Windows「ping timeout 15000」根因修复。

---

## 0. 范围与排除

### 0.1 纳入（按优先级分 5 个 Phase）

| Phase | 主题                                           | 来源条目                         | 优先级                |
| ----- | ---------------------------------------------- | -------------------------------- | --------------------- |
| 0     | 引擎生命周期健壮性 + **ping-timeout 根因修复** | 新增 + §2.2 前置                 | 🔴 P0                 |
| 1     | 取消语义统一（localCli 可中断）                | §2.1                             | 🔴 P0                 |
| 2     | 安全升级 + 更新检测 + 协议协商                 | §2.2 / §2.3 / §4.2 / §4.3 / §4.4 | 🔴 P0 + §4.3 一步到位 |
| 3     | faster-whisper 并发钳制                        | §2.5                             | 🟡 P1                 |
| 4     | 引擎自包含重构 + 收口                          | §2.4 / §2.6 / §2.7               | 🟡 P1 / 🟢 P2         |

### 0.2 排除（本次不做）

- §3.3-B Qwen3-ASR 本地开源引擎接入。
- §3.3-A Qwen3-ASR 云 API 引擎（filetrans + OSS）。
- §4.3 第 4 点「协议大版本 tag + `latest` 别名（如 `p1-latest`）」——YAGNI，保留 rolling `latest` + 协议区间校验即可。

### 0.3 brainstorming 决策（4 个均取推荐项 A）

1. **ping-timeout 修复力度**：A —— `find_spec` 根因修复 + app 进程清理&超时重试 + 预热，三项全做。
2. **faster-whisper 并发**：A —— app 侧把有效并发钳制为 1 + 切到该引擎时 UI 提示。
3. **引擎自包含重构**：A —— 完整重构（三个 transcribe 实现搬进各自 `engines/*.ts`，`subtitleGenerator.ts` 退化为共享工具，`cancelActive` 升为接口必选）。
4. **升级/协议**：A —— 完整 §4.3/§4.4（manifest.json 资产 + ping 返回 protocolVersion + 安装/启动双重区间校验 + 安全升级回滚 + 真实版本展示 + 每日节流自动检查）。

---

## 1. 现有关键事实（代码级，作为设计前提）

- 单例运行时管理器：`PythonRuntimeManager`，stdio JSON-lines 协议。`STARTUP_TIMEOUT_MS = 15_000`（`main/helpers/pythonRuntime/manager.ts:46`）。
- `ensureStarted()`：`this.proc && this.lastPingInfo` 时早返；否则 `start()` → spawn → `request('ping', {}, {timeoutMs: 15000})`（`manager.ts:90-144`）。
- `request` 超时只 `reject` JS 侧 Promise 并从 `pending` 删除，**不杀进程**（`manager.ts:175-185`）。
- `start()` 直接 `this.proc = proc`，若上次有未清理进程会被覆盖（孤儿）（`manager.ts:115`）。
- py-engine `handle_ping` → `list_engines()`，后者执行真正的 `import faster_whisper`（`smartsub-py-engine/engines/__init__.py:22-30`，第 25 行 import）。
- 安装/升级：`download()` → `verifyExtractAndInstall()`：`fs.rmSync(currentDir)` 后 `rename(staging→current)`，**未先 `shutdownPythonRuntime()`**，**无 previous 备份/回滚**（`downloader.ts:321-380`，删除在 366-370）。
- manifest 版本为字面量：`writePyEngineManifest({ version: tag, ... })` 且 `tag === 'latest'`（`downloader.ts:374`、`paths.ts:10`）。
- 卸载路径**已**先停机：`uninstall-py-engine` 先 `await shutdownPythonRuntime()`（`ipcEngineHandlers.ts:116-123`）——升级路径照抄即可。
- 并发：`maxConcurrentTasks` 默认 3（`taskProcessor.ts:73,230`），`availableSlots = maxConcurrentTasks - activeTasksCount`（`taskProcessor.ts:382`）。
- 取消：`cancelTask` 调 `controller.abort()` + `killFfmpegForFiles` + `getActiveEngineAdapter().cancelActive?.()`（`taskProcessor.ts:260-300`）。
- localCli：`generateSubtitleWithLocalWhisper` 用 `exec(runShell, cb)`，不接 signal、adapter 无 `cancelActive`（`subtitleGenerator.ts:189-244`、`engines/localCliEngine.ts`）。
- 适配器接口：`isAvailable / transcribe / cancelActive?`（`engines/types.ts:12-19`）。`fasterWhisper.isAvailable` 已刻意不做运行时 ping（`fasterWhisperEngine.ts:17-29`）。
- 项目无自动化测试运行器（无 `test` 脚本、无 jest/vitest 依赖；存量 `*.test.tsx` 无 runner）。可用校验：`npm run build`（含 tsc 类型检查）、`npm run check:i18n`、`prettier`；py-engine 侧 `python smoke_test.py`。

---

## 2. Phase 0 · 引擎生命周期健壮性（含 ping-timeout 根因修复）

### 2.1 根因分析（Windows「ping timed out after 15000ms」）

转写开始 → `generateSubtitleWithFasterWhisper` → `manager.ensureStarted()`。当 sidecar 未就绪（冷启动 / 上次崩溃退出 / 进程被杀）时会 spawn 并发 `ping`（15s 超时）。Python 端 `handle_ping` 调 `list_engines()`，其中 `import faster_whisper` 会连带加载 ctranslate2 / av / tokenizers / onnxruntime(VAD) 等重依赖。Windows 上 PyInstaller onedir 首次加载这些 DLL（叠加杀软扫描 + 磁盘冷缓存）经常 > 15s → ping 超时。"平时正常、偶尔超时" = 缓存热则快、冷则超。

**连带 bug**：ping 超时仅 reject JS Promise，未杀掉仍在 import 的 Python 进程；`this.proc` 仍在、`lastPingInfo` 为空，下一次 `ensureStarted()`（`this.proc && lastPingInfo` 为 false、`startingPromise` 已置空）会再次 `start()` → spawn 第二个进程并覆盖引用 → **进程泄漏 + Windows 文件锁**（直接破坏 Phase 2 的"升级前停机"）。

### 2.2 py-engine 改动（根治）

`engines/__init__.py` 的 `list_engines()` 改为只探测、不导入：

```python
import importlib.util

def list_engines():
    return {
        "faster_whisper": importlib.util.find_spec("faster_whisper") is not None,
    }
```

- `find_spec` 在 PyInstaller 冻结环境下经 `PyiFrozenImporter`（`sys.meta_path`）查找，返回 spec 而**不执行模块**，毫秒级。
- 重依赖推迟到首个 `transcribe` 的 `_get_model()` 惰性加载（`faster_whisper_engine.py:13-35` 已是惰性 import，无需改）。`transcribe` 无 15s 上限，加载慢只表现为首段延迟，不再误报超时。
- `smoke_test.py` 的 ping 冒烟仍需通过（断言 `result.engines` 存在）。

### 2.3 app 改动（`manager.ts`）

1. **超时即清理**：把 `request` 的超时回调，从"仅 reject"升级为：对 `ping`/启动场景，超时时 `this.proc?.kill()` 并 `handleExit('ping timeout')`，确保不留孤儿、`this.proc` 归零。实现上在 `start()` 内对启动 ping 单独处理（catch → kill proc → 置空 → rethrow）。
2. **start() 防重入覆盖**：进入 `start()` 时若 `this.proc` 非空，先 `kill()` 旧进程再 spawn（或直接复用 `stop()`），避免覆盖引用导致的孤儿。
3. **冷启动超时上调 + 重试一次**：新增 `START_PING_TIMEOUT_MS = 60_000`；`start()` 内 ping 失败（超时/engine_exited）时，重启进程重试一次，仍失败才抛。常规 `request`（transcribe/cancel）不变。
4. **错误信息**：保持 `PythonEngineError('timeout', ...)`，但 `generateSubtitleWithFasterWhisper` 的 catch 文案区分"冷启动超时（建议重试/已自动重试）"与"引擎不可用"。

> 备注：`STARTUP_TIMEOUT_MS` 重命名/保留为 `START_PING_TIMEOUT_MS = 60_000`；如其它处引用需同步。

### 2.4 预热（warmup）

- **批处理开始前预热**：`taskProcessor` 在 `isProcessing` 由 false→true（首次进入处理，`taskProcessor.ts:227-232`）时，若当前引擎 `requiresRuntime`，`void getPythonRuntimeManager().ensureStarted()` 非阻塞预热（失败仅记日志，真正错误仍在 transcribe 时抛出给对应文件）。
- **切换引擎时预热**：`set-transcription-engine` 切到 `fasterWhisper` 成功后，`void manager.ensureStarted()` 非阻塞预热。
- 目的：把冷启动成本移出"首个文件关键路径"，并让 60s 重试在用户开始批量前完成。

### 2.5 验收

- macOS/Windows：删除 `current/` 后重装→首个 faster-whisper 任务不报 ping 超时；冷启动（重启电脑后首次）不超时或自动重试成功。
- 人为 kill sidecar 进程后再起任务：不产生第二个常驻进程（任务管理器/`ps` 验证仅一个 `smartsub-engine`）。
- `python smoke_test.py dist/smartsub-engine/smartsub-engine` 通过。

---

## 3. Phase 1 · 取消语义统一（localCli 可中断）

### 3.1 设计

- `generateSubtitleWithLocalWhisper` 由 `exec` 改为 `spawn`（shell 模式），保存子进程引用到模块级 `activeLocalCliChild`。
- `localCliEngineAdapter` 新增 `cancelActive()`：`activeLocalCliChild?.kill()`（Windows 用 `taskkill /pid <pid> /T /F` 或 `child.kill()`；为杀整棵进程树，Windows 下用 `tree-kill` 语义——优先 `process.platform === 'win32' ? spawn('taskkill', ['/pid', String(pid), '/T', '/F']) : child.kill('SIGTERM')`）。
- 接 `getTaskContext()?.signal`：signal abort 时同样触发 kill（与 builtin/faster 一致），并在退出后清空引用。
- 取消时 srt 处理：若子进程被杀，跳过 rename，按 `TaskCancelledError` 处理。

### 3.2 接口收口

- `engines/types.ts`：`cancelActive` 由可选 `cancelActive?()` 升为**必选** `cancelActive(): void`。
  - builtin：no-op（注释说明取消经 `whisperParams.signal` 原生中断）。
  - fasterWhisper：现有 `cancelFasterWhisperTranscription()`。
  - localCli：kill child。
- `taskProcessor.ts:286` 的 `getActiveEngineAdapter().cancelActive?.()` 去掉可选链（必选后恒在）。

> 注：本 Phase 仅做功能性最小改动（让 localCli 真正可停）。函数搬家到 `engines/localCliEngine.ts` 在 Phase 4 重构中 **re-home（移动而非重写）**。

### 3.3 验收

- 用 localCli 引擎转写时点取消：whisper CLI 子进程立即结束（`ps`/任务管理器验证），任务标记 cancelled，不残留半截 srt。

---

## 4. Phase 2 · 安全升级 + 更新检测 + 协议协商（§4.3 一步到位）

### 4.1 数据结构

**py-engine 单一版本源**：新增 `_version.py`：

```python
ENGINE_VERSION = "0.1.0"
PROTOCOL_VERSION = 1
```

`main.py` 从中导入（替换内联 `ENGINE_VERSION = "0.1.0"`，`main.py:28`），CI 也从中读取（`python -c "import _version; print(_version.ENGINE_VERSION, _version.PROTOCOL_VERSION)"`）。

**release 资产 `manifest.json`**（CI `publish_latest` 生成，与 `checksums.sha256` 同目录）：

```json
{
  "engineVersion": "0.1.0",
  "protocolVersion": 1,
  "builtAt": "2026-06-14T00:00:00Z",
  "gitSha": "<github.sha 短>",
  "engines": ["faster_whisper"],
  "artifacts": {
    "windows-x64": { "sizeBytes": 178000000, "sha256": "<hash>" },
    "macos-arm64": { "sizeBytes": 165000000, "sha256": "<hash>" },
    "macos-x64": { "sizeBytes": 170000000, "sha256": "<hash>" },
    "linux-x64": { "sizeBytes": 172000000, "sha256": "<hash>" }
  }
}
```

**ping 返回补字段**（`protocol.ts` `PingResult` + py-engine `handle_ping`）：新增 `protocolVersion: number`、`engineVersion: string`（`engineVersion` 即 `ENGINE_VERSION`，`version` 字段保留兼容）。

**app 本地 manifest 扩展**（`types/engine.ts` `PyEngineManifest`）：新增可选 `engineVersion?: string`、`protocolVersion?: number`、`builtAt?: string`、`gitSha?: string`。`version` 字段保留（迁移期老安装仍可能为 `'latest'`）。

**app 协议常量**（新文件 `main/helpers/pythonRuntime/protocolSupport.ts` 或 `paths.ts`）：

```ts
export const SUPPORTED_PROTOCOL_MIN = 1;
export const SUPPORTED_PROTOCOL_MAX = 1;
export function isProtocolSupported(v: number | undefined): boolean {
  return (
    typeof v === 'number' &&
    v >= SUPPORTED_PROTOCOL_MIN &&
    v <= SUPPORTED_PROTOCOL_MAX
  );
}
```

### 4.2 更新检测

新增 `paths.ts` 助手 `getPyEngineManifestUrl(source, tag)`（与 `getPyEngineChecksumsUrl` 同构，指向 `manifest.json`）。

`downloader.ts` 新增 `checkUpdate(source)`：

```ts
async checkUpdate(source): Promise<PyEngineUpdateInfo> {
  const local = readPyEngineManifest();
  const checksums = await fetchHttpText(getPyEngineChecksumsUrl(source));
  const remoteHash = parseExpectedChecksum(checksums, getArtifactFileName());
  let remoteManifest: RemoteManifest | null = null;
  try { remoteManifest = JSON.parse(await fetchHttpText(getPyEngineManifestUrl(source))); } catch {}
  const hasUpdate = !!(remoteHash && local?.sha256 && remoteHash !== local.sha256);
  return { installed: !!local, hasUpdate, localManifest: local, remoteManifest, remoteHash };
}
```

- **主信号**：`remoteHash !== local.sha256` 判定有无更新（完全适配 rolling `latest`）。
- **展示**：本地用 `manifest.engineVersion + builtAt`（无则回退 `installedAt`/sha256 短哈希），**取代"已安装 vlatest"**。
- **触发**：
  - EnginesTab「检查更新」按钮（手动，IPC `check-py-engine-update`）。
  - 启动后每日一次节流静默检查：记录 `lastUpdateCheckAt`（electron-store），>24h 才查；弱网/失败静默（仅日志）。检查到更新仅在 UI 标记"有新版本"，不自动下载。

### 4.3 协议区间校验

- **安装/升级前**（`download()` 开头，下载前）：拉远端 `manifest.json`，取 `protocolVersion`，`!isProtocolSupported(...)` → 抛 `PythonEngineError('protocol_unsupported', ...)`，UI 提示"该引擎版本需要更新的 SmartSub，请先升级 SmartSub"。远端无 `manifest.json`（老 release）时：放行（向后兼容），仅记日志。
- **启动期**（`manager.start()` ping 成功后）：`!isProtocolSupported(info.protocolVersion)` 且 `protocolVersion` 存在 → `stop()` 进程 + 抛 `protocol_unsupported`。`protocolVersion` 缺失（老引擎）→ 放行。

### 4.4 安全升级流程（§4.4，含回滚）

重写 `verifyExtractAndInstall`（或拆出 `installFromStaging`），核心顺序：

```
1. await shutdownPythonRuntime()                 // 解 Windows 文件锁（依赖 Phase 0：无孤儿进程）
2. 校验 sha256（现有）
3. 解压 staging/ + normalizeLayout + 校验二进制存在（现有）
4. (协议校验：远端 manifest.protocolVersion 已在 download() 前置校验)
5. 若 current/ 存在 → rename current → previous/        // 备份不删
   （previous/ 若已存在先 rm）
6. rename staging → current
7. writeManifest（含 engineVersion/protocolVersion/builtAt/gitSha/sha256/platform/installedAt）
8. 自检：getPythonRuntimeManager().ensureStarted() + ping
   ├─ 成功且协议支持 → rm previous/，完成
   └─ 失败 → 回滚：rm current/；rename previous → current；writeManifest(旧)；重启旧版自检；抛错
```

- 升级**不动** `py-engine-cache`（HF_HOME）与模型目录（`getFasterWhisperModelsPath`）。
- **运行中禁止升级**：`start-py-engine-download` 与 `check`→升级路径，主进程侧校验任务忙则拒绝。新增 `taskProcessor` 导出 `isTranscriptionBusy(): boolean`（基于 `activeTasksCount > 0 || processingQueue.length > 0`），下载/升级 IPC 调用它，忙则 `{ success:false, error:'engine_busy' }`。UI 已对 uninstall 用 `taskBusy` 禁用，升级/下载按钮同样禁用并提示。

### 4.5 IPC + UI

- 新增 IPC：`check-py-engine-update`（返回 `PyEngineUpdateInfo`）。
- `get-engine-status` 的 fasterWhisper 状态附带版本展示数据（`engineVersion`/`builtAt`），由 `readPyEngineManifest()` 提供（`fasterWhisperEngine.isAvailable` 已读 manifest，扩展返回）。
- EnginesTab：
  - faster-whisper 卡片展示"已安装 vX.Y.Z（builtAt）"，替换 vlatest。
  - 新增「检查更新」按钮 + "有新版本可用 → 升级"主操作（复用下载/进度 UI；升级走相同 `start-py-engine-download` 但语义为覆盖升级，安全流程已含备份/回滚）。
  - 升级/检查/卸载在 `taskBusy` 时禁用并提示。
  - 切到 faster-whisper 时显示"该引擎转写串行执行（并发=1）"提示（与 Phase 3 联动）。
- i18n：在 `renderer/public/locales/{zh,en}/resources.json` 增 `engines.fasterWhisper.*` 新键（checkUpdate / updateAvailable / upgrade / installedVersion / serialNote / protocolUnsupported / engineBusy 等）；`npm run check:i18n` 必须通过。

### 4.6 py-engine CI 改动（`.github/workflows/release.yml`）

- `publish_latest` job 在生成 `checksums.sha256` 后，额外生成 `manifest.json`：读取各产物 `sizeBytes`+`sha256`（复用 `checksums.sha256` 与 `stat`），`engineVersion/protocolVersion` 从 `_version.py` 读，`builtAt=$(date -u +%FT%TZ)`，`gitSha=${GITHUB_SHA::7}`，`engines=["faster_whisper"]`，写入 `artifacts/manifest.json` 并随 `files: artifacts/*` 一并发布。

### 4.7 验收

- 旧安装（manifest.version='latest'）：UI 不再显示 vlatest；点检查更新能正确判定。
- 上游推一个新构建后：检查更新显示"有新版本"，点升级→Windows 不报文件锁→升级成功→显示新版本。
- 人为损坏 staging 二进制（自检失败）：自动回滚到旧版且仍可用。
- 模拟远端 `protocolVersion=99`：安装/升级被拒并提示升级 SmartSub，不崩。

---

## 5. Phase 3 · faster-whisper 并发钳制（§2.5）

### 5.1 设计

- `taskProcessor.processNextTasks` 计算可用槽位时，按当前 active 引擎钳制：

```ts
const activeEngineId = getActiveEngineAdapter().id; // 或 resolveTranscriptionEngine(store.get('settings'))
const effectiveMax =
  activeEngineId === 'fasterWhisper' ? 1 : maxConcurrentTasks;
const availableSlots = effectiveMax - activeTasksCount;
```

- 引擎运行中不可切换（UI 已用 `taskBusy` 锁），故运行期 `effectiveMax` 稳定。
- 不引入新设置（决策 A）。高端 GPU 的可调并发留作后续（YAGNI）。

### 5.2 UI 提示

- EnginesTab：faster-whisper 卡片/激活时注明"为避免显存争用，转写串行执行（并发=1）"。
- 可选：任务页若 `maxConcurrentTasks>1` 且引擎为 faster-whisper，给一次性 toast/说明（轻量，复用 i18n）。

### 5.3 验收

- 设并发=3 + faster-whisper：同一时刻仅 1 个文件在转写（日志/进度验证），不再 OOM/崩 sidecar。
- 其它引擎（builtin/localCli）并发不受影响（仍可 3）。

---

## 6. Phase 4 · 引擎自包含重构 + 收口（§2.4 / §2.6 / §2.7）

### 6.1 函数搬家（行为保持）

- `generateSubtitleWithBuiltinWhisper` → `engines/builtinEngine.ts`。
- `generateSubtitleWithFasterWhisper` + `cancelFasterWhisperTranscription` → `engines/fasterWhisperEngine.ts`。
- `generateSubtitleWithLocalWhisper`（Phase 1 已改 spawn）→ `engines/localCliEngine.ts`（re-home）。
- `subtitleGenerator.ts` 退化为**共享工具**模块（保留文件名以减少 import 改动，或重命名 `engines/subtitleShared.ts` 并改引用）：`secondsToSrtTime`、`getWhisperLanguage`、`getNumericSetting`、VAD 参数装配 helper（`buildVadParams(settings)`）、`formatSrtContent` re-export。
- adapter 直接实现 transcribe，不再反向依赖 `subtitleGenerator` 的引擎函数。

### 6.2 §2.7 signal 显式入 ctx

- `engines/types.ts`：`TranscribeContext` 增 `signal?: AbortSignal`。
- `transcriptionRouter.routeTranscription`：注入 `signal: getTaskContext()?.signal`。
- 各 adapter 消费 `ctx.signal`（替代内部 `getTaskContext()?.signal`）；过渡期保留 `getTaskContext()` 兜底但以 ctx 为准。

### 6.3 §2.6 模型名显式映射表

- 新增 `engines/modelMap.ts`：显式 `ggml ↔ CT2`（未来可扩展列）。

```ts
// ggml 模型名（含量化后缀） → faster-whisper(CT2) 仓库/目录名
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
  return GGML_TO_CT2[base] ?? base; // 未命中回退原值并记日志
}
```

- 替换 `subtitleGenerator.ts:61-63` 的隐式正则，覆盖 `large-v3-turbo` 等边界。

### 6.4 验收

- 三引擎转写/取消功能与重构前一致（builtin signal 中断、faster sidecar 逐段取消、localCli kill child）。
- `npm run build` 类型检查通过；`subtitleGenerator` 不再被 adapter 反向依赖（grep 验证）。
- `large-v3-turbo` 等模型名解析正确。

---

## 7. 跨仓库改动清单（`/Users/xiaodong/Documents/code/smartsub-py-engine`）

| 文件                            | 改动                                                                         | Phase |
| ------------------------------- | ---------------------------------------------------------------------------- | ----- |
| `engines/__init__.py`           | `list_engines()` 改 `importlib.util.find_spec`（不 import）                  | 0     |
| `_version.py`（新增）           | `ENGINE_VERSION` / `PROTOCOL_VERSION` 单一源                                 | 2     |
| `main.py`                       | 从 `_version` 导入；`handle_ping` 返回补 `protocolVersion` / `engineVersion` | 2     |
| `.github/workflows/release.yml` | `publish_latest` 生成并发布 `manifest.json` 资产                             | 2     |
| `smoke_test.py`                 | 保持 ping 冒烟通过（find_spec 后仍断言 engines 存在）                        | 0     |

> 说明：py-engine 与 app 解耦发版，须保证"老 app + 新引擎"协议兼容（protocolVersion=1 不变即兼容）。改协议须升 `PROTOCOL_VERSION` 并同步 app 的 `SUPPORTED_PROTOCOL_MAX`。

---

## 8. 测试与验证策略

- **类型/构建**：每 Phase 结束跑 `npm run build`（nextron/tsc 类型检查必过）。
- **i18n**：动 i18n 后 `npm run check:i18n` 必过。
- **格式**：`prettier --write`（lint-staged 已配）。
- **纯函数自测**（手动/可选脚本，无 runner 不强引框架）：`parseExpectedChecksum`、`checkUpdate` 判定、`isProtocolSupported`、`toFasterWhisperModel`、`secondsToSrtTime`。
- **py-engine**：`python smoke_test.py` 与 `python smoke_test.py dist/smartsub-engine/smartsub-engine`（CI 矩阵已含）。
- **手动冒烟矩阵**（重点 Windows）：
  - 冷启动首个 faster-whisper 任务（无 ping 超时 / 自动重试成功）。
  - kill sidecar 后再起任务（无第二常驻进程）。
  - localCli 取消（子进程树被杀）。
  - 重装/升级时 sidecar 在跑（无文件锁，升级成功）。
  - 自检失败回滚（损坏二进制）。
  - protocol=99 拒装提示。
  - 并发=3 + faster-whisper（实际串行）。

---

## 9. 风险与缓解

| 风险                                 | 缓解                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Phase 4 重构动转写热路径，回归风险   | 行为保持式搬家；逐引擎对照重构前后；构建+手动冒烟三引擎；放在 P0/P1 健壮性之后      |
| `find_spec` 在冻结环境异常           | smoke_test 验证；保底可回退为"冻结构建恒 True"策略（但优先 find_spec）              |
| 升级自检/回滚在 Windows 文件锁下失败 | 强依赖 Phase 0（无孤儿进程）+ `shutdownPythonRuntime()` 先行；previous 备份保证可退 |
| 老 release 无 manifest.json          | 协议校验/版本展示对缺失字段放行回退，不阻断                                         |
| 60s 启动超时仍偶发不够               | 失败重试一次 + 预热前移；必要时可再调                                               |
| 钳制并发=1 影响吞吐                  | 仅对 faster-whisper；其它引擎不变；后续可加可调设置                                 |

---

## 10. 验收标准（总）

1. Windows「ping timeout 15000」不再因冷启动重依赖触发；偶发慢启动可自动重试成功；无孤儿/双进程。
2. 三引擎均可被取消（含 localCli kill child）。
3. 升级：先停机→备份→swap→ping 自检→失败回滚；运行中禁止升级；不再显示 vlatest，显示真实 engineVersion。
4. §4.3 协议：ping 返 protocolVersion；安装前 + 启动期双重区间校验；超区间拒装/拒启并提示升级 SmartSub。
5. 更新检测：手动按钮 + 每日节流自动；sha256 比对判定。
6. faster-whisper 有效并发=1，不再 OOM。
7. 引擎自包含：transcribe 实现在各自 `engines/*.ts`；`subtitleGenerator` 仅共享工具；signal 入 ctx；模型名显式映射。
8. 全程 `npm run build` + `npm run check:i18n` 通过；py-engine `smoke_test.py` 通过。
9. 不引入任何 Qwen3-ASR 代码/依赖/UI。

---

## 11. 实现顺序与依赖

```
Phase 0 (lifecycle/ping)  ──→  Phase 2 (safe upgrade 依赖可靠停机/重启)
Phase 1 (localCli cancel) ──┐
Phase 3 (concurrency clamp)─┼─→ 相对独立，可并行排期
Phase 4 (refactor)        ──┘   （re-home Phase 1 的 localCli cancel）
```

建议落地顺序：**0 → 1 → 2 → 3 → 4**（严格遵循 P0→P1 优先级；Phase 0 为 Phase 2 前置）。每个 Phase 自成可工作状态，单独提交。
