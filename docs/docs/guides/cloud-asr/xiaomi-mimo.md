---
sidebar_position: 12
title: Xiaomi MiMo 语音识别
description: 妙幕 Xiaomi MiMo 云端听写配置指南：mimo-v2.5-asr 中英文识别、API Key 与 Token Plan 端点配置、0.5 元/小时计费及粗粒度时间轴说明。
keywords: [Xiaomi MiMo, 小米语音识别, mimo-v2.5-asr, 云端听写, ASR]
---

# Xiaomi MiMo 语音识别

<ProviderMeta
  website="https://mimo.mi.com/"
  websiteLabel="MiMo 开放平台"
  credentials="API Key"
  freeTier="未公开承诺 ASR 免费额度"
  pricing="国内按量 0.5 元/小时"
  bestFor="中文、英文内容；希望同一平台同时使用听写与配音"
/>

`mimo-v2.5-asr` 支持中文、英文与自动语种检测，也能识别粤语、吴语、闽南语、四川话等中文方言。服务端只返回完整文本，不提供词级或分段时间戳；妙幕会在上传前按静音切成约 20 秒的小段，用分片边界构造**粗粒度时间轴**。

:::caution 费用与额度
ASR 按音频时长计费，国内当前价格为 **0.5 元/小时**。MiMo 公开文档未承诺 ASR 免费体验额度，也没有公开余额查询 API；请在控制台查看账户余额与用量。应用中的「测试连接」会上传 1 秒静音，成本极低但并非零成本探针。
:::

## 申请步骤

1. 登录 [MiMo 开放平台](https://mimo.mi.com/)
2. 在控制台创建按量 API Key；普通按量 Key 通常以 `sk-` 开头
3. 如购买 Token Plan，请同时记录控制台给出的专属 Base URL；`tp-` Key 不能与按量端点混用

## 在妙幕中配置

「引擎」页面 → 云端听写分组选「MiMo ASR」：

<div className="img-container">
  <img src="/img/v3/cloud-asr/xiaomi-mimo.webp" alt="Xiaomi MiMo 云端听写配置表单，API Key 字段为空" />
</div>

| 字段     | 填写                                                                 |
| -------- | -------------------------------------------------------------------- |
| API Key  | 控制台创建的 `sk-` 或 `tp-` Key                                      |
| 模型     | 固定为 `mimo-v2.5-asr`                                               |
| Base url | 按量 Key 使用 `https://api.xiaomimimo.com/v1`；Token Plan 填专属 URL |
| 请求超时 | 默认 120 秒                                                          |
| 并发数   | 默认 2                                                               |
| 请求间隔 | 默认 0.7 秒，降低触发限流的概率                                      |

点「**测试连接**」验证后即可在任务的「引擎 ▸ 模型」下拉中选择。MiMo 分组会显示「粗粒度时间轴」徽标。

## 能力与限制

- 任务原语言选中文（包括 `zh-CN` 等）会映射为 `zh`，英文映射为 `en`；自动识别映射为 `auto`
- MiMo ASR 不接受其它明确语种，任务开始前会直接提示
- 单请求只支持 WAV / MP3，Base64 字符串上限 10MB；妙幕采用 7MiB 原始文件安全线
- 瞬时网络错误及 HTTP 429 / 500 / 503 最多重试两次
- 音频会直接上传到你配置的 MiMo 端点，妙幕不经手中转

## 常见问题

- **401**：检查 Key 与 Base URL 是否属于同一计费模式。`sk-` 按量 Key 使用公共按量端点，`tp-` Key 使用套餐专属端点
- **402**：余额不足，请在控制台充值或检查套餐状态
- **429 / 503**：调低并发数、增大请求间隔，稍后重试
- **时间轴不够精细**：这是服务端不返回时间戳的限制。可改用支持词级时间戳的 ElevenLabs、Deepgram 或 OpenAI 兼容模型
- **同账号还能做什么**：[MiMo 基础语音合成](/guides/tts/xiaomi-mimo)

---

> 信息更新于 2026-09。模型、价格与限制以 [MiMo ASR 使用指南](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition)和 [API 参考](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)为准。
