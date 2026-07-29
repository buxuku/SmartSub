## MODIFIED Requirements

### Requirement: 参考文本获取

参考文本获取 SHALL 按三级回退：字幕预填（素材来自带字幕的最近任务）→ ASR 自动转写 → 手动输入。ASR 自动转写的本地探测 SHALL 按固定窄级联顺序尝试已就绪引擎，再回落云端，再手动：

1. 本地 FunASR（优先 SenseVoice，否则其它已装 FunASR ASR 模型）
2. 本地 faster-whisper（运行时已安装且至少有一个 CT2 模型；优先最小档已装模型）
3. 本地内置 whisper.cpp（至少有一个 ggml 模型；优先最小档已装模型）
4. 用户已配置且可用的云端 ASR 服务商（取第一个就绪实例）

转写实现 MUST 对选区短音频做轻量 `wav→text`（不得经任务转写管线写 SRT / 发任务进度）。本地 sherpa 与 faster-whisper 尝试 MUST 遵守既有转写并发闸门；请求 MUST 可经 AbortSignal 取消。成功时 MUST 返回真实引擎展示名供向导展示。转写不可用 MUST 降级为手动输入并说明原因（文案 MUST 点明探测范围为 SenseVoice / Whisper / 云 ASR，不得暗示本机无任何转写能力），不得阻断向导。任何来源的文本 MUST 允许用户编辑校对后再提交。

#### Scenario: 本地 SenseVoice 优先于云

- **WHEN** 用户已安装 SenseVoice 且配置了云 ASR 服务商
- **THEN** 选区转写走 SenseVoice（免费、不出网），云服务商不被调用

#### Scenario: SenseVoice 不可用时回落 faster-whisper

- **WHEN** FunASR 模型未就绪，但 faster-whisper 运行时与 CT2 模型已就绪
- **THEN** 选区转写走 faster-whisper，向导展示对应引擎名

#### Scenario: 仅有内置 ggml 时回落 whisper.cpp

- **WHEN** FunASR 与 faster-whisper 均不可用，但已安装 ggml 模型
- **THEN** 选区转写走内置 whisper.cpp（选用启发式最小已装模型）

#### Scenario: 本地全不可用时回落云 ASR

- **WHEN** 窄级联本地候选均不可用或失败，且用户已配置可用云 ASR
- **THEN** 选区转写走云 ASR

#### Scenario: 无 ASR 降级与文案

- **WHEN** 窄级联本地与云 ASR 均不可用
- **THEN** 第③步提示需手动输入参考文本，文案说明需 SenseVoice、Whisper（faster-whisper 或内置）或已配置云 ASR，并提供选区重听按钮辅助听写
