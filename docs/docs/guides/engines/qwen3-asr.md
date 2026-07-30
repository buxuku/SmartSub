---
sidebar_position: 5
title: Qwen3-ASR
description: 妙幕 Qwen3-ASR 引擎配置指南：支持 qwen3-asr-0.6b 与 1.7b，使用内置 sherpa-onnx 原生库离线运行。
keywords: [Qwen3-ASR, 通义千问语音识别, 中文转写, 开源 ASR]
---

# Qwen3-ASR

<ProviderMeta
  website="https://github.com/QwenLM"
  websiteLabel="Qwen（GitHub）"
  credentials="无需凭据"
  freeTier="完全免费"
  pricing="本地运行，无费用"
  bestFor="多语种内容的本地高质量转写"
  offline
/>

通义千问开源的语音识别模型，支持 `qwen3-asr-0.6b` 与 `qwen3-asr-1.7b`。与 FunASR、FireRedASR 一样通过内置 sherpa-onnx 原生库运行，无需额外环境。

## 在妙幕中配置

1. 「引擎」页面选中「本地多模型引擎」分组，找到 Qwen3-ASR
2. 按精度和资源需求选择 0.6B 或 1.7B，点「下载」获取模型
3. 任务向导「语音模型」中选择对应模型即可使用

<div className="img-container">
  <img src="/img/v3/engines/local-multi.webp" alt="本地多模型引擎页面：Qwen3-ASR 模型下载入口" />
</div>

## 特点与适用

- 0.6B int8 约 0.95GB，**体积小、加载快**，适合 CPU 日常转写
- 1.7B int8 约 2.4GB，精度更高，但需要更多内存且 CPU 推理更慢
- 1.7B 当前通过 ModelScope 逐文件下载；0.6B 还可使用 GitHub 整包源
- 与 FunASR / FireRedASR 同分组管理，可下载多个模型按任务对比效果

## 常见问题

- **0.6B 和 1.7B 怎么选**：资源有限或更看重速度时选 0.6B；更看重识别质量且能接受更高内存和耗时时选 1.7B
- **与 FunASR / FireRedASR 怎么选**：三者都可本地免费使用，语言覆盖和素材表现各有差异，建议用同一段素材实测对比
- **时间轴粒度**：无词级时间戳，长句拆分按文本比例兜底

---

> 信息更新于 2026-07。
