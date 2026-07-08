## Context

云端听写现有架构（`add-cloud-asr-providers` → `cloud-asr-provider-grouping` → `add-volcengine-asr-provider` 已落地）：单一云引擎 `'cloud'` → 按实例 `type` 经 `ASR_TRANSCRIBER_MAP` 分发到 `main/service/asr/*`；服务商类型由 `ASR_PROVIDER_TYPES` 数据驱动（字段表单、面板分区、models 三形态录入、testConnection 探测）；`AsrProviderType.audioLimits` 声明上传约束、引擎经 `resolveAudioLimits` 取值回落全局常量（24MB/600s）；音频准备为「≤上限整段上传 → 超限压缩 32kbps mp3 → 仍超限按静音切片（16kHz 单声道 WAV）」；词级成句复用 `realignPunctuation` + `wordCuesFromResult`。

腾讯云「录音文件识别极速版」API 形态（2026-07 官方文档核实，文档更新于 2026-02）：

- `POST https://asr.cloud.tencent.com/asr/flash/v1/{appid}?{请求参数}`，**同步**一次请求返回全部结果（30 分钟音频约 10 秒）；音频上限 **≤2 小时 / ≤100MB**；
- 请求体 = **音频原始二进制**（`Content-Type: application/octet-stream`），格式支持 wav/pcm/mp3/m4a/aac/amr/ogg-opus 等（`voice_format` 参数声明）；
- 鉴权 = **签名 v1**：全部 URL 参数按**字典序**排序拼接 `POST` + host + path + appid + `?` + 排序后查询串为原文，HMAC-SHA1（SecretKey）后 base64，放 `Authorization` 头（裸签名值，无前缀）。参数含 UNIX 秒级 `timestamp`，与服务端相差 >3 分钟报签名失败；
- 凭据：语音识别控制台「API 密钥管理」的 **AppID + SecretID + SecretKey** 三件套；
- 必填参数：`appid`（路径）、`secretid`、`engine_type`（语言引擎：`16k_zh`/`16k_en`/`16k_zh_en`【大模型版】/`16k_multi_lang`【大模型版】/`16k_yue`/`16k_ja` 等 20+）、`voice_format`、`timestamp`；可选：`word_info`（0 无词级 / 1 词级无标点 / 2 词级含标点 / 3 字幕分段模式）、`filter_punc`、`convert_num_mode`、`first_channel_only`、`speaker_diarization`、`sentence_max_length`、热词等；
- 响应 JSON：`code`（`0` 成功，非 0 见错误码表）、`message`、`audio_duration`（毫秒）、`flash_result[]`（按声道：`text` 整段带标点 + `sentence_list[]`（`start_time`/`end_time` 毫秒、`text`、`word_list[]`（`word`/`start_time`/`end_time` 毫秒）））；
- 错误码：`4001` 参数、`4002` 鉴权失败、`4003` 未开通、`4004` 资源包耗尽、`4005` 欠费、`4006` 并发超限、`4007` 解码失败、`4011` 音频过大、`4012` 音频为空、`5001/5002/5003` 服务端偶发（官方明示可重试）；
- 免费额度每月 5 小时；普通版免费并发 20、大模型版 5。

约束：Non-Goal 红线——仅公网 URL 的服务商不做（本接口本地直传，天然满足）；守卫 `check:i18n`、`test:engines`；grouping 固化的三步扩展 recipe 与品牌型硬单例约定；D7（volcengine 变更）固化的模型三形态录入。

## Goals / Non-Goals

**Goals:**

- 腾讯极速版成为第 5 个云服务商类型，走三步 recipe，**不动**引擎适配器与成句管线既有行为。
- 签名 v1 以纯函数自包含实现（node:crypto，零 SDK），可单测、按次生成保时间戳时效。
- 词级时间戳直喂现有 `wordCuesFromResult`（含标点回贴），字幕质量对齐豆包/Deepgram 路径。
- `engine_type` 枚举即模型清单（兼语言选择语义），复用既有 models 点选 UI，大模型版选项在文案标注计费差异。
- 显式超时 + 有限重试 + 取消语义与既有 service 一致。

**Non-Goals:**

