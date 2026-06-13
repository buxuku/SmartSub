# 多引擎架构复盘 · Qwen3-ASR 接入 · 引擎独立升级（深度分析）

> 状态：分析/决策建议（未实现）
> 日期：2026-06-14
> 分支：`feat/multi-engine`
> 关联：`docs/superpowers/specs/2026-06-13-multi-engine-design.md`（原始设计）、`buxuku/smartsub-py-engine`
> 范围：① 评估现有多引擎实现是否最优、可优化点；② Qwen3-ASR 作为新引擎的接入方案/可行性/卡点；③ Python 引擎独立版本升级在 app 内的实现方案

本文是对已落地的多引擎分支的一次"代码级"复盘 + 三个前瞻问题的方案设计。所有结论均以当前仓库实际代码为依据（非设计文档），并标注证据位置。

---

## 0. 结论速览（TL;DR）

| 主题      | 结论                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现有架构  | 方向正确（适配器 + sidecar 基座 + 按需下载），是合理的"最优近似"。但有 4 处一致性/健壮性短板值得收口。                                                                                          |
| 最该先修  | ①取消语义三引擎不统一（localCli 根本停不掉）；②升级/重装未先停 sidecar，Windows 必踩文件锁；③manifest 版本号是字面量 `latest`（"已安装 vlatest" 的根因）。                                      |
| Qwen3-ASR | 强烈建议走 **本地开源权重接入现有 Python sidecar**（与 faster-whisper 同构，架构零新增基建，自带 ForcedAligner 出词级时间戳）。云 API 作为补充，但 `filetrans` 需公网 URL（OSS 上传）是硬卡点。 |
| 引擎升级  | 现有 `manifest.sha256` + release `checksums.sha256` **今天就能做更新检测**；缺的是"先停 sidecar→备份→swap→ping→回滚"的安全替换流程，以及协议版本协商（app/engine 解耦后的兼容性保险）。         |

---

## 1. 现状架构盘点（代码级）

### 1.1 分层与数据流

```
TaskProcessor (taskProcessor.ts)
  └─ processFile (fileProcessor.ts)
       └─ generateSubtitle → routeTranscription (transcriptionRouter.ts)
            └─ getActiveEngineAdapter() (engines/registry.ts)
                 ├─ builtinEngineAdapter      → generateSubtitleWithBuiltinWhisper
                 ├─ fasterWhisperEngineAdapter → generateSubtitleWithFasterWhisper → PythonRuntimeManager → sidecar
                 └─ localCliEngineAdapter     → generateSubtitleWithLocalWhisper (exec)
```

- 引擎选择：`resolveTranscriptionEngine(settings)`（`transcriptionEngine` 优先，回退 `useLocalWhisper ? 'localCli' : 'builtin'`），老用户零迁移。证据：`main/helpers/transcriptionEngine.ts`。
- 适配器接口：`id / displayName / requiresRuntime / isAvailable() / transcribe(ctx) / cancelActive?()`。证据：`main/helpers/engines/types.ts`。
- Python 基座：`PythonRuntimeManager` 走 stdio JSON-lines 协议，单例，崩溃 reject 全部 pending。证据：`main/helpers/pythonRuntime/manager.ts`、`index.ts`。
- 按需分发：`PyEngineDownloader`（GitHub/ghproxy + 断点续传 + SHA256 校验 + staging→current 原子替换 + 写 manifest）。证据：`main/helpers/pythonRuntime/downloader.ts`、`paths.ts`。
- sidecar 已支持逐段取消：`handle_cancel` 设置 per-request `threading.Event`，`faster_whisper_engine.transcribe` 在 segment 循环里 `if is_cancelled(): return None`。证据：`smartsub-py-engine/main.py`、`engines/faster_whisper_engine.py`。

### 1.2 做得好的地方（保持）

1. **引擎可插拔**：`EngineRegistry` 注册 + `TranscriptionRouter` 统一入口，新增引擎不侵入任务层。
2. **sidecar 进程隔离**：Python 崩溃/GIL 不拖垮主进程；env 消毒（`buildSanitizedEnv`）防系统 Python/conda 穿透。
3. **零增量分发**：安装包不含 Python；whisper.cpp 仍内置，符合产品定位。
4. **下载健壮**：断点续传 + SHA256 校验 + staging 原子替换 + ghproxy 镜像，复用 addon 的成熟经验。
5. **向前兼容**：ggml `modelsPath` 语义不变，双轨模型目录互不干扰。

---

## 2. 架构评估：可优化点（按优先级）

