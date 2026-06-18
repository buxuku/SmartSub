## ADDED Requirements

### Requirement: 本地 FireRedASR 转写引擎（复用 sherpa-onnx-node 运行时）

系统 SHALL 提供一个本地转写引擎 `fireRedAsr`（FireRedASR-AED-L），其转写运行时 MUST 复用现有 `sherpa-onnx-node` 原生运行时（worker_thread），MUST NOT 引入新的 Python / torch 依赖或新的原生运行时。转写管线 SHALL 为：以 silero VAD 分段 → 逐段 AED decode → 段级时间戳 → 输出 SRT，与 FunASR / Qwen 同构。

#### Scenario: 用 FireRedASR 出 SRT

- **WHEN** 用户对一段音频选择 `fireRedAsr` 引擎并开始转写，且 sherpa 原生库与 FireRedASR 模型均已就绪
- **THEN** 系统经 sherpa-onnx-node 运行时以 VAD 分段 + 逐段解码完成转写
- **AND** 写出带段级时间戳的 SRT 文件

#### Scenario: 不启动 Python sidecar

- **WHEN** `fireRedAsr` 引擎执行转写
- **THEN** 系统 MUST NOT 为 fireRedAsr 启动 Python sidecar（其适配器无 `pyEngineId`）
- **AND** 模型加载与解码在 worker 线程进行，首段即可回报进度，不阻塞主/UI 线程

### Requirement: 引擎可用性以「原生库 + 模型 + 共享 VAD」三就绪为准

`fireRedAsr` 引擎的可用性 SHALL 当且仅当 sherpa 原生库已安装**且** FireRedASR 模型（`encoder` + `decoder` + `tokens.txt`）已落盘**且** silero VAD 已就绪时为 `ready`；任一缺失 MUST 报 `not_installed` 并给出去资源中心安装/下载的引导，MUST NOT 静默视为可用。

#### Scenario: 缺原生库

- **WHEN** sherpa 原生库未下载
- **THEN** `fireRedAsr` 引擎可用性为 `not_installed`，提示去「资源中心 ▸ 引擎」下载 sherpa 运行库

#### Scenario: 缺模型

- **WHEN** sherpa 原生库已装，但 FireRedASR 的 encoder/decoder/tokens 任一缺失，或 silero VAD 缺失
- **THEN** `fireRedAsr` 引擎可用性为 `not_installed`，提示去「资源中心 ▸ 模型」下载 FireRedASR 模型或共享 VAD

### Requirement: FireRedASR 模型的清单、下载与就绪判断

系统 SHALL 提供独立的 FireRedASR 模型清单与下载，模型落盘于 `userData/models/firered/<id>/`，默认档位为 `FireRedASR-AED-L int8`（`encoder.int8.onnx` / `decoder.int8.onnx` / `tokens.txt`）。下载源 MUST 以国内优先回退：ModelScope 官方镜像逐文件 → ghproxy 整包 → github 整包，并复用现有断点续传、独立进程解包与镜像回退。模型就绪判断 MUST 校验三件套齐全 **且** silero VAD 存在。

#### Scenario: 下载默认 FireRedASR 模型（ModelScope 优先）

- **WHEN** 用户在资源中心下载 FireRedASR 模型且选择默认/国内源
- **THEN** 系统优先从 ModelScope 官方镜像逐文件下载 encoder/decoder/tokens 至 `userData/models/firered/<id>/`
- **AND** 该源失败时按顺序回退 ghproxy → github 整包（tar.bz2，解包时 strip 顶层目录并过滤 test_wavs）
- **AND** 校验三件套齐全后标记为已安装

#### Scenario: 复用 silero VAD

- **WHEN** 系统判断 fireRedAsr 模型是否就绪
- **THEN** 除三件套外 MUST 校验 silero VAD 模型存在（复用 FunASR 的同一 VAD 文件）
- **AND** 缺 VAD 时引导用户下载

#### Scenario: 下载前体积二次确认