- 腾讯「录音文件识别（标准版）」（异步回调/轮询、更低价）——极速版已覆盖字幕场景时效需求。
- 说话人分离（`speaker_diarization`）、热词（`hotword_id`/`hotword_list`）、自学习模型、情绪能量值——API 支持但本期不透出（留 roadmap；热词还涉及签名 URL 编码歧义，见 D2 理由）。
- `word_info=3`（服务端字幕分段模式）与 `sentence_max_length`——成句规则统一由本地管线负责（沿用 add-cloud-asr-providers D5 决策）。
- 电话场景引擎（`8k_*`）——字幕场景用不到，不进枚举。
- 阿里百炼 fun-asr-flash 等其他厂商（另行 spike 评估）。

## Decisions

### D1 — 品牌型硬单例类型 `tencent`，三字段凭据，固定端点，不引入 SDK

**决定**：`ASR_PROVIDER_TYPES` 新增品牌型（`multiInstance` 留空）类型 `tencent`，字段：`appid`（text，必填）、`secretId`（password，必填）、`secretKey`（password，必填）、`models`（engine_type 枚举多选，见 D3）、`requestTimeoutSec`/`concurrency`/`requestInterval`（同既有语义）。**不设 `apiUrl` 字段**——端点固定 `asr.cloud.tencent.com`（模块内常量）。图标复用 `/images/providers/tencentcloud-color.svg`。HTTP 用全局 `fetch`，签名用 node:crypto。

**理由**：凭据三件套是该接口的固有形态（签名需要 appid 进路径、secretid 进参数、secretKey 签名），无从简化；字段名沿用腾讯官方术语便于对照控制台。端点不开放自定义：**签名原文绑定 host**，自定义端点必须同步改签名串，误配则恒 4002，徒增支持成本；私有化部署场景不存在。不用腾讯云 SDK：官方 SDK 面向云 API 网关（签名 v3/TC3-HMAC-SHA256），本接口是独立的简化签名 v1，十余行可实现且可单测。**备选（弃）**：`apiUrl` 可选字段对齐其他类型——签名与 Host 强耦合，弊大于利。

**注意**：腾讯无 `apiKey` 字段，`testConnection` 的通用「缺 apiKey → needsConfig」守卫不适用，其分支需按自身三字段判定（或直接走 `isAsrProviderConfigured` 的 required 字段口径）。

### D2 — 原始二进制直传 + 签名 v1 纯函数按次生成

**决定**：音频文件读为 Buffer 直接作请求体（`Content-Type: application/octet-stream`），`voice_format` 按实际文件扩展名传（引擎准备产物仅两种：`wav` 或压缩后 `mp3`）。签名相关抽 `tencentUtils.ts` 纯函数：

- `buildTencentQuery(params)`：参数按 key 字典序排序、`k=v&` 拼接——**参数集固定为 URL 安全值**（`secretid`/`engine_type`/`voice_format`/`timestamp`/`word_info`/`filter_punc`/`convert_num_mode`/`first_channel_only`/`speaker_diarization`，值均为字母数字与 `_`/`-`），排序串与最终 URL 完全一致，**不存在 URL 编码歧义**；
- `signTencentRequest(secretKey, appid, sortedQuery)`：拼 `POST` + `asr.cloud.tencent.com/asr/flash/v1/` + appid + `?` + sortedQuery → HMAC-SHA1 → base64；
- 每次请求（含每次重试）**重新取 `timestamp` 并重签**——服务端校验 ±3 分钟时效，重试若沿用旧签名，长退避后会假失败。

固定参数：`word_info=1`（见 D4）、`filter_punc=0`、`convert_num_mode=1`、`first_channel_only=1`（我们的音频恒单声道，显式声明避免多声道计费歧义）、`speaker_diarization=0`。

**理由**：原始二进制直传是该 API 相对豆包 base64-JSON 的显著优势（无 ×4/3 膨胀、无 JSON 序列化大字符串峰值），实现也更简（`fetch` body 直接给 Buffer）。签名参数集刻意排除热词等含 `|`/`,`/中文的参数——腾讯签名 v1 的已知坑是「签名原文用未编码串、发送用编码串」在特殊字符上易错位，纯字母数字参数集从根上规避（也是热词进 Non-Goals 的原因之一）。**备选（弃）**：签名逻辑放 transcriber 内联——不可单测；官方 SDK——依赖重且目标接口不同。