> 评级：🔴 影响正确性/用户可感知 · 🟡 健壮性/可维护性 · 🟢 长期演进

### 🔴 2.1 三引擎"取消"语义不统一，localCli 根本停不掉

- builtin：`whisperParams.signal = getTaskContext()?.signal` 传进 addon，原生中断并返回 cancelled 结果。证据：`subtitleGenerator.ts:318`。
- fasterWhisper：本轮已修（signal→`manager.cancel(id)`，sidecar 逐段中断，`{code:'cancelled'}` 转 `TaskCancelledError`）。
- **localCli：`generateSubtitleWithLocalWhisper` 用 `exec(runShell, cb)`，既不接 AbortSignal、适配器也没有 `cancelActive`。取消任务时 `cancelTask` 只 `killFfmpeg` + `controller.abort()`，那个 whisper CLI 子进程不会被杀，会一直跑完。** 证据：`subtitleGenerator.ts:189-220`、`localCliEngine.ts`（无 `cancelActive`）。

建议：

- `generateSubtitleWithLocalWhisper` 改 `spawn` 并保存 child，`localCliEngineAdapter.cancelActive()` 里 `child.kill()`；或在 `cancelTask` 里对 localCli 维护活动子进程表统一杀。
- 把"取消能力"提升为适配器一等公民：接口注释明确每个引擎必须实现可中断（builtin=signal、faster=sidecar cancel、localCli=kill child）。

### 🔴 2.2 安装/升级未先停 sidecar → Windows 文件锁

- `verifyExtractAndInstall` 直接 `fs.rmSync(currentDir)` 再 `rename(staging→current)`，**没有先 `shutdownPythonRuntime()`**。证据：`downloader.ts:366-372`。
- 对比 `uninstall-py-engine` 是先 `shutdownPythonRuntime()` 再删的（`ipcEngineHandlers.ts:117-123`）——说明团队已知该约束，但安装/升级路径漏了。
- 后果：用户用过一次 faster-whisper（sidecar 常驻）后再点"重新下载/修复/升级"，Windows 上 `current/` 内 `.exe`/`_internal/*.dll` 被锁，`rmSync` 抛错，升级失败。

建议：`download()` 进入 `extracting` 前调用 `await shutdownPythonRuntime()`；见 §4 升级流程。

### 🔴 2.3 manifest 版本号是字面量 `latest`（"已安装 vlatest" 根因）

- `writePyEngineManifest({ version: tag, ... })`，而 `tag === 'latest'`。证据：`downloader.ts:374`、`paths.ts:10`。
- 所以 UI 显示"已安装 vlatest"，也无法做语义化版本比较/展示。真正能区分新旧的是 `sha256`。

建议（与 §4 联动）：

- 短期：UI 不展示 `version`，改展示 `installedAt` 或 `sha256` 短哈希；
- 中期：py-engine 发布物带真实版本（见 §4.2）。

### 🟡 2.4 适配器过薄，引擎逻辑仍集中在 `subtitleGenerator.ts`

- 三个 adapter 都是 5~20 行壳子，真正实现 `generateSubtitleWithBuiltin/FasterWhisper/LocalWhisper` 全堆在 ~390 行的 `subtitleGenerator.ts`，并反向被 adapter 依赖。原设计里的 `getSupportedModels()`、`cancel(requestId)` 也没落地（实际是 `cancelActive?()` 且无 requestId）。
- 影响：引擎不是"自包含"的；加第 4 个引擎（如 Qwen3-ASR）会继续往这个大文件堆，内聚性下降。

建议：把各引擎的 transcribe 实现搬进各自 `engines/*.ts`，`subtitleGenerator.ts` 退化为共享工具（`formatSrtContent`、`secondsToSrtTime`、VAD 参数装配等）。接口补 `cancelActive` 为必选语义。

### 🟡 2.5 faster-whisper 并发安全：共享 sidecar + `maxConcurrentTasks` 默认 3

- 任务层默认并发 3（`taskProcessor.ts:229`），3 个文件会同时向**同一个** sidecar 发 `transcribe`，sidecar 为每个起 worker 线程（`main.py` 的 `threading.Thread`），共享 `_model_cache` 里的同一 `WhisperModel`。
- 风险：GPU 显存/内存随并发线性上涨，CT2 在单模型上的并发推理会争用/可能 OOM；进度/段事件交织（按 id 区分，OK）。builtin addon 同理（多个 `whisperAsync` 并发）。

建议：按引擎设并发上限（faster-whisper/GPU 建议 1~2，或在 sidecar 内用信号量串行化 `transcribe`），UI 在切到 GPU 引擎时给出并发提示。

