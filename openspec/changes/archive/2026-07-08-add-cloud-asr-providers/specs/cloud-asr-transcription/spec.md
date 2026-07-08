## ADDED Requirements

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
