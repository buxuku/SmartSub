# cloud-asr-transcription Specification

## Purpose

TBD - created by archiving change add-cloud-asr-providers. Update Purpose after archive.

## Requirements

### Requirement: 云端听写服务商的多实例凭证配置

系统 SHALL 提供「云端听写服务商」的多实例配置，独立于翻译服务商存储（`store.asrProviders`）。每个服务商类型 SHALL 以字段声明（`AsrProviderType.fields`）驱动表单渲染，首个内置类型为 **OpenAI 兼容转写**（必填 `base_url`、`api_key`、`model`）。配置页 SHALL 按「已配置 / 未配置」分组呈现。凡缺任一必填字段的实例 MUST 判为「未配置」。

#### Scenario: 新建 OpenAI 兼容实例

- **WHEN** 用户在「云端听写」配置页新建一个 OpenAI 兼容实例并填入 base_url、api_key、model
- **THEN** 该实例被保存进 `asrProviders`，并出现在「已配置」分组

#### Scenario: 缺必填字段判为未配置

- **WHEN** 某云服务商实例缺少 api_key 或 model
- **THEN** 该实例被判为「未配置」，在配置页置于「未配置」分组，且不可在任务中被选为转写来源

### Requirement: 云引擎接入逐任务转写流程

系统 SHALL 新增单一云引擎适配器（`transcriptionEngine='cloud'`），经现有 `routeTranscription` 进入，并按所选实例的 `type` 通过 `ASR_TRANSCRIBER_MAP` 分发到具体服务商实现。转写产物 SHALL 与本地引擎一致：写出 SRT 并发出与其它引擎相同的进度/状态事件。

#### Scenario: 用云实例转写视频产出字幕

- **WHEN** 任务选择某已配置云实例 + 模型，对一个视频执行「生成字幕」
- **THEN** 系统抽取本地音频、调用该实例的转写 API、写出 SRT，并发出 `extractSubtitle` 的 loading→done 与进度事件

#### Scenario: 按实例类型分发

- **WHEN** 所选实例 `type='openaiCompatible'`
- **THEN** 云适配器调用 `ASR_TRANSCRIBER_MAP['openaiCompatible']` 的实现，而非其它类型

### Requirement: 词级时间戳优先并复用现有成句管线

云转写 SHALL 优先请求词级时间戳（OpenAI 兼容：`response_format:'verbose_json'` + `timestamp_granularities:['word']`），并把词级结果 `{word,start,end}` 归一为内部 `NativeToken{text,t0,t1}`（毫秒），复用现有 `tokensToTriples → groupTokenCues → mergeShortCues → enforceMinDisplayDuration → trimSubtitleTrailingSilence` 成句。系统 MUST NOT 为云引擎另造一套成句逻辑。

#### Scenario: 中文单段但字级时间戳可切分

- **WHEN** 某中文模型返回 1 个覆盖全程的大段，但含精准的字级 words
- **THEN** 系统据 words 切分为多条时间对齐的字幕，而非输出单条巨块

#### Scenario: 复用本地能量裁剪

- **WHEN** 云转写完成且本地音频 WAV 存在
- **THEN** 系统对成句结果应用 `trimSubtitleTrailingSilence` 等既有本地时间轴打磨

### Requirement: 无词级时间戳模型的降级

当所选模型不支持词级/verbose 时间戳（如转写端点拒绝 `verbose_json`）时，系统 SHALL 降级为「按静音切片（复用 `energySpeechSegments`）+ 每片转写 + 加块起始偏移拼接」得到段级时间轴，并在 UI 标注为「粗粒度时间轴」。系统 MUST NOT 因缺时间戳而失败或产出无时间轴的字幕。

#### Scenario: 模型拒绝 verbose_json 时降级

- **WHEN** 模型对 `verbose_json` 返回不兼容错误
- **THEN** 系统改走静音切片得到段级时间轴并成功产出 SRT，同时任务卡片标注「粗粒度时间轴」

### Requirement: 音频大小/时长超限处理

当本地音频超出所选服务商的大小或时长上限时，系统 SHALL 先用 ffmpeg 转码压缩；若仍超限则按静音切片（带最大块时长/大小上限）分块转写、加偏移后拼接成连续时间轴。系统 SHALL 始终保留本地 WAV 供能量裁剪使用。

#### Scenario: 超限音频压缩后上传