### 🟡 2.6 模型名映射 ad-hoc

- `toFasterWhisperModel` 用正则去掉 `-q5_0` 量化后缀（`subtitleGenerator.ts:61`）。原设计提到"维护显式映射表"，目前是隐式正则，遇到 `large-v3-turbo` 等命名易出边界问题。

建议：集中一张 `ggml ↔ CT2 ↔ (未来)Qwen` 的显式映射表，任务层按引擎解析。

### 🟢 2.7 `TranscribeContext` 隐式依赖 AsyncLocalStorage

- 取消信号不在 `TranscribeContext` 里，而是引擎内部 `getTaskContext()?.signal` 取。能用，但属于隐式耦合，新引擎作者容易忘记接信号（如 localCli 就忘了）。

建议：把 `signal` 显式放进 `TranscribeContext`，由 router 注入，适配器显式消费。

### 🟢 2.8 协议无版本号

- `ping` 只返回 `version/python/frozen/engines`，没有 `protocolVersion`。app 与 sidecar 独立发版后无法判断协议兼容性（见 §4.3）。

---

## 3. Qwen3-ASR 接入方案

> 背景：评测显示 Qwen3-ASR 准确率很高（多语种 + 抗噪 + 唱歌/带 BGM），且自带词级时间戳能力。它有"云 API"和"开源权重"两条线，对字幕场景的关键差异在**时间戳**与**音频输入方式**。

### 3.1 能力与限制（核实自阿里云 Model Studio 官方文档，2026）

| 形态                               | 输入                                        | 时长/大小上限           | 时间戳                                                               | 部署                                         | 关键限制                                                 |
| ---------------------------------- | ------------------------------------------- | ----------------------- | -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| **云 `qwen3-asr-flash`**           | 本地文件上传 **或** 公网 URL，可流式        | ≤ 5 分钟 / ≤ 10MB       | 句级（VAD），词级偏弱                                                | OpenAI 兼容 + DashScope 同步                 | 本地文件调用 100 QPS 不可扩、不适合生产；超 5 分钟要切片 |
| **云 `qwen3-asr-flash-filetrans`** | **仅公网 URL**（OSS），不支持本地上传；异步 | ≤ 12 小时 / ≤ 2GB       | `enable_words:true` → **词级 + 句级**                                | DashScope 异步（提交-轮询）                  | 必须先把音频传到公网可达 URL；结果 JSON 24h 有效         |
| **开源 `Qwen3-ASR-1.7B/0.6B`**     | 本地音频                                    | 无硬上限（受显存/时长） | **词级**（配 `Qwen3-ForcedAligner-0.6B`，`return_time_stamps=True`） | transformers / GGUF(llama.cpp) / Rust server | 体积大（torch）或需 llama.cpp 音频后端；CPU 慢           |

- 价格（云）：约 $0.000035/秒 ≈ **$0.126/小时**音频。
- 开源许可：Apache 2.0；有 `ggml-org/Qwen3-ASR-0.6B-GGUF`（含 `mmproj` 音频编码器）可走 llama.cpp。

### 3.2 字幕场景的核心矛盾

字幕必须要**时间戳**。据此：

- 云 `flash`：能本地上传但时间戳弱、且 5 分钟上限 → 长视频需切片再拼时间轴，边界处易丢字/错位，**不推荐做主力字幕引擎**。
- 云 `filetrans`：时间戳达标、支持长音频，但**只接受公网 URL** → 桌面应用要把用户音频上传到公网 OSS（隐私 + 需 OSS 凭证/费用 + 上传耗时），**这是最大卡点**。
- 开源本地：时间戳达标（ForcedAligner 词级）、离线、免费、隐私好，**与现有 sidecar 架构天然契合**。

### 3.3 推荐方案：本地开源优先 + 云 API 补充

#### 方案 B（推荐）：本地开源权重接入现有 Python sidecar

把 Qwen3-ASR 作为 sidecar 里和 `faster_whisper` 平级的新引擎：

- py-engine 侧：新增 `engines/qwen3_asr_engine.py`，实现 `transcribe(params, emit_event, is_cancelled)`，内部用 `Qwen3ASRModel + Qwen3ForcedAligner` 出词级时间戳，按句聚合成 `segments:[{start,end,text}]`，复用现有协议；`is_cancelled` 同样在分段循环里检查。`list_engines()` 自动多出 `qwen3_asr: true`。
- SmartSub 侧（改动很小，正是架构红利）：
  - `types/engine.ts`：`TranscriptionEngine` 加 `'qwen3Asr'`。
  - 新增 `engines/qwen3AsrEngine.ts` 适配器（`requiresRuntime: true`，`isAvailable` 复用 `isPyEngineInstalled` + ping 的 `engines.qwen3_asr`）。
  - 模型目录：新增一份 Qwen3-ASR 权重目录 + Models Tab 引擎筛选项（沿用双轨模型逻辑）。
  - EnginesTab 增加一张卡片 + i18n。
