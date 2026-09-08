# tts-cloud-providers Specification (Delta)

## ADDED Requirements

### Requirement: Xiaomi MiMo 基础 TTS 服务商

系统 SHALL 提供品牌型硬单例 `xiaomiMimo`，固定使用 `mimo-v2.5-tts` 经 Chat Completions 合成。目标文本 SHALL 放入 assistant 消息，`audio.format` SHALL 为 `wav`，并 SHALL 只内置冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean 八个确定音色。基础接入 MUST NOT 发送自然语言风格指令、暴露 VoiceDesign/VoiceClone 模型或启用流式响应。

#### Scenario: 基础音色合成

- **WHEN** 用户选择冰糖并合成中文文本
- **THEN** 请求只包含固定基础模型、assistant 文本、WAV 格式与冰糖音色，响应音频成功写入目标 WAV

#### Scenario: 输出统一为配音管线合同

- **WHEN** MiMo 返回可解析的 WAV
- **THEN** 系统校验 WAV 后统一转为 24kHz、单声道、PCM16，返回准确时长

#### Scenario: 全局语速以后处理兑现

- **WHEN** 工作台全局语速为 1.25 倍
- **THEN** MiMo 请求不携带不存在的数值 speed 参数，响应归一化后以 atempo 应用 1.25 倍，再进入既有槽位复测

#### Scenario: 合成错误不自动重试

- **WHEN** MiMo TTS 返回 HTTP 错误
- **THEN** 系统显示服务端错误详情且只发起一次合成请求

### Requirement: 云端 TTS 请求间隔

云端 TTS 实例 SHALL 可声明 `requestInterval` 作为跨任务共享闸门的最小请求起始间隔。MiMo 默认 SHALL 为 0.7 秒；未声明该字段的既有服务商 SHALL 回落 0 秒以保持现有行为。

#### Scenario: MiMo 批量合成节流

- **WHEN** 同一 MiMo 实例批量合成多条字幕
- **THEN** 请求仍遵守并发 2，且相邻请求起始时间至少间隔配置值
