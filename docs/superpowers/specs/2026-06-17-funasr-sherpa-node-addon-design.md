# FunASR 切换 sherpa-onnx Node 原生 addon — 技术设计

> 状态：已评审（决策已确认，待出实施 Plan）
> 日期：2026-06-17
> 分支：建议新建 `feat/funasr-sherpa-node`（当前在 `feat/three-layer-p0`）
> 范围：把 FunASR 转写运行时从「Python sidecar 的 sherpa-onnx Python API」切换为「`sherpa-onnx-node` N-API 原生 addon」，根治 Windows 首次转写卡死；faster-whisper 的 Python 三层（P0）不动
> 关联：`main/helpers/engines/funasrEngine.ts`、`funasrParams.ts`、`funasrModelCatalog.ts`、`funasrModelDownloader.ts`、`addonLoader.ts`、`addonManager.ts`、`pythonRuntime/*`、`taskProcessor.ts`、`ipcEngineHandlers.ts`、引擎仓 `smartsub-py-engine`
> 前序：`docs/superpowers/specs/2026-06-16-three-layer-multi-engine-design.md`（§6.2 曾把本路线列为「B 方案/未来优化」）、`docs/superpowers/specs/2026-06-16-engine-ux-funasr-optimization-design.md`

---

## 0. 结论速览（TL;DR）

把 FunASR 从「Python sidecar 里调 sherpa-onnx 的 Python API」改为「直接用 sherpa-onnx 官方 **N-API 原生 addon `sherpa-onnx-node`**」。彻底去掉 FunASR 对 Python 的依赖，从根上消除 Windows「首次转写卡 0% 无进度」：不再有 Python 进程 spawn、stdio JSON-lines 握手、PBS/PyInstaller 冷启动，也不再让杀软扫描刚解压的 Python 目录树；模型加载与解码用 `createAsync`/`decodeAsync` 在工作线程执行，首个文件实时有进度。

采用**方案 C**：保留经测试的稳定边界（Adapter 契约 + 模型目录/下载器 + 引擎感知 UI/i18n），**只重写「运行时内核」**，并定点拆除 Python-FunASR 接线。模型文件字节完全相同（同样的 `model.int8.onnx`/`tokens.txt`/`silero_vad.onnx`），模型层零改动。

### 已确认决策

| #   | 决策点                  | 结论                                                                               |
| --- | ----------------------- | ---------------------------------------------------------------------------------- |
| 1   | 切换范围                | **仅 FunASR**；faster-whisper Python 三层（P0 成果）完全不动                       |
| 2   | 重写 vs 删改（你的 Q3） | **方案 C**：保留稳定边界 + 新建隔离运行时 + 定点删除 Python-FunASR 接线            |
| 3   | 原生库分发              | **方案 B**：按需下载到 `userData`，复用现有下载器/校验/原子替换/ad-hoc 重签        |
| 4   | 原生库托管              | **托管到引擎仓 `smartsub-py-engine`** 的 release；主仓只发布 App 软件包            |
| 5   | 加速设备                | **仅 CPU**（sherpa-onnx-node 预编译仅 CPU；与三层设计「SenseVoice CPU 已够」一致） |
| 6   | 运行隔离                | **worker_thread** 托管 addon（非阻塞 + 干净取消 + 崩溃隔离）                       |
| 7   | Python-FunASR 兜底      | **不保留双轨**（无正式发布用户，直接替换）                                         |

---

## 1. 背景与现状

### 1.1 现状（已逐文件核对）

- FunASR **已经在用 sherpa-onnx**，但走的是 **Python sidecar 里的 sherpa-onnx Python API**：`funasrEngine.ts` 通过 `getPythonRuntimeManager().ensureStarted('funasr')` + `manager.transcribe(params)` 调用引擎仓 `engines/funasr_sensevoice_engine.py` 的 `OfflineRecognizer.from_sense_voice/from_paraformer` + silero VAD。
- 模型已是 sherpa-onnx 格式：`funasrModelCatalog.ts` 的 `FUNASR_MODELS` 下载 `csukuangfj/sherpa-onnx-sense-voice-*` 与 `sherpa-onnx-paraformer-zh-*` 的 `model.int8.onnx`+`tokens.txt`，以及 `silero_vad.onnx`，存于 `userData/models/funasr/<id>/`。
- 参数层 `funasrParams.ts` 已围绕 sherpa-onnx 设计：`provider`（注释「P1 仅 cpu 落地，cuda/coreml 预留」）、`num_threads`、`use_itn`、`vad_threshold/min_silence/min_speech/max_speech`。
- FunASR 与 faster-whisper **共享同一套 Python 运行时基建**：`pythonRuntime`（`manager`/`index`/`paths`/`downloader`/`autoUpdateCheck`）、`ipcEngineHandlers`、`taskProcessor` 里都有 funasr 分支。

