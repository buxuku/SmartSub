---
sidebar_position: 13
title: OrcaRouter（AI 翻译）
description: 妙幕 OrcaRouter 翻译配置指南：多模型 AI 网关，一个 API Key 接入多个模型，API 地址默认为 https://api.orcarouter.ai/v1。
keywords: [OrcaRouter 翻译, AI 网关, 字幕翻译, 大模型翻译, OpenAI 兼容]
---

# OrcaRouter（AI 翻译）

<ProviderMeta
  website="https://www.orcarouter.ai/"
  websiteLabel="OrcaRouter 官网"
  credentials="API Key"
  freeTier="有免费模型（orcarouter/free）"
  pricing="按 token 计费，多模型统一定价"
  bestFor="想用一个 Key 接入多种模型的用户——统一网关、一次配置多处可用"
/>

[OrcaRouter](https://www.orcarouter.ai) 是一个多模型 AI 网关：一个 API Key、一套 OpenAI 兼容端点，即可按需路由到多个大模型。它也以网关级别运行面向 AI agent 的零信任安全能力——在同一个端点上对每次提示/响应进行筛查、对每个工具调用做默认拒绝（default-deny）式的治理，无需改动任何应用代码。

## 申请步骤

1. 访问 [OrcaRouter 官网](https://www.orcarouter.ai) 注册
2. 在控制台创建 API Key（`sk-orca-` 开头，只显示一次）

## 在妙幕中配置

「翻译」页面选「OrcaRouter」：

| 字段     | 填写                                      |
| -------- | ----------------------------------------- |
| API 地址 | 默认 `https://api.orcarouter.ai/v1`，无需修改 |
| API Key  | 上一步创建的密钥                          |
| 模型名称 | 下拉选择，如 `orcarouter/auto`（自动路由）或 `orcarouter/fusion` |

点「**测试翻译**」验证后即可使用。OrcaRouter 端点还支持从 `/models` 自动拉取可用模型列表。

## 参数建议

- **批量翻译数量 / 批次并发数**：默认起步；量大提速可加大并发，注意平台限流
- **思考模式**：保持关闭（翻译无需深度推理，关闭更快更省）
- 支持[术语表](/advanced/glossary)、[自定义提示词](/advanced/custom-prompts)与回显对齐校验

## 常见问题

- **401 / 认证失败**：检查 API Key 是否以 `sk-orca-` 开头、控制台里是否有效
- **响应慢**：模型高峰负载波动，调低并发或错峰使用
- **译文错位**：开启「回显对齐校验」，v3.5 的对齐防护会自动修复大多数错位

---

> 信息更新于 2026-08，价格以 [OrcaRouter 官网](https://www.orcarouter.ai) 为准。
