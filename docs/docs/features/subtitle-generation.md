---
sidebar_position: 1
title: 字幕生成（语音转写）
description: 用妙幕把视频和音频批量转写成 SRT 字幕：8 类转写引擎可选（whisper.cpp、faster-whisper、FunASR、Qwen3-ASR、FireRedASR、NVIDIA Parakeet、Whisper CLI、云端听写），支持 GPU 加速、效果档位与精细断句控制。
keywords:
  [视频转字幕, 语音转文字, whisper 字幕, FunASR, SRT 生成, 批量转写, 字幕断句]
---

# 字幕生成（语音转写）

把视频 / 音频里的人声转成带时间轴的字幕文件。这是妙幕流水线的第一环，支持批量处理、多引擎切换与硬件加速。

## 基本流程

1. 在启动台选择「视频 → 原文字幕」（或任何包含转写的任务），把文件拖进任务向导
2. 在「字幕设置」里选择**语音模型**、**视频源语言**与**字幕格式**
3. 点「开始」批量处理，完成后字幕文件默认生成在视频同目录

<div className="img-container">
  <img src="/img/v3/wizard/new-task.webp" alt="任务向导中的字幕设置：语音模型、视频语言与字幕格式" />
</div>

支持常见的视频（mp4 / mkv / mov / avi …）与音频（mp3 / wav / m4a / flac …）格式；并发任务数可在任务设置中调整。

## 八类转写引擎

转写引擎可以**逐任务切换**，在「引擎」页面统一安装与管理：

| 引擎                    | 特点                                                               | 运行方式                         |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------- |
| **whisper.cpp（内置）** | 默认引擎，ggml 量化模型 + GPU 加速，低配电脑也能流畅跑             | 随应用内置，开箱即用             |
| **faster-whisper**      | 基于 CTranslate2，速度更快、精度更高                               | 自包含运行时（应用内下载）       |
| **FunASR**              | SenseVoice（中 / 英 / 日 / 韩 / 粤）与 Paraformer-zh，中文表现优秀 | 内置 sherpa-onnx，无需额外环境   |
| **Qwen3-ASR**           | 通义千问语音识别（qwen3-asr-0.6b / 1.7b）                          | 内置 sherpa-onnx，无需额外环境   |
| **FireRedASR**          | FireRedASR-AED large（中英），中文表现优秀                         | 内置 sherpa-onnx，无需额外环境   |
| **NVIDIA Parakeet**     | Parakeet TDT 0.6B v3，英文与 25 种欧洲语言，自动标点及大小写       | 内置 sherpa-onnx，无需额外环境   |
| **本地 Whisper CLI**    | 调用你自行安装的 whisper 兼容命令                                  | 使用系统已装命令                 |
| **云端听写**            | 8 家在线服务商，免 GPU 免模型，部分有免费额度                      | 在线服务（音频上传到配置的端点） |

- 引擎选型与逐个安装说明见[转写引擎总览](/guides/engines/overview)
- 中文内容推荐 FunASR / FireRedASR；英文与欧洲语言可试 Parakeet；没有显卡且不想下载模型时推荐[云端听写](/guides/cloud-asr/overview)
- whisper 系模型怎么选（tiny 到 large、量化版本）见[模型选择与导入](/guides/engines/models)

## 字幕效果档位

不想调参数的话，直接选**效果档位**：按「快速草稿 / 均衡 / 精细」等使用意图自动派生底层识别参数（VAD 切分、时间戳策略等），几乎无需手动调参。

需要精细控制时，任务高级设置提供：

- **每条字幕最大字数**：有词级时间戳的引擎（whisper.cpp / faster-whisper / 云端听写）按真实词级时间重新成句；其余引擎按文本比例兜底拆分
- **断句设置**：三态控制——严格不拆词 / 允许适度拆分 / 不限长度
- **中文去标点、简繁转换**：中文字幕可选去除标点、简体繁体互转

## 时间轴质量

- 内置 whisper.cpp 引擎使用 **Silero VAD 智能分段**并设定最小显示时长，断句与时间对齐更自然
- 字幕显示按语音结束时间收敛，减少「字幕滞留」
- **超长音频（4 小时以上）自动在静音处分段**处理，时间轴无缝合并，不再爆内存

## GPU 加速

| 平台                          | 加速后端           |
| ----------------------------- | ------------------ |
| Windows / Linux + NVIDIA      | CUDA（应用内下载） |
| Windows / Linux + AMD / Intel | Vulkan（已内置）   |
| macOS Apple 芯片              | Core ML / Metal    |
| 任意平台                      | CPU 自动回退       |

无需手动安装 CUDA Toolkit，详见 [GPU 加速](../advanced/hardware-acceleration)。

## 实用细节

- **自定义字幕文件名**：按模板生成文件名（如 `视频名.zh.srt`），方便不同播放器自动挂载识别
- **官方字幕优先**：经[视频下载](./video-download)获取的在线视频若带官方字幕，会自动配对，无需再转写
- **误命名兼容**：导入的字幕文件即使扩展名不对，也会自动探测真实格式
- **模型完整性校验**：faster-whisper 模型加载前自动校验完整性，避免残缺文件导致的转写异常

## 下一步

- 转写完成后[翻译字幕](./subtitle-translation)或进[校对台](./proofreading)核对
- 高频场景照做：[播客 / 会议录音批量转文字](/scenarios/podcast-to-text)
