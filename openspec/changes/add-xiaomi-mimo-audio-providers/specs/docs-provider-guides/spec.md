# docs-provider-guides Specification (Delta)

## ADDED Requirements

### Requirement: Xiaomi MiMo 音频服务指南

文档站 SHALL 分别提供 Xiaomi MiMo ASR 与基础 TTS 的独立配置指南，并从对应选型总览链接。两页 SHALL 说明 API Key 与按量/Token Plan Base URL 的匹配规则、应用字段、真实计费状态和能力限制；截图 MUST 不含真实凭据。

#### Scenario: 用户理解 ASR 费用与时间轴限制

- **WHEN** 用户阅读 MiMo ASR 指南
- **THEN** 页面说明国内按量价格 0.5 元/小时、公开资料未承诺免费额度，并说明输出为约 20 秒分片构成的粗粒度时间轴

#### Scenario: 用户理解基础 TTS 范围

- **WHEN** 用户阅读 MiMo TTS 指南
- **THEN** 页面说明基础模型当前限时免费且未公布结束日期，并列出八个固定音色以及不包含流式、音色设计、音色复刻和风格指令