- **WHEN** 本地 WAV 超过服务商大小上限但压缩后不超
- **THEN** 系统上传压缩后的音频完成转写

#### Scenario: 压缩仍超限则切片拼接

- **WHEN** 压缩后仍超过大小或时长上限
- **THEN** 系统按静音边界切片、分块转写并按块偏移拼接，输出时间轴连续、无跨块错位的字幕

### Requirement: 云引擎高并发（不受本地并发钳制）

云引擎 MUST NOT 被纳入 `isRestrictiveEngine`（本地共享 sidecar/worker 的「有效并发钳到 1」）。纯云任务队列 SHALL 遵循用户配置的 `maxConcurrentTasks`。

#### Scenario: 纯云队列按配置并发

- **WHEN** 队列全为云任务且 `maxConcurrentTasks=3`
- **THEN** 最多 3 个云转写并发执行，不被钳制为 1

### Requirement: 请求超时与有限重试

云转写每次请求 SHALL 设置显式超时并采用有限次数重试（避免无限挂起）。系统 MUST NOT 依赖 SDK 的超长默认超时。

#### Scenario: 超时不无限挂起

- **WHEN** 某次请求超过配置的超时阈值
- **THEN** 该请求以超时错误结束，任务报错而非无限等待

#### Scenario: 瞬时失败有限重试

- **WHEN** 请求遇到可重试的瞬时错误
- **THEN** 系统按有限次数退避重试，超过次数后以明确错误结束

### Requirement: 取消进行中的云转写

云引擎 SHALL 响应任务取消：`cancelActive()` 与 `ctx.signal` 触发时中止在途 HTTP 请求（切片模式下中止全部子请求），清理半成品，并使任务回到可重跑状态。

#### Scenario: 取消中止在途请求

- **WHEN** 用户在云转写进行中取消任务
- **THEN** 系统中止在途请求、不写出半成品 SRT，任务状态回到可重新开始

### Requirement: 「引擎 ▸ 模型」下拉呈现云实例并携带实例标识

系统 SHALL 把已配置云实例并入现有「引擎 ▸ 模型」下拉（每个实例为一个分组，组内为其可选模型）。选中云项 SHALL 写入 `transcriptionEngine='cloud'`、`asrProviderId=<实例id>` 与 `model=<模型>`。无任何已配置云实例时，下拉 SHALL 提供「去配置云端听写」入口。

#### Scenario: 选中云实例携带三要素

- **WHEN** 用户在下拉里选择某云实例分组下的某模型
- **THEN** 表单同时得到 `transcriptionEngine='cloud'`、对应 `asrProviderId` 与 `model`

#### Scenario: 无云实例时引导配置

- **WHEN** 没有任何已配置云实例
- **THEN** 下拉不列出云分组，而是提供「去配置云端听写」入口

#### Scenario: 云选择跨新任务保持（默认校正不早跑）

- **WHEN** 用户用某云实例跑过任务后新开任务页，且该实例仍已配置
- **THEN** 默认选中仍是该云实例与模型；默认校正 MUST 等本地模型清单、云实例与「上次使用」记忆全部加载完成后再判定，不得在数据未齐时把云选择误判失效而回退本地引擎

### Requirement: 云引擎就绪判定

云引擎 `isAvailable` SHALL 在存在至少一个字段齐全的云实例时返回就绪；否则返回未就绪并附引导信息。转写前若所选实例已失效/被删除，系统 SHALL 明确报错而非静默失败。

#### Scenario: 有可用实例即就绪

- **WHEN** 至少存在一个必填字段齐全的云实例
- **THEN** 云引擎判为就绪，可被任务选用

#### Scenario: 所选实例缺失时明确报错

- **WHEN** 任务引用的 `asrProviderId` 已被删除或字段不全
- **THEN** 转写以明确的「服务商未配置/不存在」错误结束

### Requirement: 隐私一次性同意

在**首次**使用任一云服务商执行转写前，系统 SHALL 明确提示「音频将离开本机上传至第三方」并取得用户确认，且记住该选择。用户拒绝时 MUST NOT 上传音频或执行云转写。

#### Scenario: 首次云转写前确认

- **WHEN** 用户首次以云引擎发起转写
- **THEN** 系统弹出音频离机提示，用户确认后方才上传；拒绝则不上传、不转写

### Requirement: 成本/时长预估提示

提交云转写任务前，系统 SHALL 依据待处理音频总时长给出用量/成本**预估提示**（非精确计费）。

