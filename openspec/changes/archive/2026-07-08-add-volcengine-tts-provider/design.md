# Design: add-volcengine-tts-provider

> 上游依据：`archive/2026-07-08-tts-dubbing-phase-1-5/design.md`（品牌型云 TTS 接入范式：纯工具分文件 + 单测、裸 PCM 本地包 WAV 头、speed clamp 由 provider 内部折算）；`archive/2026-07-02-add-volcengine-asr-provider/design.md`（火山凭据裁剪：仅新版控制台单 API Key；状态码分类形制）。本文只收敛豆包 TTS 的新增决策。

## Context

- **框架就位**：`TTS_SYNTHESIZER_MAP` 分发表加一条映射即扩一家；`TtsSegmentRequest`（text/voice/speed/outWavPath/signal → 16-bit PCM wav 落盘）为统一合同；`testTtsConnection` 通用（真实合成一句），新类型零改动生效；「配音服务」页与工作台下拉经 `buildTtsViews` / `isTtsProviderConfigured` 数据驱动自动外显。
- **火山 ASR 先例可复用**：`main/service/asr/volcengine*.ts` 已固化——新版控制台单 `X-Api-Key` 鉴权（方舟/推理 Key 不通用）、`X-Api-Resource-Id` 选资源、自有状态码体系（`20000000` 成功 / `45xxxxxx` 参数与鉴权 / `550xxxxx` 服务端）、「实现 + 纯工具分文件」形制。TTS 与 ASR 同域（`openspeech.bytedance.com`）、同控制台、同 Key 体系。
- **豆包 TTS API 形态（2026-07 官方文档核实）**：现行推荐接口为 **V3 单向流式 HTTP**（`POST /api/v3/tts/unidirectional`，一次性输入全部文本、`Transfer-Encoding: chunked` 流式返回 JSON 分片，每片 `{code, message, data}`，`data` 为 base64 音频；终止片 `code=20000000`）。`X-Api-Resource-Id` 决定模型版本与计费商品：`seed-tts-2.0`（2.0 音色，`*_uranus_bigtts` 等）/ `seed-tts-1.0`、`seed-tts-1.0-concurr`（1.0 音色，`*_mars/moon_bigtts` 等）——**资源与音色版本必须匹配**，错配报 `55000000 resource ID is mismatched`。`audio_params.speech_rate ∈ [-50, 100]`（-50 = 0.5 倍速、0 = 原速、100 = 2 倍速）为原生语速。V1 非流式接口官方已标「不推荐」且不支持 2.0 音色、鉴权为旧版三件套，不在考虑之列。
- **调研输入（2026-07）**：豆包 2.0 中文自然度第一梯队；字符版约 1.3 元/千字符；新用户有免费赠额；国内直连。

## Goals / Non-Goals

**Goals:**

- 品牌型服务商 `volcengine` 接入：单 API Key + 资源版本枚举，V3 chunked 接口裸 PCM 直出，本地包 WAV 头落盘（零 ffmpeg），原生 speech_rate 速控。
- 音色预填（2.0 通用集 + 内置中文名映射兜底）与官方音色文档外链。
- 测试连接走通用路径；凭据 / 音色授权 / 并发限流 / 资源错配四类错误定向引导。
- 纯工具分文件（`volcengineTtsUtils.ts`，零网络/fs/electron）可单测，`test:dubbing` 全过；零新增 npm 依赖。

**Non-Goals:**

- 声音复刻（`seed-icl-*` 资源、`S_` 开头音色、`model_type` 参数）——属 v2 克隆能力域。
- 情感与语音指令参数化（`emotion` / `emotion_scale` / `context_texts` / cot 标签）——单段字幕配音无此诉求，不进 schema。
- 音色清单在线拉取（`voiceListMode`）——ListSpeakers 属控制台 OpenAPI，走火山主账号 AK/SK 签名体系，与豆包语音 API Key 不通；为拉音色引入第二套凭据不成比例。
- 其它服务商（阿里 CosyVoice / MiniMax / Fish Audio → 后续变更）。
- WebSocket 端点（单向/双向流式）——fetch 即可满足一次性合成，无需 ws 帧协议实现。

## Decisions

### 1. 端点选 V3 单向流式 HTTP（chunked），响应全量读取后离线解析

