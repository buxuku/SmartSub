## Context

云端听写现有架构（`add-cloud-asr-providers` + `cloud-asr-provider-grouping` 已落地）：单一云引擎 `'cloud'` → 按实例 `type` 经 `ASR_TRANSCRIBER_MAP` 分发到 `main/service/asr/*`；服务商类型由 `ASR_PROVIDER_TYPES` 数据驱动（字段表单、面板分区、testConnection 探测）；时间轴三级降级（词级 → 段级 → 静音切片粗粒度）；音频准备为「≤上限整段上传 → 超限压缩 mp3 → 仍超限按静音切片」，上限由**全局常量** `CLOUD_MAX_UPLOAD_BYTES`（24MB）/ `CLOUD_MAX_CHUNK_SECONDS`（600s）钉死。

火山引擎「豆包大模型录音文件识别·极速版」API 形态（2026-07 官方文档核实）：

- `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`，**同步**一次请求返回全部结果；官方上限 **≤2 小时 / ≤100MB** 音频；
- 鉴权 header 两种形态：旧版控制台 `X-Api-App-Key`（App ID）+ `X-Api-Access-Key`（Access Token）；新版控制台单 `X-Api-Key`（API Key）。另需 `X-Api-Resource-Id: volc.bigasr.auc_turbo`（固定值）+ `X-Api-Request-Id`（uuid）+ `X-Api-Sequence: -1`。**本实现仅支持新版单 API Key**（用户决策，见 D1）；
- 请求体：`{ user: { uid }, audio: { data: <base64> | url }, request: { model_name: 'bigmodel', enable_punc, enable_itn, enable_ddc, show_utterances, ... } }`；
- 成败以**响应 header `X-Api-Status-Code`** 判定（`20000000` 成功），非仅 HTTP 状态。错误码表（官方文档）：`20000003` 静音音频；`45000001` 参数无效 / `45000002` 空音频 / `45000151` 音频格式不正确（参数类，不可重试）；`550xxxxx` 服务内部错误、`55000031` 服务器过载（可重试）；
- 响应体：`result.text`（整段带标点）+ `result.utterances[]`（分句，`start_time`/`end_time`/`text` + `words[]` 逐字时间戳，**毫秒**）；utterance 文本带标点、`words[].text` 逐字**无标点**；
- 音频格式宽容（wav/mp3/ogg/aac 等），base64 放入 JSON 体后的请求体上限官方未单独明示。

约束：design.md（add-cloud-asr-providers）Non-Goal 红线——仅公网 URL 的服务商不做；本项目守卫 `check:i18n`、`test:engines`；grouping 变更固化的三步扩展 recipe 与「品牌型硬单例」呈现约定。

## Goals / Non-Goals

**Goals:**

- 火山豆包成为第 4 个云服务商类型，走三步 recipe，**不动**引擎适配器与成句管线的既有行为。
- 词级时间戳直喂现有 `wordCuesFromResult`（含标点回贴），字幕质量对齐 Deepgram 路径。
- 以**服务商类型声明音频上传约束**替代全局常量硬编码，为后续千问（10MB/5min）、智谱（30s）等铺路。
- 显式超时 + 有限重试 + 取消语义与既有 service 一致。

**Non-Goals:**

- 火山「标准版 / 闲时版」（submit/query 轮询、闲时仅 URL）——极速版已覆盖字幕场景。
- 说话人分离、双声道分轨、热词——API 支持但本期不透出（留 roadmap）。
- 阿里千问 / 腾讯 / 智谱等其他国内厂商（后续独立变更，复用本次的 `audioLimits` 机制）。
- 真实计费/额度查询。

## Decisions

### D1 — 品牌型硬单例类型 `volcengine`，仅支持新版控制台单 API Key，不引入 SDK

**决定**：`ASR_PROVIDER_TYPES` 新增品牌型（`multiInstance` 留空）类型 `volcengine`，字段：`apiKey`（新版「豆包语音」控制台「API Key 管理」签发的 API Key，**必填**，password 型，标准字段名与 elevenlabs/deepgram 对齐）、`models`（默认 `bigmodel`，必填）、`apiUrl`（可选，默认 `https://openspeech.bytedance.com`）、`requestTimeoutSec`/`concurrency`/`requestInterval`（与既有类型同语义）。鉴权 header 固定单 `X-Api-Key` 形态，构造逻辑进 `volcengineUtils.buildVolcHeaders` 纯函数。HTTP 用全局 `fetch` 直连。