### 1.2 Windows 首次转写卡死

最近两次提交（`5b6385f` 批次预热、`4a175e0` 释放写流）尝试缓解未果。根因是「首次加载原生库 + ONNX + 杀软扫描」叠加在 Python sidecar 冷启动/首个 transcribe 的关键路径上，且 stdio 握手与进程模型放大了「卡 0% 无进度」的观感。切换到进程内（worker 线程）原生 addon 后，这条关键路径整体消失。

### 1.3 为什么是现在做、为什么可行

- `sherpa-onnx-node`（v1.13.2，2026-05，Apache-2.0）官方维护、N-API、预编译、API 覆盖 SenseVoice + Paraformer + silero VAD，与现有 Python 逻辑可 1:1 映射（见 §4–§5）。
- 主仓已有**完全同构的原生 addon 加载与分发基建**（`addonLoader`/`addonManager` 给 whisper.cpp 的 CUDA/Vulkan 包用），直接照搬。

---

## 2. 目标与非目标

### 2.1 目标

1. 用 `sherpa-onnx-node` 原生 addon 实现 FunASR（SenseVoice + Paraformer + silero VAD）转写，输出与现状一致的 SRT。
2. 根治 Windows 首次转写卡 0% 无进度。
3. 复用经测试的稳定边界（Adapter 契约、模型目录/下载器、引擎感知 UI/i18n），最小化回归面。
4. 原生库按需下载到 userData，主包体积不受冲击（仍 ≤200MB 预算内）。
5. 拆除 FunASR 对 Python 的依赖；faster-whisper 的 Python 三层零回归。

### 2.2 非目标（YAGNI）

- 不为 FunASR 做 GPU（sherpa-onnx-node 预编译仅 CPU；GPU 需手动换 .so/.dll + 装 CUDA toolkit，不适合预编译分发，且 SenseVoice CPU INT8 已够）。
- 不动 faster-whisper / whisper.cpp / Qwen 的任何路线。
- 不保留 Python-FunASR 双轨兜底。
- 不引入新的下载协议/后端基础设施（复用现有镜像回退、SHA256、原子替换、ad-hoc 重签）。

---

## 3. 总体架构

```
TranscriptionRouter (taskProcessor → getActiveEngineAdapter)
  └─ funasrEngineAdapter            保留契约；去掉 pyEngineId（不再是 Python 引擎）
       └─ sherpaFunasrRuntime.ts    新：编排（加载/预热/转写/取消/会话缓存）
            └─ worker_thread: sherpa-worker.js   新：托管 addon + recognizer + VAD
                 ├─ vendored sherpa-onnx-node 顶层 JS 封装（~18 个小文件，无原生码）
                 ├─ sherpaLoader.ts  新（仿 addonLoader）：dlopen userData 原生库 + 库路径注入
                 ├─ Vad(sileroVad)                  → 语音分段
                 └─ OfflineRecognizer(senseVoice|paraformer).decodeAsync → 逐段识别

  复用：funasrModelCatalog / funasrModelDownloader / models/funasr/* / funasrParams
        / 引擎感知 UI（ModelsTab/EnginesTab/Layout 徽标）/ i18n / systemInfo 模型字段
  新增：sherpaLibManager + sherpaLibDownloader（原生库 安装/下载/校验/原子替换/回滚/ad-hoc 重签）
        + sherpa 库的 IPC/UI（下载/卸载/更新，复用 addon 卡片范式）
  删除：funasrEngine 对 pythonRuntime 的依赖；pythonRuntime/ipcEngineHandlers/taskProcessor/
        autoUpdateCheck 中的 funasr 分支；引擎仓 funasr Python 包 + sidecar
```

### 3.1 与现有架构的关系