### D3 — `models` = 计费档位（standard/large），engine_type 由「档位 + 任务原语言」映射（实施中修订）

**决定**（修订版，实施后按用户反馈调整）：`models` 字段为两档枚举（`type: 'select'` + `options: ['standard', 'large']`，默认 `standard`）——**只让用户选计费档位，识别语言跟随任务原语言**。转写时经纯函数 `resolveTencentEngineType(model, language)` 映射 engine_type：

- standard 普通版：单语种引擎 1:1 映射（zh→`16k_zh`、en→`16k_en`、ja→`16k_ja`、yue→`16k_yue`、`zh-Hant` 按普通话…），免费并发 20；
- large 大模型版：中/英/粤/繁体→`16k_zh_en`（中英粤+方言大模型），其余语种→`16k_multi_lang`（15 语种，**不含中文**），免费并发仅 5；
- `auto`（自动识别）：standard→`16k_zh-PY`（中英粤三语混合、普通版计费）、large→`16k_zh_en`——腾讯无全语种自动引擎，auto 按中英粤混合处理，其它语种需在任务里明确选原语言（tips 说明）；
- 原语言不在支持清单（如 ru/it）→ 映射返回 null，**上传前**明确报错（继续上传只会产出乱码还照常计费）；
- 兼容透传：model 为原始 engine*type（`16k*_`/`8k\__`，历史存量或高级用法）→ 原样使用、忽略语言。

**理由**：初版方案（20 个 engine_type 枚举点选、忽略原语言）让用户在「原语言」与「模型」里把同一语言维度选两遍——选得不一致（如原语言英语 + 模型 16k_zh）会产出乱码字幕还照常计费。用户反馈明确倾向档位化：「模型只列普通版和大模型版，根据原语言映射，auto 对应 16k_multi_lang 或 16k_zh_en」。档位化后语言维度回归任务原语言（与其他服务商行为一致），计费档位仍显式可控（大模型版不会被静默选中）；auto 最终取 `16k_zh-PY`/`16k_zh_en` 而非 16k_multi_lang，因 multi_lang **不识别中文**，与本产品中文为主的用户场景不符。**备选（弃）**：engine_type 全枚举（初版）——冗余双选、误配风险；完全隐藏模型选择——大模型版计费差异被静默。

**注意**：testConnection 的探测 engine_type 也走该映射（首个已启用档位按 zh 映射：standard→16k_zh、large→16k_zh_en，large 档探测顺带验证大模型版可用性）。

### D4 — 词级优先：`word_info=1` + 标点回贴复用；sentence_list 兼作段级兜底

**决定**：请求固定 `word_info=1`（词级时间戳、词**无标点**）。解析（`extractTencentResult` 纯函数）：

- 仅取 `flash_result[0]`（`first_channel_only=1` 恒单声道）；
- `sentence_list[].word_list[]`（毫秒）拍平 → `AsrWord{word, start, end}`（÷1000 秒）→ `hasWordTimestamps: true`，引擎走既有词级路径：`realignPunctuation(words, text)` 从整段带标点文本回贴标点——与豆包「逐字无标点 + 整段带标点」**完全同构**，零改动复用；
- `sentence_list[]` 同时映射为 `AsrSegment[]`（秒）填 `result.segments`——缺 word_list 时引擎自动降级段级；
- `text` 取 `flash_result[0].text`（整段带标点）。

**理由**：`word_info=2`（词含标点）形态官方未给样例（标点是并入词文本还是独立词条不明），而 `realignPunctuation` 已被 whisper-1 中文与豆包两条路径验证——选 1 走已验证路径，消除歧义；成句仍由本地管线统一（阈值/风格与其他服务商一致）。**备选（弃）**：`word_info=3` 服务端字幕分段——绕过本地成句管线，破坏跨服务商字幕风格一致性（同 add-cloud-asr-providers D5、volcengine D3 的取舍）。

### D5 — `audioLimits: { maxUploadBytes: 24MB }`——以字节上限间接钳住 2 小时时长上限

**决定**：声明 `maxUploadBytes: 24 * 1024 * 1024`，**不声明** `maxChunkSeconds`（回落全局 600s）。

