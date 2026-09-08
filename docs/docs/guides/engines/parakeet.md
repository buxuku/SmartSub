---
sidebar_position: 7
title: NVIDIA Parakeet
description: 妙幕 NVIDIA Parakeet 引擎配置指南：英语 v2、多语种 v3 与日语 CTC，经内置 sherpa-onnx 原生库离线运行。
keywords: [NVIDIA Parakeet, Parakeet TDT, 日语语音识别, 英文语音识别, 欧洲语言转写, 本地 ASR]
---

# NVIDIA Parakeet

<ProviderMeta
  website="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"
  websiteLabel="Parakeet TDT 0.6B v3（Hugging Face）"
  credentials="无需凭据"
  freeTier="完全免费"
  pricing="本地运行，无费用"
  bestFor="英语、欧洲语言与日语的本地转写"
  offline
/>

妙幕提供三个可独立安装的 Parakeet int8 ONNX 模型，通过内置 sherpa-onnx 原生库运行，无需 Python，许可证均为 CC-BY-4.0。

| 模型 | 语言与解码方式 | 下载 / 安装体积 |
| --- | --- | --- |
| `parakeet-tdt-0.6b-v2` | 英语，TDT，支持标点与大小写 | 约 482 MB / 662 MB |
| `parakeet-tdt-0.6b-v3` | 25 种欧洲语言（含英语），TDT，支持标点与大小写 | 约 487 MB / 671 MB |
| `parakeet-tdt_ctc-0.6b-ja` | 日语，CTC，支持标点 | 约 489 MB / 656 MB |

英语 v2 和多语种 v3 可按实际音频效果选择，v3 并非所有英语场景下都优于 v2。日语模型使用原始 TDT/CTC 混合模型的 **CTC 分支**，不使用 TDT 解码。日语 1.1B 模型暂未接入。

## 在妙幕中配置

1. 「引擎」页面选中「本地多模型引擎」分组，展开 NVIDIA Parakeet
2. 点「下载」，按网络环境选择 GitHub 国内加速或 GitHub 官方源；也可从已有模型文件夹导入
3. 在任务向导的「语音模型」中选择与音频语言对应的已安装模型

下载和解包都可查看进度，也可随时取消。导入须使用 sherpa-onnx 对应模型包：TDT 模型需要 encoder、decoder、joiner 三个 int8 ONNX 文件和 `tokens.txt`；日语 CTC 需要 `model.int8.onnx` 和 `tokens.txt`。其它 ONNX 导出格式不一定兼容。

源语言与模型不匹配时会提示，但保留选择并允许开始；源语言设为「自动」不会扩展模型的语种能力。任务指定的模型被删除时，需要重新选择或重新安装，应用不会自动切换到另一模型。固定配置任务可重新安装原模型，或新建任务选择其它模型。

## 特点与适用

- 英语 v2 适合英文视频、课程、访谈和播客
- 多语种 v3 覆盖 25 种欧洲语言，并自动处理标点与大小写
- 日语 0.6B CTC 适合日语视频和录音，支持日语标点
- int8 模型可在 CPU 上离线运行，音频和结果不离开本机
- 与 FunASR、Qwen3-ASR、FireRedASR 共用内置 sherpa-onnx 运行库

## 使用边界

- 不支持中文；中英文或中文内容优先选择 FunASR、FireRedASR 或 whisper 系模型
- 当前提供段级时间戳，字幕过长时按文本比例细分时间；需要真实词级时间戳时请选择 whisper.cpp 或 faster-whisper
- 标点取决于模型输出，不保证每段音频都自动补全；日语 CTC 在短句和口语样本中可能不输出标点
- 首次转写与切换模型需要加载对应权重，耗时取决于磁盘和 CPU；实际内存占用高于权重文件体积

---

> 信息更新于 2026-09。
