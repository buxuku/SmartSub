---
sidebar_position: 5
title: ElevenLabs Scribe
description: 在妙幕中配置 ElevenLabs Scribe v3 或 v2，将音频和视频文件转写为带时间轴的字幕。
keywords: [ElevenLabs, Scribe, 语音转文字, 多语种转写, scribe_v3, scribe_v2]
---

# ElevenLabs Scribe

<ProviderMeta
  website="https://elevenlabs.io/"
  websiteLabel="elevenlabs.io"
  credentials="API Key"
  freeTier="免费计划含少量转写额度"
  pricing="按订阅套餐 / 用量计费"
  bestFor="多语种内容；已订阅 ElevenLabs（配音 / 克隆）的用户复用同一账号"
/>

Scribe v3 支持 90 多种语言。转写录音或视频时，妙幕使用模型返回的词级时间戳断句，生成带时间轴的字幕。

## 申请步骤

1. 注册 [ElevenLabs](https://elevenlabs.io/)（免费计划即可开始）
2. 头像菜单 → **API Keys** → 创建密钥（`sk_` 开头）

## 在妙幕中配置

打开「引擎」页面，在「云端听写」分组选「ElevenLabs」。

<div className="img-container">
  <img src="/img/v3/cloud-asr/elevenlabs.webp" alt="ElevenLabs Scribe 云端听写配置表单" />
</div>

| 字段     | 填写                                              |
| -------- | ------------------------------------------------- |
| API Key  | 上一步创建的密钥                                  |
| 模型     | 新配置默认勾选 `scribe_v3`，也可选择 `scribe_v2`  |
| Base url | 默认 `https://api.elevenlabs.io/v1`，一般无需修改 |

点击「**测试连接**」检查密钥。升级前已配置 ElevenLabs 的用户会保留原有模型选择。要改用 v3，在此处勾选 `scribe_v3`，然后在听写任务中选择该模型。

## 常见问题

- **额度怎么算**：转写消耗账户的用量额度（与 TTS 共享账户体系），免费计划额度有限，批量任务建议付费计划
- **同账号还能做什么**：[ElevenLabs 配音与即时声音克隆](/guides/tts/elevenlabs)
- **401 报错**：确认 Key 有效且账户未欠费

---

> 信息更新于 2026-11，模型与定价以 [ElevenLabs 官网](https://elevenlabs.io/pricing) 为准；[语音转文字模型说明](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)。
