## ADDED Requirements

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

系统 SHALL 提供品牌型云 TTS 服务商类型 `elevenlabs`（硬单例）：凭据为必填的 xi-api-key；model_id 可配置（默认 `eleven_multilingual_v2`）；音色清单为 voice_id 列表（预填官方通用 premade 音色，提示用户可从 dashboard 复制自有/克隆音色 id）；base URL 非必填，缺省回落 `https://api.elevenlabs.io/v1`。合成 SHALL 请求 `output_format=pcm_24000` 直出裸 PCM，本地拼接 WAV 头落盘为 16-bit PCM 单声道 wav，MUST NOT 经 ffmpeg 转码（WAV 包头构造为纯函数并有单测）。能力声明 `speedControl` MUST 为 `'native'`：speed 经 `voice_settings.speed` 传递并 clamp 到保守区间 [0.7, 1.2]（超出部分由既有云端 atempo 复测分支补足）。网络类失败（连接失败/超时）的错误信息 MUST 附「该服务国内无法直连，需配置网络代理或切换其它服务商」引导；配置界面 MUST 提示免费额度（1 万字符/月）与中文按字节膨胀计费（约 3 字符/字）。

#### Scenario: 裸 PCM 直接落盘

- **WHEN** ElevenLabs 返回 pcm_24000 音频流
- **THEN** 产物被本地包上 WAV 头写入 `outWavPath`，全程无 ffmpeg 转码进程，`readWavInfo` 读出 24kHz/16-bit/单声道与正确时长

#### Scenario: speed 超出保守区间自动收敛

- **WHEN** 对齐引擎对某行给出 speed = 1.4 的预控制参数并经 ElevenLabs 合成
- **THEN** 请求中的 `voice_settings.speed` 被 clamp 为 1.2，实测超出槽位的残余由复测分支以 atempo 补足，最终落位

#### Scenario: 国内直连失败引导

- **WHEN** 用户未配置代理直接测试连接且请求超时
- **THEN** 失败信息说明该服务需代理访问，并建议配置系统代理或改用其它服务商

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

## MODIFIED Requirements

### Requirement: 云端 TTS 服务商框架

系统 SHALL 提供云端 TTS 服务商框架,形制对齐云 ASR:类型以 schema 驱动表单声明字段(`ProviderField[]`)、实例持久化于 `ttsProviders` 存储键、提供 `isTtsProviderConfigured` 就绪判定、service 层以分发表(`TTS_SYNTHESIZER_MAP`)按类型路由。每个服务商 MUST 声明能力:`speedControl: 'native' | 'ssml' | 'none'`、可选 `maxCharsPerRequest`、可选 `concurrency`。内置类型 SHALL 覆盖:OpenAI 兼容(协议型多实例)、Edge TTS、Azure Speech、ElevenLabs(品牌型单例),新增类型 MUST 经 `buildTtsViews` 数据驱动自动外显于「配音服务」页,无需逐处修改 UI。

#### Scenario: 类型出现在配音服务页

- **WHEN** 用户打开「配音服务」页的「在线服务」组
- **THEN** OpenAI 兼容(含预设槽位与自定义实例)、Edge TTS、Azure Speech、ElevenLabs 各为可配置条目,表单由各自 schema 字段驱动渲染

#### Scenario: 能力声明驱动对齐分支

- **WHEN** 对齐引擎查询某服务商能力
- **THEN** 返回其 `speedControl` 取值,决定合成期语速走 native speed 参数、SSML 还是仅后处理变速
