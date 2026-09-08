---
sidebar_position: 1
title: 配音服务选型总览
description: 妙幕配音（TTS）服务怎么选：本地 Kokoro / VITS 离线免费、Edge TTS 免费试用档、Azure / 火山豆包 / ElevenLabs / Xiaomi MiMo 云端服务与 ZipVoice 声音克隆的对比与推荐。
keywords: [TTS 服务对比, AI 配音选择, 免费配音, 文字转语音服务, 配音音色]
---

# 配音服务选型总览

配音的声音来自三类来源：**本地模型**（免费·离线）、**在线服务**（联网合成）、**我的音色**（克隆你自己的声音）。任意一类就绪后，就能在「配音」工作台开始配音。

<div className="img-container">
  <img src="/img/v3/tts/overview.webp" alt="配音声音总览：本地模型、在线服务、我的音色三类来源与推荐起步路径" />
</div>

## 服务对比

| 来源                                  |     免费     | 离线 | 音色数           | 特点                                    |
| ------------------------------------- | :----------: | :--: | ---------------- | --------------------------------------- |
| [Kokoro 多语 v1.1](./local-engines)   |      ✅      |  ✅  | 103（中 / 英）   | 本地首选，中英均衡                      |
| [VITS 中文 AIShell3](./local-engines) |      ✅      |  ✅  | 174（中）        | 中文说话人库                            |
| [ZipVoice 声音克隆](./zipvoice)       |      ✅      |  ✅  | 自建             | 零样本克隆自己的声音                    |
| [Edge TTS](./edge-tts)                | ✅（试用档） |  ❌  | 微软 Neural 体系 | 免费免 Key，但**不承诺可用性**          |
| [OpenAI 兼容](./openai-compatible)    |    视端点    |  ❌  | 视端点           | OpenAI / 硅基流动等 `audio/speech` 端点 |
| [Azure Speech](./azure)               |  F0 免费层   |  ❌  | 700+             | 微软 Neural 全量音色，SSML 语速控制     |
| [火山引擎豆包](./volcengine)          |      无      |  ❌  | 豆包大模型音色   | 中文音色出众，支持声音复刻 2.0          |
| [ElevenLabs](./elevenlabs)            | 免费计划少量 |  ❌  | 多语             | 多语模型 + 即时声音克隆（IVC）          |
| [Xiaomi MiMo](./xiaomi-mimo)          |   限时免费   |  ❌  | 8 个中英文音色   | 基础模型；返回后统一对齐与语速处理      |

## 按需求推荐（任选其一即可开工）

1. **完全免费·离线可用**：下载 Kokoro 多语 v1.1，配音不联网、不花钱
2. **零配置在线试用**：启用 Edge TTS，无需注册和 API Key（试用档，不承诺可用性）
3. **用自己的声音配音**：录一段话或选一段视频，[ZipVoice 克隆](./zipvoice)出专属音色
4. **正式发布品质**：Azure Speech（中文 Neural 音色全）或火山豆包（中文大模型音色）；基础中英音色可选当前限时免费的 MiMo，多语出海选 ElevenLabs

## 配置入口

左侧导航「音色」页面：本地模型下载、在线服务凭据配置（支持「测试连接」——会真实合成一句 "Hello"，消耗可忽略）、「我的音色」克隆管理，全部在这里完成。配好后到[配音工作台](/features/tts-dubbing)使用。