- **WHEN** 用户触发 FireRedASR 模型下载
- **THEN** 系统 MUST 先以二次确认提示模型体积（约 1.7GB）后再开始下载

### Requirement: FireRedASR-AED 段长安全闸

鉴于 FireRedASR-AED 仅支持 ≤60s 输入（>60s 易幻觉、>200s 触发位置编码错误），`fireRedAsr` 引擎 SHALL NOT 沿用「最大语音时长 0=不限制」的约定。系统 MUST 为 fireRedAsr 设定有限的 VAD 最大段长默认值（30 秒），并 MUST 将实际生效的最大段长硬钳制为不超过 60 秒。

#### Scenario: 默认有限段长

- **WHEN** 用户未自定义最大语音时长而使用 fireRedAsr
- **THEN** VAD 最大段长生效为 30 秒（而非不限制）

#### Scenario: 硬上限钳制

- **WHEN** 用户把最大语音时长设为大于 60 秒（或 0=不限制）
- **THEN** 系统 MUST 将 fireRedAsr 实际生效的最大段长钳制为不超过 60 秒，以避免长段幻觉与位置编码错误

### Requirement: 逐任务可选并接入并发钳制

`fireRedAsr` 引擎 SHALL 作为「引擎 ▸ 模型」分组选择器中的一个分组，仅在其运行时（sherpa 原生库）、模型与共享 VAD 均就绪时其模型才可被任务选中。当任务队列中含 `fireRedAsr` 任务时，系统 MUST 将相关并发上限钳制为 1（共享单 worker + AED 解码重，避免 CPU/内存争用），与 faster-whisper / funasr / qwen 同等对待。

#### Scenario: 就绪后可在任务中选用

- **WHEN** sherpa 库、fireRedAsr 模型与共享 VAD 均就绪
- **THEN** 任务页「引擎 ▸ 模型」选择器出现 FireRedASR 分组及其已装模型，可被选中执行

#### Scenario: 含 fireRedAsr 任务时钳为 1

- **WHEN** 任务队列中存在 `fireRedAsr` 任务
- **THEN** 有效并发上限被钳制为 1

### Requirement: 本期交付范围（AED-L · int8 · 仅 CPU · 段级时间戳）

本期 `fireRedAsr` 引擎 SHALL 默认且仅交付 FireRedASR-AED-L int8、仅 CPU 设备、段级时间戳。系统 MUST NOT 在本期暴露 GPU/fp16 设备选项、FireRedASR-LLM 档位或词级时间戳；这些为后续项。系统 MUST NOT 暴露 language/ITN 选择（FireRedASR 内部处理中英）。

#### Scenario: 设备固定 CPU

- **WHEN** 用户查看 fireRedAsr 引擎的设备选项
- **THEN** 设备为 CPU（不提供 GPU/fp16 选项）

#### Scenario: 段级而非词级时间戳

- **WHEN** fireRedAsr 引擎产出字幕
- **THEN** 时间戳为 VAD 段级（每段一个 start/end），不含词级时间戳

### Requirement: 取消、进度与运行时失败回退

`fireRedAsr` 引擎 SHALL 支持与 faster-whisper / funasr / qwen 一致的取消（AbortSignal → 通知 worker 逐段取消并映射 `TaskCancelledError`）与进度回报（已处理样本/总样本）。当 sherpa 运行时缺失或加载/解码失败时，系统 SHALL 以明确错误结束该任务，并保留改选内置 whisper.cpp 的保底路径。

#### Scenario: 取消进行中的 fireRedAsr 转写

- **WHEN** 用户取消一个正在执行的 fireRedAsr 任务
- **THEN** worker 在段间尽快停止并返回取消语义，任务被标记为已取消而非转写错误

#### Scenario: 运行时失败可回退保底引擎

- **WHEN** sherpa 运行时加载或解码失败
- **THEN** 任务以可读错误结束，且用户可改用内置 whisper.cpp 完成转写（应用始终能出字幕）
