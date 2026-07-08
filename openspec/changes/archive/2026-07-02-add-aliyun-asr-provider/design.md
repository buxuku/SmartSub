## Context

云端听写现有架构（`add-cloud-asr-providers` → `cloud-asr-provider-grouping` → volcengine → tencent 已落地）：单一云引擎 `'cloud'` → 按实例 `type` 经 `ASR_TRANSCRIBER_MAP` 分发到 `main/service/asr/*`；服务商类型由 `ASR_PROVIDER_TYPES` 数据驱动（字段表单、面板分区、models 三形态录入、testConnection 探测）；`audioLimits` 声明上传约束（`resolveAudioLimits` 回落全局 24MB/600s）；音频准备为「≤上限整段上传 → 超限压缩 32kbps mp3 → 仍超限按静音切片（16kHz 单声道 WAV）」；词级成句复用 `wordCuesFromResult`（含 `realignPunctuation` 标点回贴）。

阿里云 NLS「录音文件识别极速版」API 形态（2026-07 官方文档核实）：

- **识别接口**：`POST https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/FlashRecognizer?{query}`，**同步**一次返回全部结果（30 分钟音频约 10 秒）；音频 **≤100MB / ≤2 小时**；请求体 = 音频原始二进制（`Content-Type: application/octet-stream`）；格式 `format` 支持 wav/mp3/mp4/aac/opus；`sample_rate` 16000/8000（服务端对不符音频**自动重采样**）；
- **识别参数**：`appkey`（必填，NLS 项目）、`token`（必填，临时令牌）、`format`（必填）、`sample_rate`、`enable_word_level_result`（词级信息）、`enable_inverse_text_normalization`（ITN）、`first_channel_only`、`speech_noise_threshold`、`vocabulary_id` 热词、`customization_id` 自学习模型、`sentence_max_length` 服务端断句；
- **响应 JSON**：`status`（`20000000` 成功）、`message`、`task_id`、`flash_result: { duration(ms), sentences[]: { text, begin_time(ms), end_time(ms), channel_id, words[]: { text, begin_time, end_time, punc } } }`——注意官方样例中 `words[].begin_time/end_time` 为**字符串**（`"1010"`），`sentences[]` 的为数字，解析需 `Number()` 宽容；`punc` 为词尾标点独立字段（无标点为空串）；
- **错误码**（部分）：`40000001` Token 过期/非法、`403` Token 无效、`40000003` 参数错误、`40000005` 并发超限、`40000009` WAV 头非法、`40000010` 试用过期/未开通商用/欠费、`40010001` URL 路径非法、`40020105` Appkey 不存在、`40020106` Appkey 与账号 UID 不匹配、`40000004` 任务空闲超时（官方明示可重试 ≤2 次）、`40270001` 不支持的音频格式、`40270002` 无有效语音（NO_VALID_AUDIO_ERROR）、`40270003` 音频解码错误、`50000000/50000001/52010001` 服务端偶发（官方明示重试即恢复）；
- **鉴权两段式**：识别接口本身只认 `appkey + token`（URL 参数，无签名头）。Token 经 **CreateToken**（POP/RPC 风格，`GET/POST http(s)://nls-meta.cn-shanghai.aliyuncs.com/`）获取：参数 `AccessKeyId`、`Action=CreateToken`、`Version=2019-02-28`、`Format=JSON`、`RegionId=cn-shanghai`、`Timestamp`（ISO8601 UTC）、`SignatureMethod=HMAC-SHA1`、`SignatureVersion=1.0`、`SignatureNonce`（UUID，不可重复）、`Signature`。签名：参数按 key 字典序排序 → 每个 k、v 各自 **RFC3986 percentEncode**（空格→`%20`、不转 `-_.~`）→ `k=v&` 拼接 → 原文 `GET&%2F&percentEncode(排序串)` → HMAC-SHA1（key = `AccessKeySecret + "&"`）→ base64 → 再 percentEncode 进 URL。响应 `Token.Id` + `Token.ExpireTime`（**秒级时间戳**，非时长；Token 可跨请求复用，重新获取不影响已发 Token）；
- **识别语种绑定控制台项目**：语种/方言模型无法在请求里指定，需在 NLS 控制台对 appkey 对应项目做「项目功能配置」选模型（普通话/英语/日语/粤语/多方言…约 50 种语种与方言）。一个 appkey 一种语种配置；
- **计费**：极速版**仅商用版，不支持试用**（开通商用后按时长计费，无每月免费额度）；未开通/欠费报 `40000010`。