- `TranscriptionEngineAdapter`（`engines/types.ts`）契约保留：FunASR 仍是一个 adapter，仅 `transcribe`/`isAvailable`/`prewarm` 的内部实现改为走 `sherpaFunasrRuntime`，并去掉 `pyEngineId`。
- `funasrModelCatalog` / `funasrModelDownloader` / `models/funasr/*`：**完全复用**（模型文件字节相同）。
- `funasrParams`：**复用**（类型名 `FunasrSidecarParams` → `FunasrAddonParams` 仅改名；字段不变）。
- 引擎感知 UI / i18n / `systemInfo` 模型字段：**复用**（P1 + 引擎 UX 优化成果）；其中「FunASR 引擎已装」的语义来源从「Python 引擎包已装」改为「sherpa 原生库已装」。

---

## 4. 原生库分发（方案 B + 引擎仓托管）

### 4.1 产物与托管

- **引擎仓 `smartsub-py-engine` CI** 新增一条「sherpa 原生库重打包」流水线：拉取 6 个平台的 npm 平台包（`sherpa-onnx-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win-x64,win-ia32}`），抽出运行所需文件，重打成独立发布资产：
  - 内容：`sherpa-onnx.node` + 依赖原生库（macOS `*.dylib` / Linux `*.so` / Windows `*.dll`，含 `libonnxruntime`、`libsherpa-onnx-c-api`）。
  - 命名：`smartsub-sherpa-onnx-<platform>-<version>.tar.gz` + `.sha256`。
  - 托管：引擎仓 release（与现有 faster-whisper/funasr 引擎包同处），带 ghproxy/gitcode/hf-mirror 回退。
- **主仓只发布 App 软件包**，不内置 sherpa 原生库（保持主包小、绕开 asar）。

### 4.2 userData 布局

```
userData/
  sherpa-onnx/
    current/                 # 当前平台一份
      sherpa-onnx.node
      *.dylib | *.so | *.dll
      manifest.json          # version / platform / sha256 / installedAt
    staging/                 # 下载/解压暂存（成功后原子替换 current）
    previous/                # 上一版本备份（失败回滚）
  models/funasr/             # 复用，不变
    sensevoice-small/  paraformer-zh/  silero-vad/
```

### 4.3 下载器 `sherpaLibDownloader.ts`

照搬 `PyEngineDownloader` / `addonManager` 的成熟能力：镜像源回退、断点续传、SHA256 校验、`staging → current` 原子替换、`previous` 备份 + 失败回滚、安装后加载自检（`require + 构造一个空 recognizer`）。

> **关键收益**：原生库放在 userData（asar 之外）→ 天然绕开「.node 打进 asar、打包后路径解析失败、需要 `asarUnpack`」这类 Electron 打包坑（社区 issue #3108 打包后崩的根因）。

### 4.4 库管理 `sherpaLibManager.ts`

仿 `addonManager.ts`：`getSherpaLibDir()`、`isSherpaLibInstalled()`、`readSherpaLibManifest()`、`register/remove/backup/restore`、`getSherpaLibSummary()`（供 UI 与 `isAvailable` 用）。

---

## 5. 加载与运行时

### 5.1 `sherpaLoader.ts`（仿 `addonLoader.ts`）

- `setupLibraryPath(libDir)`：Windows 注入 `PATH`、Linux 注入 `LD_LIBRARY_PATH`、macOS 依赖同目录 + `@loader_path`（见 §9）。与 `addonLoader.setupLibraryPath` 同构。
- 解析 userData 的 `sherpa-onnx.node` → 加载 → 会话级缓存（缓存 key 覆盖库版本）→ 失败 try/catch 给清晰错误。
- **全局约定**：所有 sherpa API 调用统一带 `enableExternalBuffer: false`（Electron 21+ 必需，否则报「External buffers are not allowed」）。封装在 runtime 内部，调用方不感知。

### 5.2 vendored JS 封装

`sherpa-onnx-node` 的顶层是纯 JS 封装（`non-streaming-asr.js` / `vad.js` / `sherpa-onnx.js` / `types.js` 等，约 18 个小文件、无原生码、约 20KB）。**随 App 打包**这层 JS，并把其「加载平台 `.node`」的解析改为指向 userData 下载的 `sherpa-onnx.node`（自定义 resolver）。即「JS API 随包、原生库下载」。

### 5.3 worker_thread 协议

`sherpaFunasrRuntime` 起一个常驻 worker（`sherpa-worker.js`）托管 addon、recognizer、VAD：

