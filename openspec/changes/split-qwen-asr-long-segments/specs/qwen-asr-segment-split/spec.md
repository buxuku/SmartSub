## ADDED Requirements

### Requirement: worker 把超过上限的 VAD 段按最安静处切成多片

当请求带有正数 `segment_hard_max_s` 时，sherpa worker SHALL 在 VAD 出段之后、创建识别 stream 之前，检查每个段的时长 d。d 不超过上限 L 时 MUST 原样解码，不做任何处理。d 超过 L 时，worker MUST 把该段切成 n = ceil(d / (L − 2r)) 片，其中 r = min(2 秒, L / 6)。每片 MUST NOT 超过 L；各片首尾相接、合起来恰好覆盖原段，MUST NOT 丢弃任何样本。第 k 个切点（k = 1 … n − 1）MUST 取理想位置 k·d/n 前后 r 秒内、以 20 ms 为一帧并做三帧能量平滑后能量最低的那一帧的中心；能量并列时 MUST 取离理想位置最近的一帧。请求里的 `segment_hard_max_s` 缺省、为 0、为负数、小于 1 秒或不是有限数值时，worker 的行为 MUST 与没有这个功能时一致。

#### Scenario: 不超过上限的段不动

- **WHEN** 上限为 20 秒，VAD 给出一个 19.9 秒的段和一个恰好 20 秒的段
- **THEN** 两个段都只解码一次，起止时间不变

#### Scenario: 超长段切成不超过上限的几片

- **WHEN** 上限为 20 秒，VAD 给出一个从 10 秒开始、长 56 秒的段
- **THEN** 该段被切成 4 片，每片不超过 20 秒，首片起点为 10 秒、末片终点为 66 秒，相邻两片首尾相接，没有样本被丢弃

#### Scenario: 切点落在更安静的地方

- **WHEN** 一个 56 秒的段在理想切点（14、28、42 秒）前后 2 秒内各有一处明显更安静的位置
- **THEN** 三个切点分别落在这些最安静的位置，而不是理想位置

#### Scenario: 平坦信号等分

- **WHEN** 一个超长段整段能量完全相同（例如全零）
- **THEN** 切点就落在理想的等分位置

#### Scenario: 上限较小时切点次序不颠倒

- **WHEN** 上限为 8.6 秒，VAD 给出时长在 10 秒到 40 秒之间的各种段
- **THEN** 每个段的切点严格递增，每片非空且不超过 8.6 秒

#### Scenario: 参数缺省时与现在一致

- **WHEN** 请求不带 `segment_hard_max_s`，或它为 0、负数、小于 1 秒、NaN
- **THEN** 无论段多长都只解码一次，`done` 消息里没有被切开的段

### Requirement: 每一片独立解码并如实回报

被切开的每一片 SHALL 使用各自的识别 stream 解码；有文本的片各产出一个 cue，起止时间是该片在整段音频里的绝对秒数，各 cue 的时间不重叠。`done` 消息里的 `vadSegments` SHALL 列出实际送去解码的片，未被切开的段原样列出。`done` 消息 SHALL 新增 `splits` 数组，每个被切开的原 VAD 段一项，包含原段的起止秒数与片数；没有段被切开时为空数组。取消请求 SHALL 在片与片之间生效，取消后 MUST NOT 再解码后面的片。进度里已处理的秒数 SHALL 随片递增。

#### Scenario: 切开后的 cue 时间连续

- **WHEN** 56 秒的段被切成 4 片，4 片都识别出文本
- **THEN** 回报 4 个 cue，第 k 个 cue 的终点等于第 k + 1 个 cue 的起点，全部落在原段的范围内

#### Scenario: 片间取消

- **WHEN** 第 2 片解码结束后收到取消请求
- **THEN** 第 3、4 片不再解码，worker 回报已取消

#### Scenario: 空文本的片

- **WHEN** 某一片识别出空文本
- **THEN** 该片不产出 cue，但仍列在 `vadSegments` 里

#### Scenario: 回报被切开的段

- **WHEN** 一个 56 秒的段被切成 4 片
- **THEN** `splits` 里有一项，写明该段的起止秒数和片数 4

### Requirement: Qwen3-ASR 按解码预算启用硬切分

`buildQwenParams` SHALL 给出 `segment_hard_max_s`，取 20 秒与当前预算能容纳的最长秒数中的较小者，且不小于 1 秒。预算能容纳的最长秒数与前一个变更的超预算告警是同一个口径：`max_total_len` 减去约 15 个提示词 token 与 `max_new_tokens` 之后，按每秒 13 个音频 token 折算，向下取整到 0.1 秒，不为负。预热与正式转写 MUST 得到同一个值。FunASR、FireRedASR、Parakeet 的请求 MUST NOT 带这个参数。

转写完成后，若 worker 回报有被切开的段，引擎 SHALL 记一条 info 日志，包含被切段数、最长被切段的起止与片数，并提示在没有停顿的音频里切点可能落在词中。前一个变更的超预算告警 SHALL 按 worker 实际解码的片计算；切分生效且预算为默认值时，MUST NOT 因被切开的段而记 warning。没有段被切开时 MUST NOT 记这条 info。

#### Scenario: 默认预算下的参数

- **WHEN** 用户用默认设置运行 Qwen3-ASR
- **THEN** 传给 worker 的 `segment_hard_max_s` 为 20

#### Scenario: 预算调小时上限随之收紧

- **WHEN** `qwenMaxTotalLen` 为 256、`qwenMaxNewTokens` 为 128
- **THEN** `segment_hard_max_s` 为 8.6

#### Scenario: 预算放不下 1 秒时取 1 秒

- **WHEN** `qwenMaxTotalLen` 为 100、`qwenMaxNewTokens` 为 128
- **THEN** `segment_hard_max_s` 为 1

#### Scenario: 其他引擎不受影响

- **WHEN** 同样的设置用于 FunASR、FireRedASR 或 Parakeet
- **THEN** 它们的 worker 请求里没有 `segment_hard_max_s`

#### Scenario: 切开的段只记 info，不记 warning

- **WHEN** 一次转写里有一个 56 秒的 VAD 段被切成 4 片，预算为默认的 512 / 128
- **THEN** 日志里有一条 info，说明切了 1 个段；没有超预算 warning

#### Scenario: 切分没生效时告警仍然兜底

- **WHEN** worker 回报的 `vadSegments` 里仍有一个 45 秒的片（例如参数没有传到 worker）
- **THEN** 前一个变更的超预算 warning 照常记录

### Requirement: 文档如实说明硬切分

Qwen3-ASR 引擎文档的常见问题 SHALL 说明：超过 20 秒的语音段会在最安静处被切开，每片单独识别；有停顿时切点落在停顿里，没有停顿的音频里切点可能落在词中；日志里会有一条 info 说明切了几段。文档 MUST NOT 把硬切分写成彻底解决；没有真实模型验证之前，也 MUST NOT 声称识别质量不受影响。

#### Scenario: 用户读到 Qwen3-ASR 文档

- **WHEN** 用户遇到长连续讲话丢内容，翻开 Qwen3-ASR 引擎文档的常见问题
- **THEN** 能看到妙幕如何切分、切点可能落在词中，以及可以先调小「最长语音」，让 VAD 尽量在停顿处切开
