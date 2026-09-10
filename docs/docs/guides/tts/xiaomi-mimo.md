---
sidebar_position: 9
title: Xiaomi MiMo 语音合成
description: 妙幕 Xiaomi MiMo TTS 配置指南：mimo-v2.5-tts 限时免费状态、8 个中英文预置音色、API Key 与 Token Plan 端点配置。
keywords: [Xiaomi MiMo TTS, 小米语音合成, mimo-v2.5-tts, AI 配音, 免费 TTS]
---

# Xiaomi MiMo 语音合成

<ProviderMeta
  website="https://mimo.mi.com/"
  websiteLabel="MiMo 开放平台"
  credentials="API Key"
  freeTier="mimo-v2.5-tts 当前限时免费"
  pricing="未公布免费结束时间与后续单价"
  bestFor="中文与英文基础音色配音；希望与 MiMo 听写共用平台"
/>

MiMo 基础语音合成提供 8 个固定的中英文预置音色。妙幕请求非流式 WAV，并统一转换成 24kHz、单声道、16-bit PCM，直接进入现有字幕时间轴对齐与导出流程。

:::tip 当前计费状态
官方文档将 `mimo-v2.5-tts` 标为**限时免费**，但未公布结束日期、免费额度上限或后续单价。请以 MiMo 控制台的最新说明与用量记录为准。
:::

## 申请步骤

1. 登录 [MiMo 开放平台](https://mimo.mi.com/)
2. 在控制台创建按量 API Key；普通按量 Key 通常以 `sk-` 开头
3. 如购买 Token Plan，请同时记录专属 Base URL；`tp-` Key 不能与按量端点混用

## 在妙幕中配置

「音色」页面 → 在线服务选「MiMo TTS」：

<div className="img-container">
  <img src="/img/v3/tts/xiaomi-mimo.webp" alt="Xiaomi MiMo 语音合成配置表单，API Key 字段为空" />
</div>

| 字段     | 填写                                                                 |
| -------- | -------------------------------------------------------------------- |
| API Key  | 控制台创建的 `sk-` 或 `tp-` Key                                      |
| 模型     | 固定为 `mimo-v2.5-tts`                                               |
| 音色候选 | 默认预填 8 个固定音色，可按需删减                                    |
| Base url | 按量 Key 使用 `https://api.xiaomimimo.com/v1`；Token Plan 填专属 URL |
| 请求超时 | 默认 60 秒                                                           |
| 并发数   | 默认 2                                                               |
| 请求间隔 | 默认 0.7 秒，降低触发限流的概率                                      |

点「**测试连接**」会真实合成一句短文本；通过后即可在配音工作台选择该服务。

## 预置音色

| 音色  | 语言 | 性别 |
| ----- | ---- | ---- |
| 冰糖  | 中文 | 女声 |
| 茉莉  | 中文 | 女声 |
| 苏打  | 中文 | 男声 |
| 白桦  | 中文 | 男声 |
| Mia   | 英文 | 女声 |
| Chloe | 英文 | 女声 |
| Milo  | 英文 | 男声 |
| Dean  | 英文 | 男声 |

妙幕没有预填 `mimo_default`，因为它在中国集群映射为冰糖，在其它集群映射为 Mia，无法保证配置在不同端点上得到同一音色。

## 本次接入范围

- 支持：`mimo-v2.5-tts`、8 个预置音色、非流式 WAV、任务整体语速和时间轴对齐
- 整体语速：MiMo API 没有数值 speed 参数，妙幕在音频返回后用 `atempo` 调整
- 暂不包含：SSE 流式、自然语言风格指令、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone`

## 常见问题

- **401**：检查 Key 与 Base URL 是否属于同一计费模式
- **402**：当前账号不可调用；即使模型标为限时免费，账号仍可能需要有效余额或服务开通状态
- **429 / 503**：调低并发数、增大请求间隔，稍后重试
- **想设计或复刻音色**：首版没有开放这两个模型，可使用本地 ZipVoice、火山复刻或 ElevenLabs 即时克隆
- **同账号还能做什么**：[MiMo 云端听写](/guides/cloud-asr/xiaomi-mimo)

---

> 信息更新于 2026-09。模型、价格与音色以 [MiMo TTS 使用指南](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)和 [API 参考](https://mimo.mi.com/docs/zh-CN/api/audio/tts)为准。