- **端点**：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，固定官方域（不提供 apiUrl 字段——火山无自定义网关场景，形制 ASR 侧亦默认官方域即可，减一个字段）。
- **消费方式**：整段字幕一次性合成，无流式播放诉求——`await res.text()` 读完整个 chunked 响应，再交纯函数 `parseVolcTtsStream(text)` 按行解析 JSON 分片、base64 解码拼接 PCM、提取终止 code 与 message。_备选 a_：真流式增量消费（`res.body` reader）——多状态机复杂度、无收益，弃。_备选 b_：SSE 端点（`/sse`）——同能力多一层 `event:`/`data:` 封装、解析多一步，弃。_备选 c_：V1 非流式（`/api/v1/tts`，JSON 一次返回）——官方标注不推荐、不支持 2.0 音色、鉴权为旧版 appid+token 三件套（与「仅新版 API Key」决策冲突），弃。
- **解析容错**：分片以换行分隔（官方 demo `iter_lines` 语义）；解析器逐行 `JSON.parse`、跳过空行，任一分片 `code` 非 0 且非 `20000000` 即报错（携 code + message）；无有效音频分片时报「empty audio」。分隔符形态实现期真机确认（见 Open Questions），解析器为纯函数、固定向量单测。

### 2. 凭据与鉴权：单 API Key + resourceId 枚举字段，沿 ASR 裁剪决策

- **鉴权头**：`X-Api-Key`（新版控制台 API Key）+ `X-Api-Resource-Id`（实例 `resourceId` 字段值）+ `X-Api-Request-Id`（uuid）。旧版 App ID + Access Token **不支持**——与 ASR 侧同一裁剪（tips 注明；同一 Key 可同时用于豆包听写与语音合成，已配 ASR 的用户直接复用）。
- **resourceId 为显式 select 字段**（默认 `seed-tts-2.0`；可选 `seed-tts-1.0` / `seed-tts-1.0-concurr`）：资源决定可用音色集与计费商品，属用户开通口径的一部分。_备选_：按音色 id 特征自动推导（`uranus`→2.0、`mars/moon`→1.0）——特征法对官方新音色系列（`saturn_*` 等）脆弱、静默选错资源比显式报错更难排查，弃；错配场景以 `55000000` 定向引导兜底（tips 同时写明系列对应关系）。

### 3. 音频合同：`format=pcm` 裸 PCM 拼片 + 本地包 WAV 头，零 ffmpeg

- 请求 `audio_params: { format: 'pcm', sample_rate: 24000 }`——分片 base64 解码按序 `Buffer.concat` 得 24kHz 16-bit 单声道小端裸 PCM，经既有 `writePcmAsWav` 落盘（ElevenLabs 同路径，`readWavInfo` 可读出正确时长）。_备选 a_：`mp3` → ffmpeg 转码——多一次进程开销（Edge 路径是被迫的），弃。_备选 b_：`wav`——官方文档明示流式场景会多次返回 WAV header，拼接产物损坏，弃。

### 4. 语速：speech_rate 线性折算，clamp [0.5, 2.0]

- `speedToVolcSpeechRate(speed)`：`rate = round((speed - 1) × 100)`，clamp 到 [-50, 100]（即倍速 [0.5, 2.0]，官方端点定义恰为线性两点 -50↔0.5、100↔2.0）；`speed ≈ 1` 时省略 `speech_rate` 字段（走服务端默认）。能力声明 `speedControl: 'native'`。
- 该区间**完整覆盖**对齐引擎的实用预控制区间，正常路径无 atempo 残余；极端超界仍由既有云端复测分支兜底——与 ElevenLabs（clamp [0.7, 1.2] 靠 atempo 补）相比是更完整的 native 实现。
- 与 Azure/kokoro 同一教训：不假设 speech_rate 与实际时长严格线性，第 2 层复测防线照常生效。

### 5. 错误分类：HTTP 状态 + 流内 code 双轨判定，四类定向引导

TTS 错误双通道：HTTP 层（401/403/429）与流内 JSON `code`（业务态）。纯函数 `volcTtsErrorHint(httpStatus, code, message)` 产出定向文案：

| 判定                                                 | 引导                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| HTTP 401/403                                         | 检查 API Key：需「豆包语音」控制台签发（方舟/大模型推理 Key 不通用），并确认已开通语音合成服务          |
| code `45000000` 且 message 含 `speaker`/`permission` | 音色未授权或 id 有误：检查音色 id 拼写、账号是否已开通该音色对应商品                                    |
| HTTP 429 或 message 含 `concurrency`/`quota`         | 并发限流：调低实例并发（默认 2）或稍后重试；免费赠额与字符版并发上限有限                                |
| code `55000000` 且 message 含 `mismatch`             | 资源版本与音色不匹配：2.0 音色（uranus 等）配 `seed-tts-2.0`，1.0 音色（mars/moon 等）配 `seed-tts-1.0` |
| code `40402003`                                      | 文本超长（发起前有 `maxCharsPerRequest` 守卫，属兜底）                                                  |

