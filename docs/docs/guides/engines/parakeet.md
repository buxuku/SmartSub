---
sidebar_position: 7
title: NVIDIA Parakeet
description: 妙幕 NVIDIA Parakeet TDT 0.6B v3 引擎配置指南：支持英文与 25 种欧洲语言、自动标点和大小写，经内置 sherpa-onnx 原生库离线运行。
keywords: [NVIDIA Parakeet, Parakeet TDT, 英文语音识别, 欧洲语言转写, 本地 ASR]
---

# NVIDIA Parakeet

<ProviderMeta
  website="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"
  websiteLabel="Parakeet TDT 0.6B v3（Hugging Face）"
  credentials="无需凭据"
  freeTier="完全免费"
  pricing="本地运行，无费用"
  bestFor="英文与欧洲语言的高质量本地转写"
  offline
/>

妙幕集成 NVIDIA **Parakeet TDT 0.6B v3** 的 int8 ONNX 模型，通过内置 sherpa-onnx 原生库运行，无需 Python。模型支持 25 种欧洲语言，并可直接输出标点和正确的大小写；模型许可证为 CC-BY-4.0。

## 在妙幕中配置

1. 「引擎」页面选中「本地多模型引擎」分组，展开 NVIDIA Parakeet
2. 点「下载」，按网络环境选择 GitHub 国内加速或 GitHub 官方源；也可从已有模型文件夹导入
3. 在任务向导的「语音模型」中选择 `parakeet-tdt-0.6b-v3`

模型下载包约 487 MB，解包后约 670 MB。下载和解包都可查看进度，也可随时取消。

## 特点与适用

- **英文精度优先**：适合英文视频、课程、访谈和播客
- 覆盖 25 种欧洲语言，并自动处理标点与大小写
- int8 模型可在 CPU 上离线运行，音频和结果不离开本机
- 与 FunASR、Qwen3-ASR、FireRedASR 共用内置 sherpa-onnx 运行库

## 使用边界

- 不支持中文；中英文或中文内容优先选择 FunASR、FireRedASR 或 whisper 系模型
- 当前提供段级时间戳，字幕过长时按文本比例细分时间；需要真实词级时间戳时请选择 whisper.cpp 或 faster-whisper
- 首次转写需要加载约 670 MB 模型，耗时取决于磁盘和 CPU

---

> 信息更新于 2026-07。