```ts
// 主线程 → worker
type SherpaReq =
  | {
      type: 'load';
      asrModel: string;
      tokens: string;
      vadModel: string;
      modelType: 'sense_voice' | 'paraformer';
      params: FunasrAddonParams;
    }
  | { type: 'transcribe'; id: string; audioFile: string }
  | { type: 'cancel'; id: string }
  | { type: 'dispose' };

// worker → 主线程
type SherpaRes =
  | { type: 'ready' }
  | { type: 'progress'; id: string; percent: number }
  | { type: 'done'; id: string; segments: Segment[]; language?: string }
  | { type: 'error'; id: string; message: string; code?: 'cancelled' };

interface Segment {
  start: number;
  end: number;
  text: string;
}
```

- **会话缓存**：recognizer/VAD 按 `(modelType, asrModel, tokens, num_threads, language, use_itn)` 缓存，等价现有 Python `preload` 缓存；切模型才重建。
- **预热**：批次开始时 `sherpaFunasrRuntime.prewarm()` 发 `load`，与 ffmpeg 抽音频并行（保留现有 prewarm 思路，但走 worker，非 Python preload）。失败非致命。

---

## 6. 转写流水线（worker 内）

1. `readWave(audioFile)` → `{ samples: Float32Array, sampleRate: 16000 }`。输入 `tempAudioFile` 已由 ffmpeg 统一为 **16kHz / 单声道 / pcm_s16le**（`audioProcessor.ts` 的 `.audioFrequency(16000).audioChannels(1)`），与 sherpa `readWave` 期望一致。
2. `Vad({ sileroVad: { model, threshold, minSpeechDuration, minSilenceDuration, windowSize: 512, maxSpeechDuration }, sampleRate: 16000, numThreads })`：按 `windowSize` 喂帧 → `isDetected` / `front(false)` / `pop` / `flush`，取出完整语音段。段时间：`start = seg.start / 16000`，`end = start + seg.samples.length / 16000`。
3. 每段：`stream = recognizer.createStream(); stream.acceptWaveform({ samples: seg.samples, sampleRate: 16000 }); await recognizer.decodeAsync(stream); const r = recognizer.getResult(stream)` → `r.text`（SenseVoice 另有 `lang/emotion/event`）。
4. **进度**：已处理样本 / 总样本 → `percent`，逐段回报（映射现有 `onProgress` → `taskProgressChange`）。
5. **合并 → SRT**：`Segment[]` 交给现有 `formatSrtContent` + `secondsToSrtTime`（复用 `engines/transcribeShared`）。
6. **取消**：`ctx.signal` abort → 给 worker 发 `cancel`，worker 在段间检查并尽快返回 `code:'cancelled'`；必要时主线程 `worker.terminate()` 硬取消。映射现有 `TaskCancelledError` 语义。
7. **语言**：`funasrParams.getFunasrLanguage(sourceLanguage)`（auto/zh/yue/en/ja/ko）→ SenseVoice 语言；Paraformer 分支忽略 `language/use_itn`（与现状一致）。

---

## 7. 复用 / 改接 / 删除清单（文件级）