#### Scenario: 提交前给出时长用量提示

- **WHEN** 用户提交一批云转写任务
- **THEN** 系统展示基于总时长的用量预估提示

### Requirement: 对本地引擎与既有行为非破坏

本变更 MUST NOT 改变本地引擎（builtin / fasterWhisper / funasr / qwen / fireRedAsr / localCli）的行为。未配置任何云服务商时，引擎选择与转写行为 SHALL 与变更前一致。

#### Scenario: 未配置云时行为不变

- **WHEN** 用户未配置任何云服务商
- **THEN** 「引擎 ▸ 模型」下拉与转写流程与现状完全一致，无云分组、无新增提示

### Requirement: Protocol-type provider presets

The system SHALL let a protocol-type cloud ASR provider type (e.g. OpenAI-compatible) declare a list of named presets, where each preset carries connection field values (such as base URL and model list) but not credentials. Each preset SHALL surface as a **permanent sidebar entry** (a preset slot with its own icon and name) in the cloud group — presets MUST NOT be hidden behind a dropdown, quick-add area, or other disclosure interaction. Selecting a preset slot SHALL show a direct configuration form with the preset's field values prefilled; the instance is lazily materialized on first edit and marked with the preset's id. A preset SHALL only prefill field values; the created instance's provider `type` and the backend transcription/dispatch behavior SHALL remain unchanged.

#### Scenario: Presets visible in the sidebar

- **WHEN** a user opens the engine page
- **THEN** OpenAI / Groq / SiliconFlow each appear as their own sidebar entries in the cloud group, without opening any menu or panel

#### Scenario: Selecting a preset slot prefills endpoint and models

- **WHEN** a user selects a preset slot (e.g. Groq)
- **THEN** the form shows that preset's base URL and model list prefilled, the provider `type` unchanged; first edit materializes the instance with the preset id stamped

#### Scenario: Presets never fill credentials

- **WHEN** an instance is materialized from any preset slot
- **THEN** no API key or other credential is written by the preset, and the entry is reported as not-yet-configured until the user supplies the required credential

#### Scenario: Brand-type providers are unaffected

- **WHEN** the provider type is a brand-type singleton (e.g. ElevenLabs)
- **THEN** it has exactly one sidebar entry with the direct-form behavior and no preset slots

### Requirement: 云端听写类别呈现全部服务商类型（平级并列）

云端听写支持的全部服务商 SHALL 以左栏「云端听写」分组下**逐条目平级入口**的形式呈现（品牌型逐类型一条、协议型逐预设/逐自定义实例），条目清单以 `ASR_PROVIDER_TYPES` 与 `ASR_PROVIDER_PRESETS` 为唯一事实源。类别级文案（组标题、面板通用说明）MUST NOT 将「OpenAI 兼容」当作涵盖其它服务商的伞盖表述；单入口时代为罗列各家而设的聚合标签（`engines.cloud.tags` 一类 mega-tags）SHALL 移除，品牌可见性由侧栏逐条目入口承担。

#### Scenario: 服务商可见性由侧栏承担

- **WHEN** 用户进入「引擎与模型」页
- **THEN** 支持的服务商平台与预设通过云组逐条目入口（品牌图标 + 名称）直接可见，不依赖任何聚合 tags 或需要点开的列表

#### Scenario: 文案不把 OpenAI 当伞盖

- **WHEN** 阅读云端听写组与各服务商面板的说明文案
- **THEN** 不出现「仅 OpenAI」或将 ElevenLabs / Deepgram 等归入「OpenAI 兼容」之下的表述

### Requirement: 服务商类型基数（协议型多实例 / 品牌型硬单例）

`AsrProviderType` SHALL 通过可选 `multiInstance` 标记区分基数，且该区分 MUST 仅影响左栏条目展开方式与面板呈现，MUST NOT 改动后端分发、凭据校验或存储结构。全部云条目 SHALL 共享「选中即表单」心智——UI MUST NOT 暴露「实例」管理概念（实例列表、配置按钮、实例切换）。