**理由**：用户决策**只支持最新的 API Key 方式**——旧版控制台「App ID + Access Token」两件套不再兼容，换来三重简化：字段用标准 `apiKey`（`testConnection` 通用守卫、`isAsrProviderConfigured` 判定与其他品牌型完全同构）、header 构造无分支、表单只剩一个凭据输入。语音大模型接口是简单 header 鉴权，无需 `@volcengine/openapi` 的 AK/SK 签名（那是给 OpenAPI 网关的）。`models` 保留字段（当前仅 `bigmodel`）以维持「引擎 ▸ 实例 ▸ 模型」三维选择的一致性。tips 需明示两个坑：火山方舟 / 大模型推理的 API Key 与豆包语音不通用（报 `401 Invalid X-Api-Key`）；需先在「开通管理」开通极速版资源。**备选（弃）**：`accessKey` 必填 + `appKey` 可选兼容两代凭据——初版方案，多一个字段与 header 分支，实际用户均为新版控制台，按用户决策裁剪。

### D2 — base64 直传 + 以 `X-Api-Status-Code` 判成败

**决定**：`audio.data` 携带 base64（不提供 URL 模式），`user.uid` 传固定应用标识。成功判定 = HTTP 2xx **且** `X-Api-Status-Code === '20000000'`。状态码分类处理：

- `20000003`（静音音频）→ 视为**空结果成功**（返回空 text/words/segments），避免长视频切片中某个静音片让整任务失败；
- `45000001` / `45000002` / `45000151`（参数/空音频/格式错）→ 不可重试，携 `X-Api-Message` 报错；
- `55000031`（过载）/ `550xxxxx`（服务内部错）/ HTTP 429/5xx / 网络错误 / 超时 → 指数退避有限重试（结构对齐 `deepgram.ts` 的 `postListenOnce` + 重试环）；
- HTTP 401/403 或鉴权类状态码 → 不重试直接报错（透出服务端原因）。

状态码→成败/可重试的判定抽为 `volcengineUtils.ts` 纯函数（`classifyVolcStatus`），以官方错误码表 + spike 实测样本固化单测。

**理由**：base64 直传符合「音频不出本机存储、不依赖用户对象存储」的红线；火山以自有状态码体系表意（HTTP 可能恒 200），必须读 header 判定，这与既有「HTTP 状态判定」的三家不同，是本类型实现的主要差异点。静音片按空结果处理与本地引擎「无人声→空字幕」的语义一致。

### D3 — 词级优先：utterances[].words 拍平 + 标点回贴复用；utterances 兼作段级兜底

**决定**：请求固定 `show_utterances: true`、`enable_punc: true`、`enable_itn: true`、`enable_ddc: false`。解析时：

- `utterances[].words[]`（毫秒）拍平 → `AsrWord{word, start, end}`（÷1000 秒）→ `hasWordTimestamps: true`，引擎走既有词级路径：`wordCuesFromResult` 内的 `realignPunctuation(words, result.text)` 把整段标点回贴到逐字 words（该函数为 whisper-1 中文无标点场景而建，火山逐字无标点**完全同构**，零改动复用）；
- `utterances[]` 同时映射为 `AsrSegment[]`（秒）填入 `result.segments`——万一某响应缺 words，引擎自动降级段级（火山自身分句质量高，兜底可用）；
- `result.text` 取整段文本供标点回贴与日志。

**理由**：词级 + 回贴后的成句由本地管线控制（`groupTokenCues` 等阈值统一），与其他云服务商行为一致；直接采用火山 utterance 分句会绕过本地成句参数，造成不同服务商字幕风格不一致。`enable_ddc`（语义顺滑，删语气词）默认关——字幕场景保真优先。**备选（弃）**：直接用 utterances 当最终字幕——省一步但破坏「成句规则统一由本地管线负责」的既有决策（add-cloud-asr-providers D5）。

### D4 — `AsrProviderType.audioLimits` 声明上传约束，引擎读取、回落全局

**决定**：`AsrProviderType` 增加可选 `audioLimits?: { maxUploadBytes?: number; maxChunkSeconds?: number }`。`cloudAsrEngine.transcribeCloud` 在拿到 provider 类型后解析出生效值（声明值 ?? 全局常量），传给 `prepareCloudAudio({ maxBytes })` 与切片路径的 `chunkSeconds`（`splitBySilence` 已参数化，`audioProcessor.ts` 零改动）。解析函数 `resolveAudioLimits(type?)` 为纯函数进 `test:engines`。

`volcengine` 声明 `maxUploadBytes: 16MB`（官方音频上限 100MB，但 base64 进 JSON 体膨胀 ×4/3、且需整体驻留内存，保守取 16MB——base64 后 ≈21.3MB；spike 校准后可上调）与 `maxChunkSeconds: 480`（切片是**未压缩 WAV 直传**，16kHz 单声道 ≈1.92MB/min，480s ≈15.4MB 稳落 16MB 内；全局默认 600s ≈18.4MB 会超）。

**理由**：放在类型定义上（而非 transcribe 模块导出）保持「数据驱动」一致性——UI 未来也可读它做用量提示；既有三类型不声明、行为零变化，是纯增量。**备选（弃）**：每个 service 模块导出常量——分散、UI 不可达；把限制塞进 provider 实例字段——用户可改坏、且属类型固有属性而非用户配置。

