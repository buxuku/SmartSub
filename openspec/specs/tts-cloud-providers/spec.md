# Spec: tts-cloud-providers

## Purpose

云端配音(TTS)服务商框架：schema 驱动配置 + `ttsProviders` 持久化 + 分发表路由,v1 内置 OpenAI 兼容(协议型多实例)与 Edge TTS(免费试用档);服务商声明 speedControl/字符上限/并发能力,测试连接以真实合成验证。

## Requirements

### Requirement: 云端 TTS 服务商框架

系统 SHALL 提供云端 TTS 服务商框架,形制对齐云 ASR:类型以 schema 驱动表单声明字段(`ProviderField[]`)、实例持久化于 `ttsProviders` 存储键、提供 `isTtsProviderConfigured` 就绪判定、service 层以分发表(`TTS_SYNTHESIZER_MAP`)按类型路由。每个服务商 MUST 声明能力:`speedControl: 'native' | 'ssml' | 'none'`、可选 `maxCharsPerRequest`、可选 `concurrency`。内置类型 SHALL 覆盖:OpenAI 兼容(协议型多实例)、Edge TTS、Azure Speech、ElevenLabs、火山引擎豆包(品牌型单例),新增类型 MUST 经 `buildTtsViews` 数据驱动自动外显于「配音服务」页,无需逐处修改 UI。

#### Scenario: 类型出现在配音服务页

- **WHEN** 用户打开「配音服务」页的「在线服务」组
- **THEN** OpenAI 兼容(含预设槽位与自定义实例)、Edge TTS、Azure Speech、ElevenLabs、火山引擎豆包各为可配置条目,表单由各自 schema 字段驱动渲染

#### Scenario: 能力声明驱动对齐分支

- **WHEN** 对齐引擎查询某服务商能力
- **THEN** 返回其 `speedControl` 取值,决定合成期语速走 native speed 参数、SSML 还是仅后处理变速

### Requirement: OpenAI 兼容服务商

系统 SHALL 提供「OpenAI 兼容」TTS 服务商类型:可配置 baseUrl、apiKey、model、默认 voice 等字段,单类型覆盖 OpenAI 及各聚合端点;`speedControl` 声明为 `native`(speed 0.25–4.0)。

#### Scenario: 合成一段文本

- **WHEN** 已配置有效 OpenAI 兼容实例并请求合成(text/voice/speed)
- **THEN** 返回音频被统一转存为 16-bit PCM wav 到 `outWavPath`

### Requirement: Edge TTS 服务商(免费试用档)

系统 SHALL 提供 Edge TTS 服务商类型:免费、无需 key,`speedControl` 为 `native`(rate ±%);配置界面 MUST 显著标注「免费试用档,不承诺可用性」(逆向接口随时可能断供);断供类错误 MUST 给出引导切换本地引擎或 OpenAI 兼容的可行动文案。

#### Scenario: 零配置可用

- **WHEN** 用户新建 Edge TTS 实例未填写任何凭据
- **THEN** 实例判定为已配置,可直接选择 voice 并合成

#### Scenario: 断供错误引导

- **WHEN** Edge TTS 请求因接口变更/鉴权失效持续失败
- **THEN** 错误信息说明该通道为不稳定试用档,并建议切换到本地模型或 OpenAI 兼容服务商

### Requirement: 测试连接

云端 TTS 服务商 SHALL 提供测试连接:以真实合成一句短文本(如 "Hello")验证凭据与连通性(TTS 无零成本探针),返回结构与 ASR testConnection 一致(成功/失败 + 可行动错误信息)。

#### Scenario: 凭据有效

- **WHEN** 用户点击测试且服务端成功返回音频
- **THEN** 测试通过并提示成功

#### Scenario: 凭据无效

- **WHEN** 服务端返回 401/403
- **THEN** 测试失败,错误信息指向 apiKey 配置

### Requirement: 云端并发与取消

云端合成 SHALL 遵守服务商实例声明的并发上限(并发闸),逐条合成的在途请求 MUST 支持 AbortSignal 取消;单请求文本超过 `maxCharsPerRequest` 时 MUST 在发起前报错(v1 不做自动切分)。

