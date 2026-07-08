# speech-boundary-detection Specification

## Purpose

TBD - created by archiving change builtin-subtitle-timeline-0fork. Update Purpose after archive.

## Requirements

### Requirement: 可插拔语音边界源（Silero 主 / 能量兜底 / 降级）

系统 SHALL 提供一个语音边界源，对一个 16kHz / 单声道 / PCM16 的 WAV 返回语音段列表 `[{start, end}]`（秒）。它 SHALL 优先使用 Silero VAD（经 sherpa-onnx，随安装包内置）；当 sherpa 原生库不可用（如开发机未 `yarn sherpa:fetch`、或加载失败）时 SHALL 回退到能量阈值法（复用 PR #341 的 `analyzePcm16WavEnergy`）；当两者都不可用时 SHALL 返回空集合并由调用方优雅降级，MUST NOT 抛错。

#### Scenario: sherpa 可用时使用 Silero VAD

- **WHEN** sherpa-onnx 原生库可用，且传入可解析的 PCM16 WAV
- **THEN** 返回由 Silero VAD 判定的语音段列表

#### Scenario: sherpa 不可用时回退能量法

- **WHEN** sherpa-onnx 原生库不可用，但音频可按 PCM16 WAV 解析
- **THEN** 返回由能量阈值法（RMS dB）判定的语音段列表

#### Scenario: 两者均不可用时返回空并降级

- **WHEN** sherpa 不可用且音频无法按 PCM16 解析
- **THEN** 返回空集合且不抛错，由调用方退回原始（未贴齐）时间轴

### Requirement: sherpa「只跑 VAD」入口零额外依赖

sherpa worker SHALL 提供一个「只跑 VAD」入口：仅加载内置的 `silero_vad.onnx`，对 WAV 跑 Silero VAD 并返回语音段，MUST NOT 加载任何 ASR 识别器，且 MUST NOT 触发任何模型下载（VAD 模型随安装包内置，与 funasr/qwen/fireRed 共用同一份）。

#### Scenario: 无任何 ASR 模型也能取得语音段

- **WHEN** 用户从未安装 FunASR / Qwen / FireRed 的 ASR 模型，调用「只跑 VAD」入口
- **THEN** 仍能仅凭内置 `silero_vad.onnx` 返回语音段

#### Scenario: VAD-only 不触发下载

- **WHEN** 调用「只跑 VAD」入口
- **THEN** 不发起任何网络下载，直接使用随包内置的 VAD 模型
