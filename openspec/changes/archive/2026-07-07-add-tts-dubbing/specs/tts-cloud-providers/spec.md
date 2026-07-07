# Spec Delta: tts-cloud-providers

## ADDED Requirements

### Requirement: 云端 TTS 服务商框架

系统 SHALL 提供云端 TTS 服务商框架,形制对齐云 ASR:类型以 schema 驱动表单声明字段(`ProviderField[]`)、实例持久化于 `ttsProviders` 存储键、提供 `isTtsProviderConfigured` 就绪判定、service 层以分发表(`TTS_SYNTHESIZER_MAP`)按类型路由。每个服务商 MUST 声明能力:`speedControl: 'native' | 'ssml' | 'none'`、可选 `maxCharsPerRequest`、可选 `concurrency`。

#### Scenario: 类型出现在配音配置面板

- **WHEN** 用户打开「引擎与模型」页的配音区块
- **THEN** OpenAI 兼容与 Edge TTS 两个类型可配置,表单由各自 schema 字段驱动渲染

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
