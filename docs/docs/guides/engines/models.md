---
sidebar_position: 9
title: 模型选择与手动导入
description: whisper 模型怎么选：tiny 到 large-v3-turbo 各档位建议、量化版本说明、国内镜像手动下载与导入方法、Apple 芯片 CoreML 文件说明。
keywords:
  [whisper 模型下载, 模型选择, hf-mirror, large-v3-turbo, 量化模型, 模型导入]
---

# 模型选择与手动导入

whisper 系引擎（whisper.cpp / faster-whisper）的模型**越大越准、越慢、越吃显存**。这页帮你选对档位，并解决下载难的问题。

## 怎么选模型

| 你的情况            | 推荐                          | 说明                              |
| ------------------- | ----------------------------- | --------------------------------- |
| 低端设备 / 核显     | `tiny` / `base`               | 75–148 MB，速度快占用小           |
| 普通电脑            | `small` / `base` 起步         | 平衡精度与资源                    |
| 高性能显卡 / 工作站 | `large-v3` / `large-v3-turbo` | 精度最高；turbo 版速度接近 medium |
| 纯英文内容          | 带 `en` 后缀的模型            | 专为英语优化，同体积更准          |
| 在意磁盘 / 显存     | `q5` / `q8` 量化版            | 牺牲少量精度换更小体积            |

「引擎」页面顶部会**按你的电脑配置自动推荐**型号（依据内存与 GPU 情况），拿不准就用推荐的。

:::tip 中文内容不一定要 whisper
FunASR / FireRedASR 在中文场景通常比同级 whisper 模型更准，且模型下载对国内网络友好，见[转写引擎总览](./overview)。
:::

## 应用内下载与下载源

模型默认在应用内直接下载，支持多镜像源（GitHub / gh-proxy 国内加速 / GitCode / ModelScope）自动回退、断点续传与完整性校验。下载不畅时到「设置 → 下载源（高级）」切换源，或配置[网络代理](/advanced/storage#相关设置)。

## 手动下载与导入

应用内下载实在困难时，手动来：

1. 从镜像站下载模型文件（`ggml-*.bin`）：
   - 国内镜像（快）：https://hf-mirror.com/ggerganov/whisper.cpp/tree/main
   - Hugging Face 官方：https://huggingface.co/ggerganov/whisper.cpp/tree/main
2. 「引擎」页面点「**导入模型**」选择下载好的文件；或直接复制到模型目录（模型路径显示在页面上，可点「打开文件夹」直达）

### Apple 芯片的 CoreML 文件

Apple 芯片走 CoreML 加速时，非量化模型需要配套的 `<模型名>-encoder.mlmodelc` 文件：从同一模型源下载、解压后放在模型相同目录。`q5` / `q8` 量化模型无需此文件（自动走 Metal）。嫌麻烦可在引擎页把加速方式切为「Metal」。

## 其它引擎的模型

- **faster-whisper**：模型在引擎页内按需下载（HuggingFace / 镜像源），同样支持导入
- **FunASR / Qwen3-ASR / FireRedASR / Parakeet**：在「本地多模型引擎」分组内下载，支持应用内选择下载源或从文件夹导入
- 所有模型的存放位置由[统一存储目录](/advanced/storage)管理，可迁移到大容量磁盘

---

> 信息更新于 2026-07。