约束：Non-Goal 红线——仅公网 URL 的服务商不做（本接口本地直传，满足）；守卫 `check:i18n`、`test:engines`；三步扩展 recipe；models 三形态录入约定（固定单值 → 只读展示）。

## Goals / Non-Goals

**Goals:**

- 阿里云 NLS 极速版成为第 6 个云服务商类型（阿里系首家），走三步 recipe，**不动**引擎适配器与成句管线既有行为。
- CreateToken 的 POP 签名以纯函数自包含实现（node:crypto，零 SDK），可单测；Token 模块级缓存复用（ExpireTime 驱动）、失效自动刷新重试一次。
- 词级时间戳直喂现有 `wordCuesFromResult`；`punc` 独立字段直接拼接进词文本，标点路径比腾讯更简单可靠。
- 品牌型硬单例（同豆包/腾讯），UI 零代码；语种切换由用户在 NLS 控制台改项目配置承担。
- 计费红线文案：极速版无免费额度，开通即商用计费——在 tips 与 README 显著提示。

**Non-Goals:**

- 阿里百炼（Model Studio）系列模型——OpenAI 兼容形态无时间戳、异步模型仅公网 URL，已评估排除（见 proposal）。
- NLS「录音文件识别（标准版/闲时版）」——仅公网 URL 提交，踩红线。
- 热词（`vocabulary_id`）、自学习模型（`customization_id`）、说话人相关能力——本期不透出（roadmap）。
- `sentence_max_length` 服务端断句——成句统一由本地管线负责（沿用 add-cloud-asr-providers D5 决策）。
- 8k 电话模型、内网 ECS 端点、上海之外的网关地域（北京/深圳端点存在，但差异仅网络延迟，首版固定上海、不开放选择）。

## Decisions

### D1 — 品牌型硬单例：语种随控制台项目配置（用户反馈定案）

**决定**：`ASR_PROVIDER_TYPES` 新增类型 `aliyun`，**硬单例**（不设 `multiInstance`，同豆包/腾讯）。字段：`accessKeyId`（password，必填）、`accessKeySecret`（password，必填）、`appkey`（text，必填，NLS 控制台项目 Appkey）、`models`（固定单值 `flash`，只读展示）、`requestTimeoutSec`/`concurrency`/`requestInterval`（同既有语义）。不设 `apiUrl` 字段——识别端点与 CreateToken 端点均为模块内常量。图标复用 `/images/providers/alibabacloud.svg`。

**理由**：NLS 的识别语种绑定控制台项目（appkey），请求参数无语言维度。初稿曾为多语种场景开放多实例（一实例一项目），实施评审时用户裁定**不需要**：默认普通话模型本身可识别中英混合（覆盖绝大多数使用场景），偶发换语种在控制台改该项目的模型配置即可，为此开「添加实例」入口反而添乱（多数用户只会配一个，入口引发「要不要多配」的困惑）。硬单例与豆包/腾讯形态一致，面板更整齐。**备选（弃）**：`multiInstance: true` 按语种建多实例——为低频场景增加常驻 UI 复杂度；UI 语种下拉映射多 appkey——为单一厂商发明新字段形态，违背数据驱动 recipe。

**注意**：语种错配（项目配了英文模型、却转中文视频）服务端不报错、只出乱码文本——客户端无从校验 appkey 的项目配置（无查询 API）。缓解：appkey tips 与 README 明确「识别语种在 NLS 控制台项目里配置、任务原语言对阿里云不生效、默认普通话模型可识别中英混合、其它语种去控制台改项目模型」。

### D2 — CreateToken POP 签名纯函数 + Token 模块级缓存（ExpireTime 驱动 + 失效强刷重试）

**决定**：`aliyunUtils.ts` 纯函数：

- `percentEncodeRfc3986(s)`：`encodeURIComponent` 后补转 `!'()*` → `%21%27%28%29%2A`（RFC3986 口径，空格已是 `%20`）；
- `buildCreateTokenQuery(accessKeyId, nonce, timestampIso)`：9 个公共参数字典序排序、逐 k/v percentEncode 拼接；
- `signCreateToken(accessKeySecret, sortedQuery)`：`GET&%2F&` + percentEncode(sortedQuery) → HMAC-SHA1（key=Secret+`&`）→ base64（进 URL 前再 percentEncode）；
- `isTokenExpired(expireTimeSec, nowMs, marginSec=300)`：ExpireTime 提前 5 分钟视为过期（服务端为绝对秒级时间戳）。