#### Scenario: 取消批量合成

- **WHEN** 用户在云端批量合成进行中取消任务
- **THEN** 在途 HTTP 请求中断,未开始的行不再发起,任务以取消语义结束

### Requirement: Azure Speech 服务商

系统 SHALL 提供品牌型云 TTS 服务商类型 `azureSpeech`（硬单例）：凭据为必填的 **region + subscription key** 两字段，可选 `endpoint` 字段整体覆盖端点（支持世纪互联等主权云域名）；缺省端点由 region 拼接 `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`，鉴权以 `Ocp-Apim-Subscription-Key` 头直传。合成 SHALL 请求 `X-Microsoft-OutputFormat: riff-24khz-16bit-mono-pcm` 直出 wav，落盘前校验为 16-bit PCM 单声道，不合规时回落 ffmpeg 转码兜底。能力声明 `speedControl` MUST 为 `'ssml'`：speed 折算为 SSML `<prosody rate>`（clamp 到 Azure 支持区间 [0.5, 2.0]），SSML 构造与 XML 特殊字符转义 MUST 为纯函数并有固定向量单测，speed 无调整时 MUST 省略 prosody 元素（减少计费字符）。配置界面 MUST 提示计费口径：按字符计费且包含 SSML 标记字符、F0 免费层每月 50 万字符。

#### Scenario: 配音服务页出现 Azure 条目

- **WHEN** 用户打开「配音服务」页
- **THEN** 「在线服务」组出现 Azure Speech 品牌条目（单例），表单含 region、subscription key、可选 endpoint、音色清单等字段，且面板可见 SSML 计费与免费额度提示

#### Scenario: SSML 语速预控制

- **WHEN** 对齐引擎对某行给出 speed = 1.3 的预控制参数并经 Azure 合成
- **THEN** 请求 body 为 SSML 且该行文本包裹在 `<prosody rate="+30%">`（或等效倍率表达）中，返回音频时长相应缩短

#### Scenario: 文本含 XML 特殊字符

- **WHEN** 某行字幕文本包含 `&`、`<`、`>` 等 XML 特殊字符
- **THEN** 合成请求中的文本被正确转义，服务端不返回 SSML 解析错误，合成音频完整朗读原文本

#### Scenario: 凭据错误可诊断

- **WHEN** subscription key 或 region 配置错误（服务端 401/403）
- **THEN** 错误信息明确指向「检查 subscription key 与 region 是否匹配」，而非笼统失败

### Requirement: ElevenLabs 服务商

系统 SHALL 提供品牌型云 TTS 服务商类型 `elevenlabs`（硬单例）：凭据为必填的 xi-api-key；model_id 可配置（默认 `eleven_multilingual_v2`）；音色清单支持在线拉取（`voiceListMode`，拉取账号音色）与预置名称映射（预填官方通用 premade 音色）；base URL 非必填，缺省回落 `https://api.elevenlabs.io/v1`。合成 SHALL 请求 `output_format=pcm_24000` 直出裸 PCM，本地拼接 WAV 头落盘为 16-bit PCM 单声道 wav，MUST NOT 经 ffmpeg 转码（WAV 包头构造为纯函数并有单测）。能力声明 `speedControl` MUST 为 `'native'`：speed 经 `voice_settings.speed` 传递并 clamp 到保守区间 [0.7, 1.2]（超出部分由既有云端 atempo 复测分支补足）；能力声明 SHALL 含 `clone: true`：即时克隆（IVC）产出的 `voice_id` MUST 可直接作为合成 voice 使用（与内置音色同池、无需资源切换）。网络类失败（连接失败/超时）的错误信息 MUST 附「该服务国内无法直连，需配置网络代理或切换其它服务商」引导；配置界面 MUST 提示免费额度（1 万字符/月）与中文按字节膨胀计费（约 3 字符/字）。

#### Scenario: 克隆音色直接合成

- **WHEN** 工作台以 IVC 克隆音色的 voice_id 发起合成
- **THEN** 走既有 ElevenLabs 合成通道成功产出音频，无需任何额外资源头或路由

