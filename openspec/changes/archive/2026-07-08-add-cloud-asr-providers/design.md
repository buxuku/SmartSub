## Context

现有转写为**逐任务引擎适配器**架构：`formData.transcriptionEngine` + `formData.model` → `routeTranscription` → `getEngineAdapterForTask` → `adapter.transcribe(ctx)`，产物统一为写好的 SRT。适配器接口见 `main/helpers/engines/types.ts`（`isAvailable / transcribe / cancelActive / prewarm`）；`ctx` 携带已抽好的本地音频 `file.tempAudioFile`（16kHz / mono / pcm_s16le WAV）、`event`（IPC 进度）、`signal`（取消）。

另有一套**独立的翻译服务商**范式：`types/provider.ts` 的 `ProviderType.fields`（凭证字段声明）→ 用户配置多实例存 `store.translationProviders` → `TRANSLATOR_MAP[provider.type]` 分发 → 配置页 + `isProviderConfigured` 的「已配置/未配置」分组 + 批量/限速/重试基础设施。

在线 ASR 是二者的混血：像**引擎**一样产出转写、插入 `transcribe` 流程；又像**服务商**一样需要凭证、可多实例、网络型（天然可高并发，与本地 GPU 引擎「并发钳到 1」相反）。spike（`scripts/spike/asr-openai-compat.mjs`）已验证 OpenAI 兼容 `whisper-1` 产出词级时间戳、且 `words[]` 可直接喂进内置引擎的 `NativeToken` 成句管线。

约束：Electron + Next(nextron)；主进程 TS；已有 `openai` / `axios` 依赖；`check:i18n`、`test:engines` 守卫；本项目卖点含「纯本地/隐私」。

## Goals / Non-Goals

**Goals:**

- 在线 ASR 成为与本地引擎**并列的一等转写来源**，用户在同一个「引擎 ▸ 模型」下拉里选择。
- 采用**多实例凭证服务商**模型（仿翻译服务商：配置页 + 已配置分组），首个类型为 **OpenAI 兼容转写**，并为后续类型预留数据驱动的分发位。
- **最大化复用**现有成句/时间轴管线（`subtitleSegmentation` / `subtitleTiming` / `formatSrtContent`）与进度/取消约定。
- 云引擎**高并发** + 每请求**显式超时/有限重试**（spike 已复现 SDK 默认 10 分钟挂起）。
- **非破坏**：本地引擎零改动；未配置云服务商时行为不变。
- **隐私/成本护栏**：音频上云前一次性提示；按时长给出用量预估提示。

**Non-Goals:**

- **仅公网 URL 的服务商**（阿里 Filetrans/Paraformer、腾讯录音文件识别）——需用户自备对象存储，本期**不做**。
- 实时/流式转写、字幕内说话人分离（未来可扩展）。
- 真实计费/用量计量（仅做时长预估提示，不接账单）。
- 把 ASR 混入现有翻译服务商下拉/存储。

## Decisions

### D1 — 多实例「云端听写服务商」而非单一 settings 三字段（采纳用户 1B）

**决定**：仿翻译服务商，做可配置多个实例、有配置页、按「已配置/未配置」分组的 ASR 服务商，而非只在 settings 放 `base_url/api_key/model` 三字段。

**理由**：用户可能同时用多家/多 key（如公司 OpenAI + 自建 Groq）；与既有翻译服务商 UX 一致、可复用 `ProviderField` 表单渲染与 `isProviderConfigured`。**代价**：改动面比三字段大。**备选（弃）**：settings 三字段——最快但只能一个端点、发现性差、与既有范式割裂。

### D2 — 独立 `store.asrProviders`，不复用 `translationProviders`

**决定**：新增独立存储键 `asrProviders`（结构仿 `Provider`），配套 `AsrProviderType`（`types/asrProvider.ts`）。

**理由**：ASR 与翻译是不同能力，混存会让翻译下拉误列 ASR 实例、字段语义打架。独立键隔离清晰、迁移简单（纯新增）。**备选（弃）**：`translationProviders` + `capability` 标记——省一个 store 键，但需在所有翻译消费点加过滤，易漏、耦合高。

### D3 — 单个通用云引擎适配器 + `ASR_TRANSCRIBER_MAP[type]`，而非「每家一个引擎 id」

**决定**：`types/engine.ts` 只加**一个**云引擎 id（如 `'cloud'`）；`cloudAsrEngine.ts` 按所选服务商实例的 `type` 从 `ASR_TRANSCRIBER_MAP` 分发到具体实现（`main/service/asr/*`）。

**理由**：多实例服务商模型已经承载「厂商 + 模型」两维，引擎层无须为每家膨胀 `TranscriptionEngine` 联合类型与 `getEngineModelGroups`/`Models.tsx` 的硬编码分支（现在每加一个引擎要改 ~5 处）。加一家 ASR = 加一条服务商类型 + 一个 transcribe 函数。**备选（弃）**：每家一个引擎 id——天然融入分组，但联合类型/分组/图标处处硬编码、扩展成本高。

### D4 — 「引擎 ▸ 模型」下拉承载云实例：选择需携带 (engine, asrProviderId, model)

**决定**：每个**已配置的云服务商实例**在下拉里作为一个分组（组名=实例名，如「我的 OpenAI」），组内列该实例可选模型；选中项写入 `formData.transcriptionEngine='cloud'` + 新增 `formData.asrProviderId=<实例id>` + `formData.model=<模型>`。就绪判定 = 该实例必填字段齐全。