**品牌型**（未标记，如 ElevenLabs / Deepgram / 豆包 / 腾讯云 / 阿里云 / 讯飞 / Gladia）SHALL 为硬单例：每类型一个侧栏条目，选中后右栏**直接渲染凭据表单**。无实例时表单展示字段默认值，首次编辑 SHALL 惰性物化唯一实例（沿用既有实例构造与持久化路径）；已存历史实例 SHALL 被原样接管。面板 SHALL 提供带确认的「清除配置」动作：删除该单例实例、表单回落默认值、状态回「未配置」、条目保留。填齐必填字段即判定「已就绪」（`isAsrProviderConfigured` 口径），以头部徽标为唯一状态口径。

**协议型**（`multiInstance: true`，如 OpenAI 兼容）SHALL 摊平为侧栏逐条目形态：

- **预设槽位条目**（每个命名预设一条，恒驻）：行为与品牌型一致（表单直显、惰性物化、清除配置）；物化实例 SHALL 打 `presetId` 来源标记。槽位与实例的绑定 SHALL 按「`presetId` 显式指向（改 URL 不漂移）→ 无 `presetId` 的历史实例按名称与 base URL 双匹配兜底」认领，每槽至多一个实例；改过名或 URL 的历史实例 MUST NOT 被槽位认领（按自定义条目对待）。
- **自定义实例条目**（逐实例一条）：显示名=实例名；面板含可编辑「名称」字段与常驻「删除」动作（带确认，删除移除整个条目）。
- **「添加自定义」入口** SHALL 固定在云组末尾：收集名称（必填）与可选 Base URL 新建自定义实例并跳转其条目；同类型内 SHALL 自动去重命名（如 `OpenAI` → `OpenAI 2`），MUST NOT 产生仅凭名称无法区分的条目。

#### Scenario: 品牌型选中即填、无实例操作

- **WHEN** 用户选中左栏「ElevenLabs」（尚未配置）
- **THEN** 右栏直接是凭据表单（无「配置」按钮、无实例列表），填入 API Key 等必填项后徽标变为「已就绪」

#### Scenario: 预设槽位与品牌型体验一致

- **WHEN** 用户选中左栏「Groq」预设槽位（尚未配置）
- **THEN** 右栏直接是表单（base URL / 模型已预填，凭据为空），填入 API Key 后徽标变为「已就绪」，全程无实例管理操作

#### Scenario: 首次编辑才落库

- **WHEN** 用户仅打开某品牌型或预设槽位面板但未编辑任何字段
- **THEN** 不产生任何持久化实例；首次编辑字段时才物化唯一实例并持久化（预设槽位物化的实例带 `presetId` 标记）

#### Scenario: 清除配置回到未配置

- **WHEN** 用户在已配置的品牌型或预设槽位面板点击「清除配置」并确认
- **THEN** 背后实例被删除，表单回落默认值，头部徽标与左栏状态点回「未配置」，条目仍驻侧栏

#### Scenario: 添加自定义实例成为独立条目

- **WHEN** 用户点击云组末尾「添加自定义」，输入名称「我的中转」与 Base URL 并确认
- **THEN** 云组出现「我的中转」条目并自动选中，其面板含可改名的「名称」字段与常驻删除入口（带确认）

#### Scenario: 自定义条目自动去重命名

- **WHEN** 用户添加自定义实例时输入了与既有条目相同的名称
- **THEN** 新条目自动追加序号（如 `OpenAI` → `OpenAI 2`），侧栏不出现无法区分的同名条目

#### Scenario: 历史实例按槽位认领或归为自定义

- **WHEN** 升级前存有名称与 base URL 均与「Groq」预设一致的历史实例，以及一个改过名的「Groq 生产」实例
- **THEN** 前者被 Groq 槽位认领（槽位显示已就绪），后者成为独立的「Groq 生产」自定义条目，数据零丢失

### Requirement: 服务商扩展遵循两级分类与三步 recipe

云端听写 SHALL 采用「类别 ▸ 类型 ▸ 实例」两级分类：类别为单一云引擎（`engine:'cloud'`）；类型为 `AsrProviderType`（各自 `fields` 驱动表单 + 一个 `transcribe` 实现）；实例为 `AsrProvider`（用户凭据，协议型可多实例、品牌型单例）。新增一个服务商类型 SHALL 仅需：向 `ASR_PROVIDER_TYPES` 增一条（按真实形态设 `multiInstance`）、在 `main/service/asr/` 实现其 `transcribe`、于 `ASR_TRANSCRIBER_MAP` 注册；左栏云组条目与右栏配置面板 SHALL 据 `ASR_PROVIDER_TYPES` / `ASR_PROVIDER_PRESETS` 自动纳入新类型与新预设，MUST NOT 需要改动导航/面板呈现代码。