**理由**：官方双上限「100MB **且** 2 小时」，而引擎的 `prepareCloudAudio` 只按**字节**判定（无时长判定）。若按 100MB 声明：32kbps mp3 压缩产物 0.24MB/分钟，100MB 可装 ≈7 小时音频——单请求会携带远超 2h 的音频被服务端拒绝。取 24MB：mp3 ≈100 分钟 < 2h（17% 余量），原始 WAV（1.92MB/分钟）≤24MB 时 ≈12.5 分钟更远低于时长上限；超 24MB 自动落入压缩→切片路径，600s WAV 切片 ≈18.4MB 双双达标。恰与全局默认等值，但**显式声明**记录「时长上限经字节间接约束」的意图，免受未来全局默认调整影响。**备选（弃）**：给引擎加时长判定/`maxDurationSeconds` 声明——为单一厂商扩机制，当前用字节钳制足够，留待第二家需要时再泛化。

### D6 — testConnection：1 秒静音 WAV 真实探测 + `code` 语义判定

**决定**：探测 = 完整签名 POST `flash/v1`，`engine_type` 取实例首个已启用档位按 zh 映射（见 D3 注意项）、`voice_format=wav`、body 为 **1 秒静音 WAV 原始字节**（复用 `buildSilentWavBase64` 产物 `Buffer.from(b64, 'base64')` 还原）：

- `code === 0` → `ok: true`（静音空文本属正常）；
- `code === 4002` → 鉴权失败，`detail` 取 `message`（SecretID/SecretKey/签名错）；
- `code === 4003` / `4004` / `4005` → 明确配置类错误透出（未开通 / 资源包耗尽 / 欠费）——这三类对用户是「去控制台操作」的可行动信息；
- 其余非 0 → 失败并透出 `code + message`；
- 凭据不全（appid/secretId/secretKey 任缺）→ `needsConfig: true`（按 D1 注意事项自行守卫，不走通用 apiKey 守卫）。

**理由**：豆包实测教训（参数校验可能先于鉴权，空体探测假阳性）直接沿用——一开始就用最小真实音频探测；1s WAV ≈31KB，计费可忽略。`4003/4004/4005` 单列是因腾讯需**先在控制台开通服务**，新用户大概率首撞 4003，明确文案省一轮排查。

## Risks / Trade-offs

- **签名实现错误恒 4002、难自查** → 纯函数 + 单测固化（含一枚独立算出的 HMAC-SHA1 向量断言）；`detail` 透出服务端 message；README 注明「时间偏差 >3 分钟也报签名失败」提示校时。
- **`word_info=1` 的词形态未见官方完整样例**（英文分词粒度/空格前缀）→ `extractTencentResult` 单测覆盖中英样本（按文档示例构造）；真实响应随用户凭据手测校准（同豆包流程）；极端情况词文本带空格不影响时间轴，只影响回贴精度，退化可接受。
- **大模型版引擎（16k_zh_en / 16k_multi_lang）免费并发仅 5**，默认 `concurrency: 4` 贴边 → 保守默认不变，tips 标注；`4006` 并发超限归入可重试退避，超限自动缓解。
- **2h 时长上限无直接判定**（D5 用 24MB 字节间接钳制，依赖 32kbps 压缩码率假设）→ 若未来压缩码率调整，此常量需联动复核；注释中互相引用提醒。
- **`code` 枚举可能不全**（文档为主要依据）→ 未知码按不可重试失败透出 `code + message`，不静默挂起；`classifyTencentCode` 纯函数便于随实测样本补充。

## Migration Plan

- 纯新增：`tencent` 类型仅在用户主动配置后参与转写；未配置时四家既有类型与本地引擎行为零变化。
- 不写 store 默认值；已存实例零迁移。
- 回滚：从 `ASR_PROVIDER_TYPES` / `ASR_TRANSCRIBER_MAP` / `testConnection` 移除 tencent 条目即可。

## Open Questions

- `word_info=1` 英文词条目的空格/分词形态（影响回贴精度，不影响可用性）——随真实凭据手测确认。
- 静音 1s WAV 的实际返回（预期 `code 0` 空文本；若实测出静音专属码则并入 `classifyTencentCode`）。
- 免费额度/价格文案的当期口径（README 与 tips 措辞，落地时以控制台为准）。
- 热词（`hotword_list` 临时热词）是否值得后续透出（需解决签名编码歧义 + UI 录入形态，roadmap）。
