# cloud-asr-transcription Specification (Delta)

## ADDED Requirements

### Requirement: Xiaomi MiMo ASR 服务商

系统 SHALL 提供品牌型硬单例 `xiaomiMimo`，使用 `mimo-v2.5-asr` 经 Chat Completions `input_audio` 调用。配置 SHALL 包含 API Key、Base URL、固定模型、超时、并发和请求间隔；默认并发为 2、间隔 0.7 秒。Base URL SHALL 同时接受按量端点、Token Plan 专属端点和误粘的完整 `/chat/completions` 地址。音频 SHALL 仅以 WAV/MP3 Base64 上传，原始文件安全上限为 7MiB。

#### Scenario: 按量 API Key 转写中文分片

- **WHEN** 用户配置按量 Base URL 与有效 API Key，以 `zh-CN` 转写 WAV 分片
- **THEN** 请求发送至规范化的 `/chat/completions`，语言参数为 `zh`，文本取自 `choices[0].message.content`

#### Scenario: 不支持的明确语言在上传前失败

- **WHEN** 任务明确选择日语等 MiMo ASR 不支持的语言
- **THEN** 系统在发起网络请求前说明只支持中文、英文或自动检测

#### Scenario: 瞬时失败有限重试且可取消

- **WHEN** 请求遇到网络错误或 HTTP 429/500/503
- **THEN** 最多退避重试两次；取消信号触发后停止等待与请求并进入既有取消语义

## MODIFIED Requirements

### Requirement: 无词级时间戳模型的降级

当服务商类型明确声明 `timestampMode='none'` 时，系统 SHALL 在整文件音频准备和首次转写请求之前，直接按静音切为最长约 20 秒的分片并转写，以分片边界生成粗粒度时间轴；MUST NOT 先转写整文件再重复转写分片。动态能力端点仍 SHALL 保持现有“先请求时间戳、缺失后降级”行为。模型选择器 SHALL 标注“粗粒度时间轴”，且 MUST NOT 改变持久化模型 ID。

#### Scenario: MiMo 不产生重复整文件请求

- **WHEN** 使用 MiMo ASR 转写小于全局上传上限的普通音频
- **THEN** 首批网络请求直接对应 20 秒静音分片，不存在先行的整文件转写请求

#### Scenario: 既有动态端点保持原行为

- **WHEN** 使用未声明 `timestampMode='none'` 的现有 ASR 服务商
- **THEN** 系统仍先走既有整文件准备和时间戳探测路径