#### Scenario: 新增类型自动获得入口与面板

- **WHEN** 开发者向 `ASR_PROVIDER_TYPES` 增加一个新服务商类型
- **THEN** 该类型自动出现在左栏云组并拥有由 `fields` 驱动的配置面板，无需改动导航与面板代码

#### Scenario: OpenAI 兼容端点服务商零代码复用

- **WHEN** 某服务商提供 OpenAI 兼容的 `/audio/transcriptions` 端点
- **THEN** 用户经云组末尾「添加自定义」填入其名称、base URL 与凭据即可使用，无需新增类型或代码

### Requirement: 讯飞录音文件转写服务商类型

系统 SHALL 提供品牌型云服务商类型 `xfyun`（科大讯飞·录音文件转写标准版）：**硬单例**（同豆包/腾讯/阿里）；凭据为必填的 **appId + secretKey** 两字段；模型为固定单值 `lfasr`（UI 只读展示）；端点固定 `raasr.xfyun.cn`（讯飞要求域名调用，IP 不固定），MUST NOT 开放自定义 base URL。音频 SHALL 以**本地文件流原始二进制**直传建单（`application/octet-stream`，`audioMode=fileStream`），MUST NOT 依赖公网 URL 中转或对象存储。实现 MUST NOT 引入讯飞 SDK 依赖（signa 签名以 Node `crypto` 自包含实现：`base64(HmacSHA1(MD5(appId+ts), secretKey))`，纯函数并有固定向量单测）。

#### Scenario: 配置面板出现讯飞分区（数据驱动、单例）

- **WHEN** 用户打开「引擎与模型 ▸ 云端听写」
- **THEN** 面板出现「讯飞 录音文件转写」分区，提供「配置」入口（品牌型单例形态，配置一个、封顶 1）

#### Scenario: 两字段凭据就绪判定

- **WHEN** 实例的 appId、secretKey 任一为空
- **THEN** 实例判定为未配置：不进任务页「引擎 ▸ 模型」下拉，连接自测返回「请先补全凭据」类结果

#### Scenario: 本地音频直传不落第三方存储

- **WHEN** 用户以讯飞实例转写本地视频
- **THEN** 音频原始字节直接 POST 到讯飞 upload 接口建单，全程不产生公网 URL、不经对象存储中转

### Requirement: 讯飞异步订单生命周期（建单 → 梯度轮询 → 终态）

讯飞转写 SHALL 为异步订单制：upload 建单成功后以 `orderId` 轮询 getResult 直至终态。轮询 SHALL 采用梯度策略：首查延迟按建单返回的 `taskEstimateTime` 比例收敛（下限 3s、上限 30s），后续间隔递增封顶 30s；频控错误（26603）SHALL 触发额外退避而非失败；整单等待 SHALL 有上限（分钟级、按预估时长放大封顶），超限报「转写排队超时」类可行动错误。订单处理中状态（status 0/3、26605）SHALL 继续轮询不计为失败。外部取消信号 SHALL 在轮询间隙即时生效（中止后续请求与等待，本地任务立即终止）。轮询次数预算 SHALL 低于服务端单订单 100 次查询上限。

#### Scenario: 短音频快速出结果

- **WHEN** 转写一段 taskEstimateTime 为 10 秒级的短音频
- **THEN** 首查在秒级延迟后发起，结果就绪即返回，不做无谓的长间隔等待

#### Scenario: 排队高峰梯度退避

- **WHEN** 订单长时间处于处理中（status 3）且期间返回过 26603 频率受限
- **THEN** 轮询间隔梯度递增并对频控额外退避，直至出结果或触达整单等待上限并报可行动错误

#### Scenario: 取消任务即时中止轮询

- **WHEN** 用户在订单处理中取消任务
- **THEN** 后续轮询与等待立即中止、任务即时结束（服务端订单自然过期，不影响本地状态）

### Requirement: 讯飞结果解析——双层 JSON、wp 属性分流与 10ms 帧换算

