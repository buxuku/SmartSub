## ADDED Requirements

### Requirement: Qwen3-ASR 的 VAD 单段时长受安全闸限制

系统 SHALL 在把 VAD 参数交给 sherpa-onnx 之前，把 Qwen3-ASR 的「最长语音」收敛到安全范围：未设置、为 0、非数值或为负数时 MUST 取 15 秒；大于 20 秒时 MUST 取 20 秒；位于 (0, 20] 内的值 MUST 原样采用。Qwen3-ASR MUST NOT 把「不限制」传给 VAD。预热与正式转写 MUST 使用同一个收敛结果，使预热出来的 VAD 实例能被正式转写复用。FunASR、FireRedASR、Parakeet 的段长行为 MUST 保持不变。

#### Scenario: 默认设置下段长不再不限

- **WHEN** 用户用默认设置（「最长语音」为 0）运行 Qwen3-ASR
- **THEN** 传给 sherpa VAD 的最大语音时长为 15 秒，而不是 100000 秒

#### Scenario: 合理的显式值原样生效

- **WHEN** 用户在「手动调节」里把「最长语音」设为 12 秒或 20 秒
- **THEN** 传给 sherpa VAD 的最大语音时长分别为 12 秒与 20 秒

#### Scenario: 超过上限的显式值被收敛

- **WHEN** 「最长语音」被设为 25 秒或 60 秒
- **THEN** 传给 sherpa VAD 的最大语音时长为 20 秒

#### Scenario: 其他 sherpa 引擎不受影响

- **WHEN** 同样的设置用于 FunASR 或 Parakeet
- **THEN** 它们仍按「0 = 不限制」的约定传值；FireRedASR 仍按其既有的段长闸处理

### Requirement: 超出解码预算的 VAD 段在日志中告警

Qwen3-ASR 转写完成后，系统 SHALL 按实际生效的 `max_total_len` 与 `max_new_tokens` 估算每个 VAD 段解码所需的 token 数：提示词约 15，音频每秒 13，再加满额生成预留 `max_new_tokens`。估算值超过 `max_total_len` 的段 MUST 汇总成一条 warning 日志，内容包含超限段数、总段数、最长超限段的起止时间与估算 token 数，以及当前预算下能放下的最长秒数。该告警 MUST NOT 改变转写结果、字幕内容或任务状态。没有 VAD 段信息，或没有任何段超限时，MUST NOT 记录告警。

#### Scenario: 超预算的段记一条 warning

- **WHEN** 一次转写返回了一个 45 秒的 VAD 段，预算为默认的 512 / 128
- **THEN** 日志里出现一条 warning，说明 1 个段超出解码预算并给出该段的起止时间；字幕产出与没有该告警时一致

#### Scenario: 预算足够时不告警

- **WHEN** 同一个 45 秒的段在 `qwenMaxTotalLen=1024`、`qwenMaxNewTokens=256` 下转写
- **THEN** 不记录告警

#### Scenario: 没有 VAD 段信息时静默

- **WHEN** 转写结果里没有 VAD 段信息
- **THEN** 不记录告警，也不报错

### Requirement: 提示文案与文档如实说明段长约定

设置页「最大语音持续时间」的提示文字 SHALL 说明「0 表示无限制」不适用于 Qwen3-ASR 与 FireRedASR：Qwen3-ASR 取 0 时按 15 秒、最多 20 秒；FireRedASR 最多 60 秒。Qwen3-ASR 引擎文档 SHALL 说明长段被截断的现象、安全闸，以及在「更多设置 › 专家」的「手动调节」里调小「最长语音」的办法。

#### Scenario: 用户在设置页看到例外说明

- **WHEN** 用户在设置页悬停「最大语音持续时间」的提示
- **THEN** 提示在「0 表示无限制」之外，注明 Qwen3-ASR 与 FireRedASR 的例外

#### Scenario: 用户读到 Qwen3-ASR 文档

- **WHEN** 用户遇到长连续语音只输出 `language` 或丢内容，翻开 Qwen3-ASR 引擎文档的常见问题
- **THEN** 能看到原因、妙幕已做的限制，以及手动调小「最长语音」的步骤