- **卡点**：
  - 体积/算力：transformers 路线会把 PyInstaller 包从"faster-whisper 级"撑大（torch 数百 MB~GB）；CPU 跑 1.7B 慢。
  - 缓解：优先 **0.6B GGUF + llama.cpp 音频后端**（轻量、可 CPU），或 sidecar 内做 device=auto 降级；权重单独按需下载（不进 sidecar 包）。
  - GPU 矩阵：要 GPU 加速需处理 CUDA 依赖（与 faster-whisper 的 CUDA 分包同类问题）。

#### 方案 A（补充）：云 API 引擎

新增 `qwenAsrCloud` 适配器（`requiresRuntime:false`，`isAvailable` = 配了 DashScope API Key）：

- 字幕主力用 `filetrans`（`enable_words:true`）：流程 = 提取音频 → 上传到（用户配置的）OSS/临时公网存储 → 提交异步任务 → 轮询 → 下载结果 JSON → 词/句时间戳生成 SRT。
- 进度：轮询任务状态映射到现有 `taskProgressChange`；取消：停止轮询 + 标记任务取消。
- **卡点**：① 公网 URL/OSS 上传（隐私 + 凭证 + 成本 + 上传时延）；② 异步轮询复杂度；③ 联网/区域（OpenAI 兼容模式美区不可用）；④ 计费。
- 适用人群：不想本地占算力、可接受上云与付费、追求 SOTA 准确率的用户。

### 3.4 落地分期建议

1. **PoC**：在 `smartsub-py-engine` 加 `qwen3_asr_engine.py`（先 transformers 路线，本地手测词级时间戳→SRT 质量）。
2. **本地引擎 MVP**：SmartSub 加适配器 + 模型目录 + UI；优先 0.6B GGUF 控体积。
3. **云引擎（可选）**：先做 `flash` 短音频试水，再评估 `filetrans`+OSS 是否值得做。
4. 统一：把 §2.4 的"引擎自包含"重构先行，避免 `subtitleGenerator.ts` 继续膨胀。

---

## 4. Python 引擎独立版本升级（app 内）

> 诉求：py-engine 是单独仓库、独立发版（rolling `latest`）。当引擎单独升级后，app 要能在内部完成"检测→下载→替换"。

### 4.1 现状能力盘点

| 能力         | 现状                                                                 | 证据                    |
| ------------ | -------------------------------------------------------------------- | ----------------------- |
| 拉取         | 固定 `latest` 滚动 tag，按平台下载 `smartsub-engine-{suffix}.tar.gz` | `paths.ts:10,174`       |
| 校验         | release `checksums.sha256` 比对                                      | `downloader.ts:321-345` |
| 安装         | staging 解压→校验→`rm current`→`rename`→写 manifest                  | `downloader.ts:347-379` |
| 本地版本记录 | `manifest.json{version:'latest', platform, sha256, installedAt}`     | `paths.ts:152`          |
| **更新检测** | **无**（从不比较远端/本地）                                          | —                       |
| **停机替换** | **无**（升级不先停 sidecar）                                         | §2.2                    |
| **回滚**     | **无**（旧 current 先删）                                            | `downloader.ts:367-370` |
| **协议协商** | **无**（ping 无 protocolVersion）                                    | `protocol.ts:25`        |

### 4.2 更新检测：今天就能做（零新增发布物）

`manifest.sha256` 记录了已装产物哈希，release 的 `checksums.sha256` 是当前 latest 的哈希——**两者一比即可判断有无更新**：

```
checkUpdate():
  remote = parseExpectedChecksum(fetch(checksumsUrl), artifactName)  // 已有解析函数
  local  = readPyEngineManifest()?.sha256
  return remote && local && remote !== local  // → 有新版本
```

- 触发：EnginesTab "检查更新"按钮（手动）+ 启动后异步节流检查（每日一次，弱网静默失败）。
- 这是**最低成本**方案，完全适配 rolling `latest`。

### 4.3 真实版本 + 协议协商（中期，解耦保险）

rolling `latest` 的隐患：今天打包的旧 app，明天可能下到改了协议的新引擎，导致不兼容。建议：