**理由**：当前 `encodeEngineModel` 只编码 (engine, model) 两维；云需要第三维「哪个实例」。把实例作为分组、并在 `onChange` 回传 `providerId`，比把 id 塞进模型串更清晰。`getEngineModelGroups` 建议顺手改为**数据驱动**（本地引擎照旧、云实例按 `asrProviders` 聚合）。**备选（弃）**：把 `providerId` 编进 model 字符串——省字段但污染 model 语义、易解析出错。

### D5 — 时间轴：优先词级时间戳 → 复用内置成句管线；无词级则按静音切片降级

**决定**：请求优先 `response_format:'verbose_json'` + `timestamp_granularities:['word']`。把 `words[{word,start,end}]` 映射为 `NativeToken{text, t0:start*1000, t1:end*1000}`，走**现有** `tokensToTriples → groupTokenCues → mergeShortCues → enforceMinDisplayDuration → trimSubtitleTrailingSilence`（与 `builtinEngine.ts` 的 token 分支同源）。因本地有 WAV，能量裁剪照常。

- **中文**：spike 证实 `segments` 常为 1 大段但字级 `words` 精准 → **必须**走 words 再切分（segment 不可用）。
- **无词级模型**（如 `gpt-4o-transcribe` 拒 `verbose_json`）：降级为「用 `energySpeechSegments` 按静音切片、每片调一次、加块起始偏移、拼接」得到段级时间轴，UI 标注「粗粒度时间轴」。
- **中文标点缺失**（whisper-1 中文 `words` 逐字且**不含标点**，标点只在整段文本）：实现层做「整段文本标点回贴字级时间轴」的 best-effort 对齐；失败则产出无标点 cue（可接受）。

**备选（弃）**：只用段级时间戳——中文会得到一条 16s 巨块，不可用。

### D6 — 音频：复用本地 WAV；超限则压缩，再超则按静音切片

**决定**：默认直接上传本地 `tempAudioFile`（16kHz mono WAV，≈1.9MB/min）。若超服务商大小/时长上限（如 Whisper 25MB≈13min）：先 **ffmpeg 转码压缩**（opus/mp3，体积骤降）；仍超限或超时长上限则用 `energySpeechSegments` **按静音切片**（带最大块时长/大小上限），各块并发转写、加偏移后拼接。**本地 WAV 始终保留**用于能量裁剪。新增逻辑落在 `audioProcessor.ts` 的「云用音频准备」，**不动本地引擎路径**。

### D7 — 并发、超时、限速

**决定**：云引擎**排除**出 `isRestrictiveEngine`（`taskProcessor.ts`），遵循用户 `maxConcurrentTasks`（云为网络型，可高并发）。每请求设**显式超时**（如 120s，可按服务商覆盖）+ **有限重试**（指数退避、限次），避免 spike 复现的 SDK 默认 10 分钟挂起。每服务商可选 `requestInterval`/并发上限（复用翻译限速字段语义）。

### D8 — 取消

**决定**：`ctx.signal` 透传给 `openai` SDK / `axios` 的 `signal`；`cancelActive()` abort 在途请求；切片模式下 abort 全部子请求并清理半成品。与既有引擎取消语义一致。

### D9 — 隐私与成本护栏

**决定**：首次使用任一云服务商转写前，弹**一次性确认**（说明音频将离开本机），记住选择；任务前按音频总时长给**用量/成本预估提示**（不接真实账单）。文档同步说明。

### D10 — 就绪判定与引导

**决定**：云引擎 `isAvailable` = 存在至少一个字段齐全的 `asrProviders` 实例（复用/泛化 `isProviderConfigured`）。未就绪时下拉给「去配置云端听写」入口（仿现有「去下载模型」引导）。

## Risks / Trade-offs

- **隐私反弹**（纯本地是卖点之一）→ D9 一次性显式同意 + 文档；默认不选云、不上传。
- **长视频成本意外** → D9 时长预估提示 + D6 压缩降体积；文档标注按分钟计费。
- **模型时间戳差异 / 无词级**（gpt-4o-transcribe）→ D5 降级切片 + UI 标注；默认推荐 whisper-1。
- **服务商大小/时长上限** → D6 压缩 + 按静音切片。
- **聚合商模型可用性不一**（spike 中 DeerAPI 无 `whisper-large-v3`，触发连接错误）→ 模型名可**自填**，对「不支持/连接错误」给清晰报错，不静默挂起。
- **SDK 默认超时过长导致挂起**（spike 已复现）→ D7 显式超时 + 限次重试。
- **中文 words 无标点** → D5 标点回贴；退化为无标点 cue 可接受。
- **UI 三维选择复杂化**（engine/instance/model）→ D4 用「实例即分组」把复杂度收敛在下拉内部。

## Migration Plan

- **纯新增**：新增 `store.asrProviders` 键与 `formData.asrProviderId` 字段；**不写 store 默认值**（避免 electron-store 合并默认值回灌老用户，遵循 `subtitle-outcome-presets` 的经验）。
- 无既有数据迁移；老用户无云服务商时行为完全不变。
- **回滚**：移除云引擎注册与 UI 分组即可，本地引擎与既有存储不受影响。

## Open Questions

- 第二个服务商类型优先级：**Deepgram**（最便宜、词级时间戳、REST 直传）vs **阿里 DashScope Qwen3-ASR**（与本地 Qwen 同源、中文强）？
- 切片默认上限与压缩编码（opus vs mp3）默认值——实现期按实测调。
- 是否在后续版本把说话人分离/多语种检测结果透出到字幕或校对。