`aliyun.ts` 内模块级缓存 `Map<accessKeyId, { token, expireTime }>`（按 AccessKeyId 键控——CreateToken 与 appkey 无关，Token 全账号通用）：转写/探测先查缓存，过期或缺失才调 CreateToken（HTTPS GET）；识别请求若返回 `40000001`/HTTP 403（Token 失效类），**清缓存强刷 Token 后原地重试一次**（不计入指数退避次数）。每次 CreateToken 用新 `crypto.randomUUID()` 作 nonce。

**理由**：两段式是 NLS 的固有形态，无法绕开。Token 缓存必要：每视频可能多切片并发请求，逐请求 CreateToken 既慢又易撞 POP 接口限流；官方 FAQ 明示 Token 可复用、重取不影响已发 Token，缓存安全。按 AccessKeyId 键控而非实例 id：Token 与 appkey 无关、全账号通用，一枚即够。提前 5 分钟过期余量吸收时钟偏差与长上传耗时。强刷重试一次兜底「缓存 Token 恰在请求途中过期」的窗口。**备选（弃）**：不缓存逐请求取 Token——多切片场景 CreateToken QPS 压力与延迟叠加；持久化到 store——Token 短命（数小时~24h），进程内缓存足够，落盘徒增泄露面。

### D3 — 识别请求：原始二进制直传，固定参数集，`models` 固定 `flash`

**决定**：识别 URL 参数固定为：`appkey`、`token`、`format`（`voice format` 按文件扩展名 wav/mp3，复用腾讯 `voiceFormatFromPath` 同型纯函数）、`sample_rate=16000`、`enable_word_level_result=true`、`enable_inverse_text_normalization=false`、`first_channel_only=true`。请求体 = 音频 Buffer（`Content-Type: application/octet-stream`）。`models` 字段固定单值 `['flash']` 只读展示（同 volcengine `bigmodel` 形态）——该接口无模型参数，模型语义已被 appkey 项目配置吸收。

**理由**：参数全为 URL 安全值，无编码歧义（token 为十六进制串、appkey 为字母数字）。`sample_rate=16000` 匹配我们的音频准备产物（16kHz WAV / 32kbps mp3），服务端对 mp3 自动重采样兜底。ITN 关闭对齐其他服务商（数字形态交本地/翻译层）。`first_channel_only=true` 恒单声道，显式声明避免多声道叠加计费。**备选（弃）**：透出 `sentence_max_length`（服务端字幕断句）——破坏跨服务商字幕风格一致性（同 tencent D4 取舍）。

### D4 — 结果解析：词条目 `trim(text) + trim(punc)` 拼接，句级兜底；时间戳字符串宽容

**决定**：`extractAliyunResult(json)` 纯函数：

- 取 `flash_result.sentences[]`（`first_channel_only=true` 恒单通道，不按 channel_id 过滤但保留全部句子）；
- 词级：`sentences[].words[]` 拍平 → `AsrWord{ word: text.trim() + punc.trim(), start, end }`（`Number()` 宽容字符串毫秒 → ÷1000 秒）→ `hasWordTimestamps: true`；**`punc` 并入词文本**，词序列天然带标点；**text/punc 必须先 trim**——实测英文词 `text` 自带尾空格（`"welcome "`）、英文 `punc` 亦带尾空格（`". "`），不 trim 会与 `wordsToNativeTokens` 的拉丁词补前置空格逻辑叠出双空格（中文 `punc` 如 `"。"` 无空格，trim 幂等无害）；
- 句级：`sentences[]` → `AsrSegment[]`（秒）填 `segments` 兜底（句文本同样 trim）；
- `text` = 各句 `text`（trim 后）拼接（CJK 直拼、拉丁句间补空格，复用 `needsSpaceBefore` 判定）。

引擎词级路径中 `realignPunctuation(words, text)` 对已带标点的词序列是**无害幂等**（gap 定位不会重复贴），无需为阿里加分支。

**理由**：`punc` 独立字段是 NLS 相对腾讯（词无标点靠整段回贴）的优势——拼接即得带标点词序列，回贴精度问题（proposal「定位失败跳过」的 best-effort）在此路径根本不出现。时间戳字符串/数字混用是官方样例与实测实况（words 为字符串毫秒如 `"880"`、sentences 为数字），`Number()` 统一宽容。**备选（弃）**：忽略 `punc` 走 `realignPunctuation` 整段回贴——放着更优的结构化数据不用，无谓退化；保留服务端原始空格形态——英文双空格污染字幕文本。

