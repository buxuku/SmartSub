---
sidebar_position: 1
title: 转写引擎选型总览
description: 妙幕 8 类转写引擎怎么选：whisper.cpp、faster-whisper、FunASR、Qwen3-ASR、FireRedASR、NVIDIA Parakeet、本地 Whisper CLI 与云端听写的对比表与按需求推荐路径。
keywords:
  [转写引擎对比, whisper 选择, FunASR, Parakeet, 语音识别引擎, ASR 引擎选型]
---

# 转写引擎选型总览

转写引擎负责把人声转成文字。本地引擎免费、离线、数据不出本机；云端听写填好 API Key 即用、无需下载模型。**任一类就绪即可开始生成字幕**，且引擎可逐任务切换。

<div className="img-container">
  <img src="/img/v3/engines/overview.webp" alt="引擎页总览：本地引擎与云端听写就绪状态、推荐起步路径" />
</div>

## 对比一览

| 引擎                                           |      免费      | 离线 | 中文表现 | 依赖             | 适合                        |
| ---------------------------------------------- | :------------: | :--: | -------- | ---------------- | --------------------------- |
| [whisper.cpp（内置）](./whisper-cpp)           |       ✅       |  ✅  | 好       | 无（开箱即用）   | 默认选择，全平台 GPU 加速   |
| [faster-whisper](./faster-whisper)             |       ✅       |  ✅  | 好       | 应用内下载运行时 | 追求速度与精度，NVIDIA 用户 |
| [FunASR](./funasr)                             |       ✅       |  ✅  | **优秀** | 内置原生库       | 中文/中英混合内容           |
| [Qwen3-ASR](./qwen3-asr)                       |       ✅       |  ✅  | 优秀     | 内置原生库       | 中文，轻量模型              |
| [FireRedASR](./firered-asr)                    |       ✅       |  ✅  | **优秀** | 内置原生库       | 中文精度优先                |
| [NVIDIA Parakeet](./parakeet)                  |       ✅       |  ✅  | 不适用   | 内置原生库       | 英文与欧洲语言精度优先      |
| [本地 Whisper CLI](./whisper-cli)              |       ✅       |  ✅  | 好       | 自装命令         | 已有 whisper 环境的高级用户 |
| [云端听写（8 家）](/guides/cloud-asr/overview) | 部分有免费额度 |  ❌  | 好       | API Key          | 无 GPU / 低配电脑，省心起步 |

## 按需求推荐

- **开箱即用**：用内置 whisper.cpp + 推荐模型，零依赖，下载一个模型即可离线转写
- **中文内容最佳**：FunASR（SenseVoice）或 FireRedASR，中文准确率通常高于同级 whisper 模型
- **英文 / 欧洲语言精度优先**：NVIDIA Parakeet TDT 0.6B v3，支持自动标点与大小写
- **速度优先（NVIDIA）**：faster-whisper + CUDA
- **没有显卡 / 不想下模型**：云端听写，腾讯云每月赠 5 小时、Gladia 每月赠 10 小时，见[云端听写总览](/guides/cloud-asr/overview)
- **完全免费 + 离线**：任意本地引擎均满足

## 管理入口

左侧导航「引擎」页面统一完成：引擎运行时安装、模型下载 / 导入、GPU 加速管理与云端听写配置。模型与临时文件的存放位置在[统一存储目录](/advanced/storage)设置。
