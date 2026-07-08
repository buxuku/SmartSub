## ADDED Requirements

### Requirement: 火山引擎豆包语音合成服务商

系统 SHALL 提供品牌型云 TTS 服务商类型 `volcengine`（硬单例）：凭据为必填的**单 API Key**（新版「豆包语音」控制台签发，走 `X-Api-Key` 头；与豆包听写 ASR 同 Key 体系可复用；旧版控制台 App ID + Access Token 两件套 MUST NOT 支持）；资源版本为必填枚举字段 `resourceId`（`seed-tts-2.0` 默认 / `seed-tts-1.0` / `seed-tts-1.0-concurr`），经 `X-Api-Resource-Id` 头传递。合成 SHALL 走 V3 单向流式 HTTP（`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，固定官方域），请求 `audio_params.format = pcm`（24kHz）：chunked JSON 分片中的 base64 音频解码拼接为裸 PCM 后本地拼 WAV 头落盘为 16-bit PCM 单声道 wav，MUST NOT 经 ffmpeg 转码；流解析（分片 JSON → PCM + 终止码提取）MUST 为纯函数并有固定向量单测。能力声明 `speedControl` MUST 为 `'native'`：speed 折算为 `audio_params.speech_rate`（线性映射 `(speed - 1) × 100`，clamp 到官方区间 [-50, 100] 即倍速 [0.5, 2.0]，折算为纯函数并有单测），speed 无调整时 MUST 省略该字段。配置界面 MUST 提示计费口径：字符版按字符计费（约 1.3 元/千字符，2026-07 口径）、新用户有免费赠额、资源版本对应不同计费商品。

#### Scenario: 配音服务页出现豆包条目

- **WHEN** 用户打开「配音服务」页
- **THEN** 「在线服务」组出现火山引擎豆包品牌条目（单例），表单含 API Key、资源版本枚举、音色清单、超时与并发字段，且面板可见计费口径与免费赠额提示

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

## MODIFIED Requirements

### Requirement: 云端 TTS 服务商框架

系统 SHALL 提供云端 TTS 服务商框架,形制对齐云 ASR:类型以 schema 驱动表单声明字段(`ProviderField[]`)、实例持久化于 `ttsProviders` 存储键、提供 `isTtsProviderConfigured` 就绪判定、service 层以分发表(`TTS_SYNTHESIZER_MAP`)按类型路由。每个服务商 MUST 声明能力:`speedControl: 'native' | 'ssml' | 'none'`、可选 `maxCharsPerRequest`、可选 `concurrency`。内置类型 SHALL 覆盖:OpenAI 兼容(协议型多实例)、Edge TTS、Azure Speech、ElevenLabs、火山引擎豆包(品牌型单例),新增类型 MUST 经 `buildTtsViews` 数据驱动自动外显于「配音服务」页,无需逐处修改 UI。

#### Scenario: 类型出现在配音服务页

- **WHEN** 用户打开「配音服务」页的「在线服务」组
- **THEN** OpenAI 兼容(含预设槽位与自定义实例)、Edge TTS、Azure Speech、ElevenLabs、火山引擎豆包各为可配置条目,表单由各自 schema 字段驱动渲染

#### Scenario: 能力声明驱动对齐分支

- **WHEN** 对齐引擎查询某服务商能力
- **THEN** 返回其 `speedControl` 取值,决定合成期语速走 native speed 参数、SSML 还是仅后处理变速