### D5 — `audioLimits: { maxUploadBytes: 24MB }`——与腾讯同理以字节钳住 2 小时时长上限

**决定**：声明 `maxUploadBytes: 24 * 1024 * 1024`，不声明 `maxChunkSeconds`（回落全局 600s）。

**理由**：与 tencent D5 完全同构：官方双上限「100MB 且 2 小时」而引擎只按字节判定；32kbps mp3 ≈0.24MB/min，24MB≈100min<2h（17% 余量）；600s WAV 切片 ≈18.4MB 达标。显式声明记录意图、与腾讯常量注释互引。**备选（弃）**：按 100MB 声明——mp3 可装 ≈7h 超时长上限被拒。

### D6 — testConnection：两段探测——CreateToken 验 AccessKey，静音 WAV 验 appkey 与开通状态

**决定**：探测流程：

1. 三字段守卫（accessKeyId/accessKeySecret/appkey 任缺 → `needsConfig: true`，不走通用 apiKey 守卫）；
2. CreateToken（走缓存；失败则明确「AccessKey 无效/签名错误」类 detail，透出 `Code/Message`——如 `InvalidAccessKeyId.NotFound`）；
3. 1 秒静音 WAV 原始字节 POST FlashRecognizer：`20000000` → ok（静音空文本正常）；`40270002`（无有效语音）→ **同样判 ok**（静音触发属预期，链路已通）；`40020105/40020106` → appkey 不存在/与账号不匹配的可行动提示；`40000010` → 未开通商用版/欠费提示（附「极速版无试用，需开通商用」说明）；`403/40000001` → Token 异常（强刷一次后仍失败才报）；其余非 `20000000` → 透出 `status + message`。

**理由**：两段式鉴权意味着两类可区分的配置错误（账号密钥 vs 项目 appkey），分段探测把「哪一步错了」直接告诉用户。`40270002` 判通过沿用豆包/腾讯静音探测经验——静音样本被拒识是业务正常，链路/凭据/开通状态均已验证。`40000010` 单列因极速版无试用，新用户最易撞——文案给「去控制台开通商用版」的可行动指引。

### D7 — 状态分类 `classifyAliyunStatus`：与腾讯 classifier 同构

**决定**：纯函数 `classifyAliyunStatus(httpStatus, status)` 四分类：

- **success**：`20000000`；
- **auth**：`40000001`、HTTP/status `403`（Token 类，触发强刷重试一次后仍失败则终态）；
- **retriable**：`40000004`（空闲超时，官方明示重试 ≤2）、`40000005`（并发超限）、`50000000`/`50000001`/`52010001`（服务端偶发）、HTTP 429/5xx、网络错误、超时；
- **fatal**：`40000003`（参数）、`40000009`（WAV 头）、`40000010`（未开通/欠费）、`40010001`（路径）、`40020105`/`40020106`（appkey）、`40270001`/`40270003`（格式/解码）、未知码——携 `status + message` 报错不重试。
- `40270002`（无有效语音）单列为 **empty-success**：任务侧视为空结果成功（真实视频出现说明该段无语音，与豆包空文本语义一致），探测侧视为通过。

**理由**：分类口径对齐既有 volcengine/tencent classifier，重试语义（指数退避有限次）与取消（AbortSignal）复用 service 骨架；auth 类独立出来是为了接 D2 的 Token 强刷路径而非直接终态。

## Risks / Trade-offs

- **POP 签名实现错误难自查**（percentEncode 边界：`*` `~` `+` 空格）→ 纯函数 + 单测固化（含官方文档参数组合的独立预计算签名向量断言）；detail 透出服务端 `Code/Message`（阿里返回体带 `Recommend` 排错链接，一并记日志）。
- **语种错配静默出乱码**（appkey 项目配置客户端不可见，见 D1 注意）→ 文案 + 实例命名缓解；README 给「一个语种一个项目/实例」的组织建议；无法根治（NLS 无项目配置查询 API）。
- **`words[]` 时间戳字符串形态**（官方样例 `"1010"`）→ `Number()` 宽容解析 + 单测覆盖字符串/数字两形态；若实测出现其他形态随手测校准。
- **Token 缓存与切片并发**：多切片并发首次同时 miss 缓存会并发调 CreateToken 数次 → 可接受（官方明示重取不影响已发 Token，仅浪费 1-2 次调用）；不为此加互斥锁（复杂度不值）。
- **极速版无免费额度**，用户误开通产生费用 → tips/README 显著提示「仅商用版、开通即计费」，探测文案对 `40000010` 给明确开通指引而非诱导。
- **地域固定上海网关**：境外用户延迟略高 → 首版接受（北京/深圳端点差异仅延迟，待有反馈再开地域选项）。
- **status 枚举可能不全**（文档为主要依据）→ 未知码按 fatal 透出 `status + message`，`classifyAliyunStatus` 纯函数便于随实测补充。

