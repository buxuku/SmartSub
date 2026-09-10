---
sidebar_position: 6
title: DeepSeek（AI 翻译）
description: 妙幕 DeepSeek 翻译配置指南：deepseek-chat 模型价格低质量高，API Key 创建步骤与批量翻译参数建议，中文字幕翻译的高性价比选择。
keywords: [DeepSeek 翻译, deepseek-chat, AI 字幕翻译, 大模型翻译, 深度求索]
---

# DeepSeek（AI 翻译）

<ProviderMeta
  website="https://platform.deepseek.com/"
  websiteLabel="DeepSeek 开放平台"
  credentials="API Key"
  freeTier="无固定免费额度（新用户常有赠金活动）"
  pricing="按 token 计费，价格极低"
  bestFor="质量优先且预算有限——中文场景 AI 翻译的性价比标杆"
/>

深度求索的大模型 API：中文能力强、价格极低，是妙幕用户里最主流的 AI 翻译选择之一。

## 申请步骤

1. 注册 [DeepSeek 开放平台](https://platform.deepseek.com/)（手机号即可）
2. 充值少量金额（几块钱可以翻很多字幕）
3. 在 [API Keys 页面](https://platform.deepseek.com/api_keys) 创建密钥（`sk-` 开头，只显示一次）

## 在妙幕中配置

「翻译」页面选「深度求索」：

<div className="img-container">
  <img src="/img/v3/translation/deepseek.webp" alt="DeepSeek 翻译配置：API 地址、API Key 与模型名称" />
</div>

| 字段     | 填写                                         |
| -------- | -------------------------------------------- |
| API 地址 | 默认 `https://api.deepseek.com/v1`，无需修改 |
| API Key  | 上一步创建的密钥                             |
| 模型名称 | `deepseek-chat`（V 系列通用模型）            |

点「**测试翻译**」验证后即可使用。

## 参数建议

- **批量翻译数量**：默认 20 条；通常能兼顾相邻字幕上下文和请求开销。若单条字幕很长或使用大回显提示词，可降到 10 条
- **批次并发数**：默认 2；量大提速可继续增加，遇到 429 或响应变慢时降回 1
- **思考模式**：保持关闭（翻译无需深度推理，关闭更快更省）
- 支持[术语表](/advanced/glossary)、[自定义提示词](/advanced/custom-prompts)与回显对齐校验

## 常见问题

- **402 / 余额不足**：平台充值后重试
- **响应慢**：高峰期平台负载波动，调低并发或错峰使用
- **译文错位**：开启「回显对齐校验」，v3.5 的对齐防护会自动修复大多数错位

---

> 信息更新于 2026-07，价格以 [DeepSeek 定价](https://platform.deepseek.com/pricing) 为准。
