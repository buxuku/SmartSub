## ADDED Requirements

### Requirement: 本地 Qwen3-ASR 转写引擎（复用 sherpa-onnx-node 运行时）

系统 SHALL 提供一个本地转写引擎 `qwen`（Qwen3-ASR），其转写运行时 MUST 复用现有 `sherpa-onnx-node` 原生运行时（worker_thread），MUST NOT 引入新的 Python / torch 依赖或新的原生运行时。转写管线 SHALL 为：以 silero VAD 分段 → 逐段自回归 decode → 段级时间戳 → 输出 SRT，与 FunASR 同构。

#### Scenario: 用 Qwen3-ASR 出 SRT

- **WHEN** 用户对一段音频选择 `qwen` 引擎并开始转写，且 sherpa 原生库与 qwen 模型均已就绪
- **THEN** 系统经 sherpa-onnx-node 运行时以 VAD 分段 + 逐段解码完成转写
- **AND** 写出带段级时间戳的 SRT 文件

#### Scenario: 不启动 Python sidecar

- **WHEN** `qwen` 引擎执行转写
- **THEN** 系统 MUST NOT 为 qwen 启动 Python sidecar（qwen 适配器无 `pyEngineId`）
- **AND** 模型加载与解码在 worker 线程进行，首段即可回报进度，不阻塞主/UI 线程

### Requirement: 引擎可用性以「原生库 + 模型」双就绪为准

`qwen` 引擎的可用性 SHALL 当且仅当 sherpa 原生库已安装**且** Qwen3-ASR 模型（四件套 + silero VAD）已落盘时为 `ready`；任一缺失 MUST 报 `not_installed` 并给出去资源中心安装/下载的引导，MUST NOT 静默视为可用。

#### Scenario: 缺原生库

- **WHEN** sherpa 原生库未下载
- **THEN** `qwen` 引擎可用性为 `not_installed`，提示去「资源中心 ▸ 引擎」下载 sherpa 运行库

#### Scenario: 缺模型

- **WHEN** sherpa 原生库已装，但 Qwen3-ASR 模型四件套或 silero VAD 缺失
- **THEN** `qwen` 引擎可用性为 `not_installed`，提示去「资源中心 ▸ 模型」下载 Qwen3-ASR 模型

### Requirement: Qwen3-ASR 模型的清单、下载与就绪判断

系统 SHALL 提供独立的 Qwen3-ASR 模型清单与下载，模型落盘于 `userData/models/qwen/<id>/`，默认档位为 `Qwen3-ASR-0.6B int8`（四件套：`conv_frontend.onnx` / `encoder.int8.onnx` / `decoder.int8.onnx` / `tokenizer/`）。下载 MUST 复用现有镜像回退、断点续传与 SHA256 校验。模型就绪判断 MUST 校验四件套齐全 **且** silero VAD 存在。

#### Scenario: 下载默认 0.6B 模型

- **WHEN** 用户在资源中心下载 Qwen3-ASR-0.6B 模型
- **THEN** 系统按镜像回退顺序下载四件套至 `userData/models/qwen/<id>/`，校验通过后标记为已安装

#### Scenario: 复用 silero VAD

- **WHEN** 系统判断 qwen 模型是否就绪
- **THEN** 除四件套外 MUST 校验 silero VAD 模型存在（复用 FunASR 的同一 VAD 文件）
- **AND** 缺 VAD 时引导用户下载

### Requirement: 逐任务可选并接入并发钳制

`qwen` 引擎 SHALL 作为「引擎 ▸ 模型」分组选择器中的一个分组，仅在其运行时（sherpa 原生库）与模型均就绪时其模型才可被任务选中。当任务队列中含 `qwen` 任务时，系统 MUST 将相关并发上限钳制为 1（自回归 + 单 worker，避免 CPU/内存争用），与 faster-whisper / funasr 同等对待。

#### Scenario: 就绪后可在任务中选用

- **WHEN** sherpa 库与 qwen 模型均就绪
- **THEN** 任务页「引擎 ▸ 模型」选择器出现 Qwen 分组及其已装模型，可被选中执行

#### Scenario: 含 qwen 任务时钳为 1

- **WHEN** 任务队列中存在 `qwen` 任务
- **THEN** 有效并发上限被钳制为 1

### Requirement: 本期交付范围（0.6B · 仅 CPU · 段级时间戳）

本期 `qwen` 引擎 SHALL 默认且仅交付 Qwen3-ASR-0.6B、仅 CPU 设备、段级时间戳。系统 MUST NOT 在本期暴露 GPU 设备选项或词级时间戳；1.7B 档位与 GPU 加速、Qwen3-ForcedAligner 词级对齐为后续项。

#### Scenario: 设备固定 CPU

- **WHEN** 用户查看 qwen 引擎的设备选项
- **THEN** 设备为 CPU（不提供 GPU 选项）

#### Scenario: 段级而非词级时间戳

- **WHEN** qwen 引擎产出字幕
- **THEN** 时间戳为 VAD 段级（每段一个 start/end），不含词级时间戳

### Requirement: 取消、进度与运行时失败回退

`qwen` 引擎 SHALL 支持与 faster-whisper / funasr 一致的取消（AbortSignal → 通知 worker 逐段取消并映射 `TaskCancelledError`）与进度回报（已处理样本/总样本）。当 sherpa 运行时缺失或加载/解码失败时，系统 SHALL 以明确错误结束该任务，并保留改选内置 whisper.cpp 的保底路径。

#### Scenario: 取消进行中的 qwen 转写

- **WHEN** 用户取消一个正在执行的 qwen 任务
- **THEN** worker 在段间尽快停止并返回取消语义，任务被标记为已取消而非转写错误

#### Scenario: 运行时失败可回退保底引擎

- **WHEN** sherpa 运行时加载或解码失败
- **THEN** 任务以可读错误结束，且用户可改用内置 whisper.cpp 完成转写（应用始终能出字幕）