## Migration Plan

- 纯新增：`aliyun` 类型仅在用户主动配置后参与转写；未配置时五家既有类型与本地引擎行为零变化。
- 不写 store 默认值；已存实例零迁移。
- 回滚：从 `ASR_PROVIDER_TYPES` / `ASR_TRANSCRIBER_MAP` / `testConnection` 移除 aliyun 条目即可（Token 缓存为进程内、无残留）。

## Spike 实测记录（2026-07-02，用户 AccessKey；商用版开通 + 真实 appkey 后全链路已通）

- ✅ **CreateToken 链路通**：本设计的 POP 签名实现（percentEncode + 字典序 + `GET&%2F&` + HMAC-SHA1(Secret+`&`)）HTTP 200 返回 Token（32 位 hex）；**ExpireTime 实测 ≈36 小时**（非固定 24h，缓存按 ExpireTime 驱动的决策正确）。
- ✅ **`40000010` 第一手形态**：`Gateway:FREE_TRIAL_EXPIRED:The free trial has expired!`（HTTP 400）——且**假 appkey 也返回此错**，证实网关先查「极速版商用开通状态」后校验 appkey；testConnection 对 40000010 的文案应为「需开通录音文件识别极速版商用版（无免费试用）」，且此错误出现时**无法据此判断 appkey 正误**。
- ✅ **无项目管理 OpenAPI**：`ListProjects` / `CreateProject` 于 nls-meta POP 均 404 `InvalidAction.NotFound`——appkey 仅能控制台创建、客户端无法校验/枚举 appkey（语种配置只能靠文案引导）。
- ✅ **商用版开通后（同日）复测**：假 appkey 返回 `40020105 Meta:APPKEY_NOT_EXIST:Appkey not exist!`（HTTP 400）——证实 40000010 与 40020105 的先后关系（先计费门槛后 appkey 校验），D6 探测文案两级定型：40000010→「开通商用版」、40020105/40020106→「检查 Appkey」。
- ✅ **中文样本全链路通**（官方 nls-sample-16k.wav，104KB）：HTTP 200 `status: 20000000`，3.1s 音频 `latency` 572ms；`flash_result.sentences[]` 句级 `begin_time/end_time` 为**数字**毫秒，`words[]` 词级为**字符串**毫秒（`"880"`）——与文档样例一致，`Number()` 宽容解析定案；中文词粒度为词组（`北京`/`的`/`天气`），`punc` 空串或全角标点（`。`）无空格。
- ✅ **英文样本全链路通**（say 合成 6.4s，中文项目 appkey 识别英文照样出词——项目模型可能为多语种/中英）：英文 `words[].text` **自带尾空格**（`"welcome "`），句中末词无尾空格但 `punc` 带尾空格（`". "`）——**D4 的 trim 处理为必须**；分词为自然单词粒度；句子切分较细（逗号即断句）。
- ✅ **静音 1s WAV 实测**：HTTP 400 `status: 40270002, message: "vad silent"`——落在预期二选一之内，D6「40270002 判探测通过」与 D7「empty-success」定案。

## Open Questions

- ~~静音 1s WAV 实测返回~~ ✅ 已实测 `40270002 "vad silent"`（HTTP 400），探测判通过、任务侧判空成功。
- ~~`words[].text` 英文分词粒度与空格形态~~ ✅ 已实测：自然单词粒度、text/punc 均可能带尾空格，extract 时 trim（见 D4）。
- CreateToken 是否对 RAM 子账号需要额外授权策略（文档口径：需 `AliyunNLSFullAccess` 或自定义策略）——用户主账号 AccessKey 实测直接可用；RAM 子账号口径 README 文案随手测校准。
- 免费额度/价格文案的当期口径（2026-07 文档：极速版商用 3.30→1.30 元/小时阶梯价、无试用；落地时以控制台为准）。