- **不做自动重试**：与 azure.ts / elevenlabs.ts 一致（云 TTS 单段短请求，失败行由工作台单行重跑兜底）；ASR 侧的指数退避重试面向批量长转写，语义不同不照搬。
- 超时/取消：`AbortSignal.timeout(timeoutMs)` 与 `request.signal` 合并（`AbortSignal.any`），取消抛 `TaskCancelledError`——形制 azure.ts。

### 6. 音色预填与展示：2.0 通用集 + 内置名映射，文档外链

- `voices` 默认值预填 4–6 个 2.0 通用音色（中文为主、含男女声，如爽快思思/小何/Vivi/云舟等 `*_uranus_bigtts`；**实现期以真机账号实测可用性定稿**，先例 ElevenLabs premade 集）。
- 新增 `VOLC_TTS_VOICE_LABELS`（id→中文名，形制 `ELEVENLABS_PREMADE_VOICE_LABELS`）；`resolveTtsVoiceLabel` 的内置映射回落分支由 ElevenLabs 专用扩展为按类型查表（volcengine 加入），音色下拉与标签显示中文名、悬浮露原 id。
- `docsUrl` 指向官方音色列表文档（`https://www.volcengine.com/docs/6561/1257544`），面板「音色文档」按钮跳转；tips 指引「从文档复制 voice_type 追加，注意与资源版本匹配」。

### 7. 字段 schema 与能力声明

- 字段：`apiKey`（password，必填）、`resourceId`（select，必填，默认 `seed-tts-2.0`）、`voices`（text，必填，预填 2.0 集）、`requestTimeoutSec`（默认 60）、`concurrency`（默认 2）。
- 能力：`speedControl: 'native'`、`maxCharsPerRequest: 1000`（官方接口文档未明示上限、错误码 `40402003` 存在；单条字幕远不触顶，取保守值，实现期校准）、`concurrency: 2`（字符版并发上限保守默认，字段可调）。
- 品牌资产：`iconImg: '/images/providers/volcengine-color.svg'`（与 ASR 条目同源）、name「火山引擎 豆包语音合成」、shortName「豆包语音」。

## Risks / Trade-offs

- [预填 2.0 音色在用户账号未开通对应商品时合成失败] → `45000000` 定向引导（检查音色开通）+ tips 写明「音色需与资源版本匹配、在控制台开通」；测试连接即会暴露，不至带病进批量合成。
- [chunked 分片的换行分隔假设若不成立，按行解析失败] → 解析器真机验证（tasks 前置）；若实测无换行则退化为贪婪 JSON 对象边界扫描（纯函数内部实现细节，接口不变）。
- [`maxCharsPerRequest: 1000` 保守值与官方真实上限不符] → 单条字幕场景 <200 字符不触顶；实现期真机校准，仅影响极端长行的前置报错阈值。
- [speech_rate 与实际时长非线性] → 既有第 2 层复测（云端 atempo）兜底，native 分支不假设线性。
- [免费赠额耗尽/欠费的错误形态未实测] → quota/concurrency 引导按 message 关键词匹配，未命中时原样透出 code + message（可诊断不误导）。
- [火山服务端 keep-alive 60s] → Node fetch（undici）自带连接池，逐段短请求天然复用，无需额外处理。

## Migration Plan

纯新增：未配置豆包实例时对既有用户零感知；`ttsProviders` 存储结构不变。回滚 = 移除类型注册与分发表映射，无数据迁移。

## Open Questions

（实现期真机实测已全部收敛，2026-07：）

- ~~预填音色集定稿~~ → 爽快思思/小何/Vivi/云舟/儒雅逸辰 5 款 2.0 音色逐一实测可用，定稿。
- ~~chunked 分片分隔符~~ → 正常流实测为按行分隔 JSON 分片（brace 扫描兼容形态保留）；HTTP 401 错误 body 实测为 `{"header":{code,message}}` 包裹形态，解析器补 header 提取分支。
- ~~单请求字符上限~~ → 实测 10000 字符未被前置拒绝（合成耗时成为实际约束、先撞请求超时），保守值 1000 保留兼作超时防线。
- **实测修正**：坏音色 id 与资源版本错配服务端同报 `55000000 mismatched`（不区分成因），错误文案同时覆盖两者；无效 Key 为 HTTP 401 + `header.code 45000010`。