1. py-engine 发布物追加 `manifest.json` 资产：`{ engineVersion, builtAt, protocolVersion, engines, sizeBytes, changelog }`；CI 顺带产出。
2. `ping` 返回里补 `protocolVersion`；app 声明 `SUPPORTED_PROTOCOL=[min,max]`。
3. app 安装/启动时校验：协议超范围 → 拒绝安装/启动并提示"请升级 SmartSub"，而非崩溃。
4. 可选：从 rolling `latest` 演进为"协议大版本 tag + latest 别名"（如 `p1-latest`），老 app 锁在兼容大版本上。

### 4.4 安全升级流程（修复 §2.2 + 加回滚）

```
upgrade():
  1. await shutdownPythonRuntime()            // 关键：先停，解 Windows 文件锁
  2. download + 校验 sha256                    // 复用现有
  3. 解压到 staging/，normalizeLayout 校验二进制存在
  4. 若存在 current/ → rename current → previous/   // 备份而非删除
  5. rename staging → current
  6. writeManifest
  7. manager.ensureStarted() + ping 自检
     ├─ 成功 → rm previous/，发完成事件
     └─ 失败 → 回滚：rm current；rename previous → current；重启旧版；报错
```

- 升级**不动** `py-engine-cache`（HF_HOME）与模型目录，已下模型保留。
- 运行中有转写任务时禁止升级（沿用"切换引擎需空闲"约束）。

### 4.5 卡点小结

| 卡点                      | 缓解                                                  |
| ------------------------- | ----------------------------------------------------- |
| Windows 运行中文件锁      | 升级前 `shutdownPythonRuntime()`（§4.4 步骤 1）       |
| 升级失败无退路            | `previous/` 备份 + ping 自检 + 回滚（§4.4）           |
| app/engine 解耦后协议漂移 | `protocolVersion` 协商 + 兼容区间拒装（§4.3）         |
| 版本不可读（vlatest）     | 发布 `manifest.json` 资产带 `engineVersion`（§4.3）   |
| 包体大、重复全量下载      | 已有断点续传；可加"仅哈希变化才下载"（§4.2 检测前置） |
| 镜像/弱网                 | 已有 ghproxy + 断点续传，沿用                         |

### 4.6 分期建议

1. **P0**：升级前停机（修 §2.2 文件锁）+ 更新检测（§4.2）+ UI"检查更新/有新版本"。
2. **P1**：`previous/` 备份与回滚（§4.4）。
3. **P2**：真实版本 + `protocolVersion` 协商（§4.3）。

---

## 5. 优先级路线图（汇总）

| 级别  | 事项                                                    | 章节      |
| ----- | ------------------------------------------------------- | --------- |
| 🔴 P0 | 升级/重装前 `shutdownPythonRuntime()`（Windows 文件锁） | 2.2 / 4.4 |
| 🔴 P0 | localCli 可取消（spawn + kill child / cancelActive）    | 2.1       |
| 🔴 P0 | 引擎更新检测（sha256 比对）+ "vlatest" 展示修正         | 2.3 / 4.2 |
| 🟡 P1 | 升级回滚（previous 备份 + ping 自检）                   | 4.4       |
| 🟡 P1 | faster-whisper 并发上限/串行化                          | 2.5       |
| 🟡 P1 | 引擎自包含重构（逻辑迁出 subtitleGenerator）            | 2.4       |
| 🟢 P2 | Qwen3-ASR 本地引擎接入（sidecar 新 engine）             | 3.3-B     |
| 🟢 P2 | 协议版本协商 + 真实版本发布物                           | 4.3       |
| 🟢 P2 | 模型名显式映射表 / signal 显式入 ctx                    | 2.6 / 2.7 |
| 🟢 P3 | Qwen3-ASR 云 API 引擎（filetrans + OSS）                | 3.3-A     |

---

## 6. 结论

当前多引擎方案是一个"方向正确、骨架健康"的实现：适配器 + sidecar 基座 + 按需下载 + 双轨模型，足以支撑长期演进。它**不是**最优的地方集中在"一致性与健壮性收口"：取消语义、停机替换、版本可读性/协议协商。这些是低风险、高收益的 P0/P1。

Qwen3-ASR 的接入，架构其实已经"为它而生"——直接作为 sidecar 的新引擎落地（自带词级时间戳、与 faster-whisper 同构），是性价比最高的路径；云 API 因公网 URL/隐私/成本更适合做补充选项。

引擎独立升级，**基础数据（manifest.sha256 + checksums）已经齐全**，最小实现就能跑通更新检测；真正要补的是"安全替换 + 协议解耦"这层工程保险。