讯飞结果解析 SHALL 处理 `orderResult` 双层 JSON 字符串形态（外层 parse 后，`lattice[].json_1best` 为字符串需再 parse；宽容对象形态直取），单句解析失败 SHALL 跳过该句而非整单失败。词级归一 SHALL 按 `wp` 属性分流：`p`（标点，零时长）并入前一词文本、`g`（分段标记）跳过、`n`/`s` 及未知按正常词收；词时间戳 SHALL 按「句 `bg`（字符串毫秒）+ `wb/we`（相对句首的 10ms 帧数）」换算为绝对秒。句级 `st.bg/ed` SHALL 同时映射为段级结果；词级缺失（非中英语种）时 SHALL 以段级降级成句，任务不失败。

#### Scenario: 中文词级路径生成带标点字幕

- **WHEN** 中文视频经讯飞转写返回 lattice 词级结果（wb/we 帧 + wp 标点条目）
- **THEN** 标点并入前词、帧换算为秒，经既有词级成句管线产出多条带标点字幕，风格与其他云服务商一致

#### Scenario: 小语种缺词级时段级兜底

- **WHEN** 某语种响应的 ws 无有效词条目
- **THEN** 以句级 bg/ed 时间戳作段级结果继续成句，任务不失败

#### Scenario: 坏句不失败整单

- **WHEN** lattice 中某条 json_1best 字符串损坏无法解析
- **THEN** 跳过该句并继续解析其余句子，转写结果保留可用部分

### Requirement: 讯飞识别语种由任务原语言映射

讯飞转写 SHALL 把任务「原语言」映射为 upload 的 `language` 参数（zh→cn 且自动中英模式、en/ja/ko/ru/fr/es/vi/ar/de/it 直映、yue→cn_cantonese 且输出简体），`auto` 与未匹配语种 SHALL 回落 `cn` 自动中英模式；文案 SHALL 注明多语种建议显式选择原语言。语种未授权错误（26607）SHALL 报「到讯飞控制台开通对应语种」的可行动提示。

#### Scenario: 原语言选日语自动映射

- **WHEN** 用户任务原语言选择日语并用讯飞实例转写
- **THEN** upload 请求携 `language=ja`，无需用户在服务商配置里另设语种

#### Scenario: 未开通小语种可诊断

- **WHEN** 账号未开通俄语授权而任务以俄语转写（服务端报 26607）
- **THEN** 任务失败信息明确提示到讯飞控制台「方言/语种」处开通，而非笼统失败

### Requirement: 讯飞错误分类与连接自测

讯飞错误处理 SHALL 分类：静音/空音频（failType 6、26606）视为**空结果成功**；频控与偶发（26603、26640、26689、HTTP 429/5xx、网络错误）按退避有限重试；凭据类（26600/26601）、配额类（26625/26633，提示购买或领取免费时长）、语种类（26607）、素材类（26621/26622/26631/26632/26643/26650 及对应 failType）不重试并携官方语义报错；未知码透传 code+descInfo。连接自测 SHALL 优先零消耗探针（假 orderId 调 getResult：返回 26602 判凭据有效；26600/26601 判凭据错误），探针不可行时回退 1 秒静音 WAV 建单探测（建单成功或 failType 6 均判通过）。

#### Scenario: 凭据错误自测可诊断

- **WHEN** 用户填入错误的 secretKey 并测试连接
- **THEN** 自测以明确的「appId/secretKey 无效或签名错误」类结果透出服务端 code 与描述

#### Scenario: 服务时长不足给购买指引

- **WHEN** 转写因账号可用时长不足失败（26625/26633）
- **THEN** 错误信息提示到讯飞产品页购买或领取免费时长，而非笼统的「转写失败」

#### Scenario: 静音切片判空成功

- **WHEN** 某切片为纯静音，服务端报静音文件（failType 6 或 26606）
- **THEN** 该切片按空结果成功处理，整体任务不失败

### Requirement: 引擎左栏两组分区与云条目平级入口

资源页「引擎与模型」左栏 SHALL 分为两个带组标题的分组：「本地引擎」（builtin / fasterWhisper / sherpa 聚合 / localCli，条目样式与行为不变）与「云端听写」。云组 SHALL 渲染**逐条目平级入口**（一条目对应至多一个实例、一张表单）：品牌型类型每类型一条；协议型类型（`multiInstance: true`）SHALL 展开为「每个命名预设一个恒驻槽位条目 + 每个自定义实例一条」；条目为紧凑单行：品牌/预设图标（`iconImg` 优先、emoji `icon` 兜底）+ 显示名（品牌型可用 `shortName` 缩短；预设条目=预设名；自定义条目=实例名）+ 就绪状态点。状态点 SHALL 以「该条目绑定实例已配置」（`isAsrProviderConfigured` 口径）为就绪。云组末尾 SHALL 固定一个「添加自定义」入口（见协议型基数要求）。选中某云条目 SHALL 在右栏直达该条目的配置表单，且右栏 MUST NOT 渲染本地模型清单区。