#### Scenario: 裸 PCM 直接落盘

- **WHEN** ElevenLabs 返回 pcm_24000 音频流
- **THEN** 产物被本地包上 WAV 头写入 `outWavPath`，全程无 ffmpeg 转码进程，`readWavInfo` 读出 24kHz/16-bit/单声道与正确时长

#### Scenario: speed 超出保守区间自动收敛

- **WHEN** 对齐引擎对某行给出 speed = 1.4 的预控制参数并经 ElevenLabs 合成
- **THEN** 请求中的 `voice_settings.speed` 被 clamp 为 1.2，实测超出槽位的残余由复测分支以 atempo 补足，最终落位

#### Scenario: 国内直连失败引导

- **WHEN** 用户未配置代理直接测试连接且请求超时
- **THEN** 失败信息说明该服务需代理访问，并建议配置系统代理或改用其它服务商

### Requirement: 火山引擎豆包语音合成服务商

系统 SHALL 提供品牌型云 TTS 服务商类型 `volcengine`（硬单例）：凭据为必填的**单 API Key**（新版「豆包语音」控制台签发，走 `X-Api-Key` 头；与豆包听写 ASR 同 Key 体系可复用；旧版控制台 App ID + Access Token 两件套 MUST NOT 用于合成鉴权）；资源版本为必填枚举字段 `resourceId`（`seed-tts-2.0` 默认 / `seed-tts-1.0` / `seed-tts-1.0-concurr`），经 `X-Api-Resource-Id` 头传递；**另 SHALL 提供可选的声音复刻凭据字段 `appId` 与 `accessToken`（训练接口走 `X-Api-App-Key` + `X-Api-Access-Key` 双凭据），二者 MUST NOT 参与合成就绪判定（`isTtsProviderConfigured`），仅克隆训练链路消费**。合成 SHALL 走 V3 单向流式 HTTP（`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，固定官方域），请求 `audio_params.format = pcm`（24kHz）：chunked JSON 分片中的 base64 音频解码拼接为裸 PCM 后本地拼 WAV 头落盘为 16-bit PCM 单声道 wav，MUST NOT 经 ffmpeg 转码；流解析（分片 JSON → PCM + 终止码提取）MUST 为纯函数并有固定向量单测。**合成资源版本 SHALL 按音色自动路由：`S_` 开头克隆音色以 `seed-icl-2.0` 发起，其余音色沿用实例 `resourceId`（路由纯函数 + 单测）**。能力声明 `speedControl` MUST 为 `'native'`：speed 折算为 `audio_params.speech_rate`（线性映射 `(speed - 1) × 100`，clamp 到官方区间 [-50, 100] 即倍速 [0.5, 2.0]，折算为纯函数并有单测），speed 无调整时 MUST 省略该字段；能力声明 SHALL 含 `clone: true`。配置界面 MUST 提示计费口径：字符版按字符计费（约 1.3 元/千字符，2026-07 口径）、新用户有免费赠额、资源版本对应不同计费商品；克隆凭据字段 tips MUST 说明声音复刻需在控制台购买音色槽位。

#### Scenario: 配音服务页出现豆包条目

- **WHEN** 用户打开「配音服务」页
- **THEN** 「在线服务」组出现火山引擎豆包品牌条目（单例），表单含 API Key、资源版本枚举、音色清单、超时与并发字段，另含可选的声音复刻 APP ID / Access Token 字段（带控制台槽位购买指引），且面板可见计费口径与免费赠额提示

#### Scenario: 裸 PCM 直接落盘

- **WHEN** 豆包接口以 chunked JSON 分片返回 base64 PCM 音频
- **THEN** 分片按序解码拼接并本地包 WAV 头写入 `outWavPath`，全程无 ffmpeg 转码进程，`readWavInfo` 读出 24kHz/16-bit/单声道与正确时长

#### Scenario: 原生语速预控制

- **WHEN** 对齐引擎对某行给出 speed = 1.3 的预控制参数并经豆包合成
- **THEN** 请求 `audio_params.speech_rate` 为 30，返回音频时长相应缩短；speed = 2.5 超界时 clamp 为 100（2.0 倍速），残余由既有云端复测分支以 atempo 补足

#### Scenario: 凭据错误可诊断

- **WHEN** API Key 无效或类型不符（服务端 HTTP 401/403，如误用火山方舟推理 Key）
- **THEN** 错误信息明确指向「检查 API Key 需为豆包语音控制台签发（方舟 Key 不通用），并确认已开通语音合成服务」，而非笼统失败

#### Scenario: 资源版本与音色错配可诊断

- **WHEN** 音色清单里的 1.0 音色（如 `*_moon_bigtts`）在 `resourceId = seed-tts-2.0` 下发起合成（服务端返回 `55000000` resource mismatched 类错误）
- **THEN** 错误信息说明资源版本与音色版本不匹配，并给出对应关系（2.0 音色配 `seed-tts-2.0`、1.0 音色配 `seed-tts-1.0`）

#### Scenario: 并发限流定向引导

- **WHEN** 批量合成触发服务端并发配额限制（HTTP 429 或错误 message 含 concurrency/quota）
- **THEN** 错误信息引导「调低实例并发或稍后重试」，并说明免费赠额与字符版并发上限有限

#### Scenario: 音色预填与文档外链

- **WHEN** 用户新建豆包实例
- **THEN** 音色清单已预填 2.0 通用音色 id，配置面板标签与工作台 voice 下拉一致按内置中文名目录展示（悬浮可见原 id）；面板提供「音色文档」外链跳转官方音色列表，tips 指引复制 voice_type 并注意与资源版本匹配

#### Scenario: 内置目录驱动录入补全

- **WHEN** 用户在豆包实例的音色录入框输入关键字（如「男」或 `zh_male`）
- **THEN** 出现按「名称/ID 包含匹配」的自动补全下拉（数据源为内置 2.0 音色目录 ∪ 实例名称映射），↑↓ 选择、回车/点击录入，无需手工拼写完整 voice_type

#### Scenario: 克隆音色进入工作台音色池

- **WHEN** 某豆包实例绑定的克隆音色训练就绪
- **THEN** 工作台该实例的音色下拉出现该克隆音色（按音色名展示），选中后试听与批量合成自动以 `seed-icl-2.0` 资源发起

### Requirement: 音色清单在线拉取与名称映射

支持音色清单 API 的服务商类型 SHALL 声明 `voiceListMode`（`'replace' | 'label'`），其配置面板提供「拉取音色」动作：

- **replace**（ElevenLabs，`GET /v1/voices`）：音色清单替换为账号实际可用集，并回填 id→名称映射；
- **label**（Azure，`GET voices/list` 区域全量）：仅回填名称映射，不改动用户清单。

名称映射 SHALL 持久化于实例（`voiceLabels`），已有映射时音色标签、录入自动补全（按名称/ID 包含匹配）与工作台 voice 下拉 MUST 按名称展示且原 id 仍可见（悬浮/并列）；无映射的 id 原样展示。拉取失败 MUST 给出可行动错误（如 ElevenLabs key 缺 voices_read 权限时指引到 dashboard 勾选）。服务商类型 SHALL 可声明官方语音库文档外链（`docsUrl`），面板提供跳转入口。

#### Scenario: 拉取后按名称展示

- **WHEN** 用户在 ElevenLabs 面板点击「拉取音色」且 key 权限完整
- **THEN** 清单替换为账号音色集，标签与工作台 voice 下拉显示音色名（如 Sarah）而非裸 voice_id

#### Scenario: Azure label 模式不动清单

- **WHEN** 用户在 Azure 面板点击「拉取音色」（区域全量 700+）
- **THEN** 当前音色清单保持不变，仅名称映射回填（如 zh-CN-XiaoxiaoNeural 显示为「晓晓 (zh-CN)」），后续录入可按名称自动补全

#### Scenario: 缺权限的定向引导

- **WHEN** ElevenLabs key 缺少 voices_read 权限时点击拉取
- **THEN** 错误信息明确指引到 dashboard ▸ API Keys 为该 Key 勾选 Voices 读取权限