| 文件                                                                           | 处置         | 说明                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engines/funasrModelCatalog.ts`、`funasrModelDownloader.ts`、`models/funasr/*` | **复用**     | 模型文件字节完全相同                                                                                                                                |
| `engines/funasrParams.ts`                                                      | **复用**     | `FunasrSidecarParams`→`FunasrAddonParams` 仅改名；字段不变                                                                                          |
| `ModelsTab` / `EnginesTab` / `Layout` 徽标 / i18n / `systemInfo` 模型字段      | **复用**     | P1+UX 成果；`funasrEngineInstalled` 语义改为「sherpa 库已装」                                                                                       |
| `engines/funasrEngine.ts`                                                      | **重写内核** | `getPythonRuntimeManager()`→`sherpaFunasrRuntime`；`isAvailable` 改查 `isSherpaLibInstalled()`+模型；去掉 `pyEngineId`                              |
| `engines/types.ts` `TranscriptionEngineAdapter`                                | **小改**     | `prewarm` 解耦 `pyEngineId`                                                                                                                         |
| `taskProcessor.ts`                                                             | **改接**     | prewarm 门控：有 `pyEngineId` 才 `ensureStarted`；总是 `adapter.prewarm?.()`；funasr 并发钳制=1 保留                                                |
| `ipcEngineHandlers.ts`                                                         | **改接**     | 删 funasr 的 `getPyEngineDownloader`/`coerceEngineId`/warmup 分支；`set-transcription-engine` 改查 sherpa 库；`set-funasr-settings` 保留            |
| `pythonRuntime/index.ts`                                                       | **删**       | `resolveEngineEnv('funasr')` 分支 + `getFunasrModelsRoot` import                                                                                    |
| `pythonRuntime/autoUpdateCheck.ts`                                             | **删**       | `UPDATABLE_ENGINES` 去掉 `'funasr'`（sherpa 库有独立更新路径）                                                                                      |
| `systemInfoManager.ts`                                                         | **改接**     | 「FunASR 引擎已装」来源改为 sherpa 库；模型字段保留                                                                                                 |
| `types/engine.ts` `PyEngineId`                                                 | **改**       | 去掉 `'funasr'`（仅 `faster-whisper`）；`TranscriptionEngine` 仍含 `funasr`                                                                         |
| `store/types.ts` funasr 设置                                                   | **复用**     | `funasrProvider/funasrUseItn/funasrNumThreads` 仍生效                                                                                               |
| **新增** `main/helpers/sherpaOnnx/`                                            | **新建**     | `sherpaLibManager.ts`、`sherpaLibDownloader.ts`、`sherpaLoader.ts`、`sherpaFunasrRuntime.ts`、`sherpa-worker.js` + vendored 封装 + sherpa 库 IPC/UI |

---

## 8. 引擎仓 `smartsub-py-engine` 改动（跨仓，独立提交）

- **删**：`engines/funasr_sensevoice_engine.py`、`requirements-funasr.txt`、`engines/__init__.py` 中 funasr 注册、CI（`release.yml`）funasr 矩阵、`smoke_test.py` funasr 部分。
- **保留**：faster-whisper 全部（基座/包/CI 不动）。
- **新增**：§4.1 的「sherpa 原生库重打包」CI 流水线与 6 平台 release 资产 + checksum。

---

## 9. 跨平台与签名

| 平台    | 要点                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | DLL 与 `.node` 同目录；下载后注入 `PATH`（复用 `setupLibraryPath`）；userData 加载，无 asar 问题；`enableExternalBuffer:false`                                                                                                                             |
| macOS   | dylib 与 `.node` 同目录；下载后 `install_name_tool -change @rpath/<lib> @loader_path/<lib>`（规避 SIP 屏蔽 `DYLD_LIBRARY_PATH`）+ `codesign -s - --force` 递归 ad-hoc 重签（复用 `pythonRuntime/macSign.ts` 思路）；改写 install_name 后再重签（顺序关键） |
| Linux   | `.so` 与 `.node` 同目录；注入 `LD_LIBRARY_PATH`；onnxruntime 选 gnu 构建，注意 glibc 兼容                                                                                                                                                                  |

> 全程不需要开发者证书：原生库被 Electron 主进程（无 library validation）加载，ad-hoc / 本地自签即可，与现有 whisper addon、Python 基座同机理。

---

## 10. 参数与能力

- `funasrParams.buildFunasrParams` 全保留；`provider` 固定 `'cpu'`（`cuda/coreml` 仍留枚举位但不实现）。
- VAD 调参（`vad_threshold` / `vad_min_silence_duration_ms` / `vad_min_speech_duration_ms` / `vad_max_speech_duration_s`）→ 映射 `Vad` 配置（ms→s、`0`=不限制）。
- `use_itn` 仅 SenseVoice 生效；Paraformer 分支忽略 `use_itn` 与 `language`（与现状一致）。
- 引擎能力描述（如已有 Capability 体系）：FunASR `devices=['cpu']`、`models='onnx'`、`features.vad=true / itn=true（SenseVoice）`。

---

## 11. 错误处理与回退

- **sherpa 库未下载/加载失败**：`isAvailable` 返回 `not_installed`/`error` 并给清晰文案，引导「资源中心 → 重新下载 sherpa 运行库」；并提供一键回退 whisper.cpp（App 永远能出字幕的保底，复用现有 fallback 通知 UX）。
- **模型缺失**：沿用现有 `isFunasrReady`（VAD + ≥1 ASR）与「去模型页下载」引导。
- **worker 崩溃**：runtime 捕获 worker `error/exit`，标记当前任务失败并给可读错误，下次任务重建 worker（崩溃隔离，不拖垮主进程）。
- **取消**：映射 `TaskCancelledError`，与 faster-whisper/builtin 行为一致。

---

## 12. 测试策略

| 层级                    | 内容                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 主仓单测                | `sherpaLoader` 路径解析与库路径注入；`sherpaLibManager` 原子替换/回滚；VAD 分段→SRT 时间拼接；取消语义；`funasrParams` 映射 |
| 引擎仓                  | 「sherpa 库重打包」CI 对每平台跑 `require + 构造空 recognizer` 自检；SHA256 校验                                            |
| 集成（DevTools IPC）    | 下载 sherpa 库 → 切 funasr → 预热 → SenseVoice / Paraformer 各出 SRT                                                        |
| **重点冒烟（Windows）** | **首次转写有进度、不卡 0%**（核心验收）；冷机 + 杀软开启                                                                    |
| 回归                    | faster-whisper / whisper.cpp 全程不受影响；`npx tsc --noEmit`（根 + renderer）；`npm run check-i18n`                        |

---

## 13. 风险与缓解

| 风险                                           | 等级 | 缓解                                                                                                   |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| Electron 加载原生 `.node` 失败（ABI/路径/SIP） | 中   | userData 加载绕开 asar；N-API 免 rebuild；mac `@loader_path`+ad-hoc 重签；`enableExternalBuffer:false` |
| 长音频 VAD 循环占 CPU 卡 UI                    | 低   | 跑在 worker_thread，不阻塞主进程/IPC                                                                   |
| 6 平台库重打包出错/缺库                        | 中   | CI 每平台 `require+构造` 自检 + SHA256；下载后安装自检                                                 |
| 删 Python-FunASR 误伤 faster-whisper           | 中   | 文件级清单（§7）+ 删后 `tsc` + faster-whisper 端到端冒烟回归                                           |
| Windows 杀软误报下载的 `.dll`/`.node`          | 低   | 官方/镜像源 + SHA256 + 不 UPX + 加白引导（与现有 CUDA 包一致）                                         |
| 时间戳精度（VAD 段级 vs 词级）                 | 低   | 段级时间满足字幕；如需更细可后续用 recognizer token 级时间戳优化                                       |

---

## 14. 分阶段实施（PA → PB → PC）

### PA — 原生库下载 + 加载打通

- 引擎仓「sherpa 库重打包」CI + 6 平台 release 资产（先出 1–2 个开发平台）。
- 主仓 `sherpaLibManager` + `sherpaLibDownloader` + `sherpaLoader` + vendored JS 封装。
- 验收：下载 sherpa 库到 userData → `require` 成功 → 构造一个 recognizer 并对一段 wav `decode` 出文本（最小 hello-decode）。

### PB — worker 转写流水线 + 适配器接线

- `sherpa-worker.js` + `sherpaFunasrRuntime`（load/transcribe/cancel/progress/会话缓存/预热）。
- `funasrEngine.ts` 重写内核（保留 adapter 契约）；`isAvailable` 改查 sherpa 库 + 模型。
- 验收：端到端 SenseVoice / Paraformer 出 SRT；进度/取消/预热正常；**Windows 首次转写不卡 0%**。

### PC — 拆除 Python-FunASR + 引擎仓清理 + 收尾

- 删除 §7/§8 列出的 Python-FunASR 接线与引擎仓 funasr 包/sidecar。
- sherpa 库的 IPC/UI（下载/卸载/更新，复用 addon 卡片范式）；i18n 文案。
- 验收：faster-whisper / whisper.cpp 全回归通过；`tsc` + `check-i18n`；磁盘卸载/更新链路可用。

---

## 评审结论（已确认）

| #   | 决策点       | 结论（已确认）                                             |
| --- | ------------ | ---------------------------------------------------------- |
| 1   | 切换范围     | 仅 FunASR；faster-whisper 三层不动                         |
| 2   | 重写 vs 删改 | 方案 C（保留边界 + 重写运行时内核 + 定点删 Python-FunASR） |
| 3   | 原生库分发   | 方案 B（按需下载到 userData）                              |
| 4   | 原生库托管   | 引擎仓 `smartsub-py-engine` release；主仓只发 App          |
| 5   | 加速设备     | 仅 CPU                                                     |
| 6   | 运行隔离     | worker_thread                                              |
| 7   | Python 兜底  | 不保留双轨                                                 |

下一步：据本设计产出逐 Task 的实施 Plan（`docs/superpowers/plans/2026-06-17-funasr-sherpa-node-addon.md`，按 PA→PB→PC 拆分）。