本要求 MUST NOT 改动：后端引擎 id（恒 `'cloud'`）、`ASR_TRANSCRIBER_MAP` 按实例 `type` 分发、任务页「引擎 ▸ 模型」下拉的实例分组、`store.asrProviders` 既有数据结构与已保存实例（新实例 MAY 附加可选 `presetId` 来源标记）。

#### Scenario: 打开页面即见全部云服务商与预设

- **WHEN** 用户进入「引擎与模型」页
- **THEN** 左栏「云端听写」组下逐一列出 OpenAI、Groq、硅基流动（预设槽位）、ElevenLabs、Deepgram、豆包、腾讯云、阿里云、讯飞、Gladia 等全部条目（带品牌图标），无需展开任何面板即可看到支持哪些平台

#### Scenario: 选中云条目直达其配置

- **WHEN** 用户点击左栏某云条目（如「腾讯云」或「Groq」）
- **THEN** 右栏直接渲染该条目的配置表单（标题 + 就绪徽标），不出现其它服务商的分区列表或实例列表

#### Scenario: 状态点反映条目就绪态

- **WHEN** 某条目绑定的实例已配置
- **THEN** 该条目的左栏状态点为就绪色；条目未绑定实例或实例未配置时为待办色

#### Scenario: 新增类型或预设自动出现在侧栏

- **WHEN** 开发者向 `ASR_PROVIDER_TYPES` 增加一个新服务商类型，或向 `ASR_PROVIDER_PRESETS` 增加一个新预设
- **THEN** 左栏云组自动出现对应条目，无需改动导航代码

#### Scenario: 任务页与存储行为不变

- **WHEN** 用户在任务页选择云实例并转写，或读取已保存的云实例
- **THEN** 「引擎 ▸ 模型」下拉分组、转写分发与存储读写行为与本变更前完全一致

### Requirement: 云视图选中态持久化兼容

左栏选中态持久化（`engineModelSelectedView`）SHALL 支持云条目 id 形态：`cloud:<typeId>`（品牌/孤儿）、`cloud:<typeId>:<presetId>`（预设槽位）、`cloud:<typeId>:i:<instanceId>`（自定义实例）。历史遗留值 `'cloud'` SHALL 平滑迁移：实例数据加载后解析为「首个已配置条目，无则云组首个条目」并写回新格式，MUST NOT 回落 builtin。`cloud:*` 未命中当前条目清单（自定义条目被删、类型下线且无孤儿实例、旧格式 id）时 SHALL 优先回落同类型首个条目，无同类条目再回落 builtin。既有直写 `'builtin'` 的深链跳转（GPU 徽章、新手引导、resources 重定向）行为 MUST 保持不变。

#### Scenario: 旧 'cloud' 选中态平滑接管

- **WHEN** 用户升级前左栏选中「云端听写」（存储值 `'cloud'`），且已配置过 Gladia
- **THEN** 升级后进入页面落在云组的 Gladia 条目（首个已配置条目），而非回落 builtin

#### Scenario: 删除自定义条目后就近回落

- **WHEN** 用户删除当前选中的自定义 OpenAI 兼容实例
- **THEN** 选中态回落到 OpenAI 兼容的首个条目（如 OpenAI 预设槽位），而非跳回本地引擎

#### Scenario: 未知云视图回落

- **WHEN** 存储值为 `cloud:<已下线且无实例的类型>`
- **THEN** 页面回落 builtin 视图，不白屏不报错

### Requirement: 孤儿类型入口兜底

已存实例的 `type` 不在当前 `ASR_PROVIDER_TYPES` 时，左栏云组 SHALL 在已知类型之后为每个孤儿类型追加入口；其右栏 SHALL 至少支持查看实例名与删除实例（无表单、无测试连接），使旧数据不凭空消失。

#### Scenario: 类型下线后实例仍可清理

- **WHEN** 某服务商类型从 `ASR_PROVIDER_TYPES` 移除，但用户仍存有该类型实例
- **THEN** 左栏云组末尾出现该孤儿类型入口，用户可查看并删除这些实例