### D5 — 语言参数忽略（自动多语识别）

**决定**：`bigmodel` 无显式语言入参（自动识别中英及方言），`transcribe` 忽略 `input.language`。`formData.sourceLanguage` 对其余流程（翻译等）不受影响。

### D6 — testConnection：最小探测 + 鉴权语义判定

**决定**：探测 = POST `recognize/flash`，带完整鉴权 header、`request.model_name` 取实例首个模型、`audio.data` 传 **1 秒静音 WAV**（16k/16bit 单声道 ≈31KB，`buildSilentWavBase64` 生成）：有效凭据 → `20000000` 或 `20000003`（静音空结果）判 `ok: true`；无效凭据 → HTTP 401/403（`Invalid X-Api-Key` 等），回传 `detail`（取 `X-Api-Message`）。缺 `apiKey` 时走通用守卫直接 `needsConfig: true`。

> 实测修正（2026-07 用户实测）：最初方案为「空 `audio.data` 探测、参数类错误（45xxxxxx）判鉴权已过」，但服务端**参数校验先于鉴权**——空音频用任意假 key 也返回参数错误，探测恒「通过」，形成假阳性。故按预案回退为「1 秒静音 WAV 最小真实探测」；静音音频计费成本可忽略。

### D7 — 模型清单录入结构化（用户反馈追加，覆盖全部云类型）

**决定**：`models` 字段按类型定义分三种录入形态（数据仍存规范逗号串，仅交互结构化）：

- **固定单模型**（字段 `options` 恰一项，火山 `['bigmodel']`）→ UI 只读展示，不可编辑；
- **枚举多模型**（`options` 多项：ElevenLabs `['scribe_v2','scribe_v1']`（v1 已废弃默认 v2）、Deepgram `['nova-2','nova-3']`）→ 勾选式标签，点选启停，不做自由文本；历史存量中不在 options 的 id 仍展示、可取消勾选清理；
- **自由清单**（无 `options`，OpenAI 兼容）→ 标签式录入：输入 id 回车/任一分隔符即成标签、退格删末项——用户不再手拼逗号串。

同时 `parseAsrModels` 分隔符放宽为「半/全角逗号、顿号、分号、换行」，兼容历史手输数据（半角/全角标点混用不再破坏解析）。

**理由**：用户反馈——固定模型不该可改（误改必坏）；多模型也不该逗号手拼（半/全角标点不可控）。数据层不动（存串、`parseAsrModels` 单点解析），三形态由字段 `options` 数据驱动，后续新类型零 UI 代码。**备选（弃）**：全局改存数组——动 store 结构与既有实例迁移，收益不成比例。

## Risks / Trade-offs

- **base64 体积上限官方未明示** → D4 保守 16MB + spike 实测校准；超限自动落入压缩/切片路径，最坏是多切几片而非失败。
- **`X-Api-Status-Code` 枚举不全**（文档散、错误码语义靠实测）→ utils 纯函数 + spike 样本单测；未知状态码按不可重试失败处理并透出 `X-Api-Message`，不静默挂起。
- **逐字 words 无标点** → 复用 `realignPunctuation`（已被 whisper-1 中文路径验证）；极端回贴失败退化为无标点 cue，可接受（与既有决策一致）。
- **QPS/并发额度随控制台档位波动** → `concurrency`/`requestInterval` 字段用户可调，默认温和（4 并发）；429/繁忙码走退避重试。
- **base64 使内存峰值 ≈ 音频体积 ×2.3**（Buffer + base64 字符串）→ 16MB 上限下峰值 <40MB，可接受；不做流式编码（复杂度不值）。
- **testConnection 空体探测行为**（已实测关闭）→ 2026-07 用户实测证实参数校验先于鉴权、空体探测形成假阳性，已回退为「带 1 秒静音 wav 的最小真实探测」（体积 <32KB，见 D6）。

## Migration Plan

- 纯新增：`audioLimits` 为可选字段（既有类型不声明、解析回落全局常量，行为逐字节不变）；`volcengine` 类型仅在用户主动配置后参与转写。
- 不写 store 默认值（延续 electron-store 防回灌经验）；已存实例零迁移。
- 回滚：从 `ASR_PROVIDER_TYPES` / `ASR_TRANSCRIBER_MAP` / `testConnection` 移除 volcengine 条目即可，`audioLimits` 机制可独立保留。

## Open Questions

- 极速版 base64 请求体的实际上限与超大音频的服务端行为（spike 实测后固化常量）。
- 免费额度/定价文案（成本预估提示的措辞）——落地时以控制台当期口径为准。
- 说话人分离（`enable_speaker_info`）后续是否透出到字幕/校对（roadmap，不阻塞本变更）。
