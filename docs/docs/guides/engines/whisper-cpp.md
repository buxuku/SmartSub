---
sidebar_position: 2
title: whisper.cpp（内置引擎）
description: 妙幕内置 whisper.cpp 转写引擎配置指南：ggml 量化模型选择与下载、CUDA / Vulkan / Core ML / Metal GPU 加速、Silero VAD 细粒度时间轴。
keywords: [whisper.cpp, ggml 模型, whisper 字幕, GPU 加速转写, 本地语音识别]
---

# whisper.cpp（内置引擎）

<ProviderMeta
  website="https://github.com/ggml-org/whisper.cpp"
  websiteLabel="whisper.cpp（GitHub）"
  credentials="无需凭据"
  freeTier="完全免费"
  pricing="本地运行，无费用"
  bestFor="默认选择：零依赖、全平台 GPU 加速、低配电脑也能流畅跑"
  offline
/>

妙幕的默认转写引擎，随应用内置、开箱即用。支持 ggml 量化模型与全平台 GPU 加速；Apple 芯片（M 系列）有专属优化，配置老旧或内存偏小的电脑也能轻量流畅运行。

## 在妙幕中配置

「引擎」页面选中「whisper.cpp（内置）」：

<div className="img-container">
  <img src="/img/v3/engines/whisper-cpp.webp" alt="whisper.cpp 引擎页：GPU 加速状态、推荐模型与模型列表" />
</div>

1. **GPU 加速**：应用自动检测显卡并给出推荐——NVIDIA 一键下载 CUDA 加速包；AMD / Intel 的 Vulkan 已内置；Apple 芯片在「自动（推荐）/ Metal」之间选择。详见 [GPU 加速](/advanced/hardware-acceleration)
2. **下载模型**：顶部横幅按你的电脑配置推荐型号（如 `large-v3-turbo`），一键下载；或在模型列表按档位自选
3. 需要手动导入模型（网络受限）时点「导入模型」，见[模型选择与导入](./models)

完成后在任务向导的「语音模型」下拉里即可选用。

## 模型档位速览

| 档位     | 型号示例                            | 特点                                 |
| -------- | ----------------------------------- | ------------------------------------ |
| 快速档   | tiny（75 MB）、base（148 MB）       | 出结果快，准确度一般，适合快速试效果 |
| 均衡档   | small、medium                       | 精度与资源平衡                       |
| 高精度档 | large-v3、large-v3-turbo（1.62 GB） | 精度最高，需较大内存 / 显存          |
| 量化版   | tiny-q5_1、base-q8_0 等             | 体积更小、速度更快，精度略有损失     |

完整选择建议见[模型选择与导入](./models)。

## 时间轴与断句

内置引擎使用 **Silero VAD 智能分段**并设定最小显示时长，断句自然、时间对齐准；配合工具栏「断句与精修」里的「单条最长字数」，可按词级时间戳重新成句。超长音频（4 小时以上）自动在静音处分段处理并无缝合并。

字幕里出现大段重复或静音处多出杂字时，到「更多设置 › 专家」把「识别策略」换成「最干净最稳」；想自己调 VAD 灵敏度、上下文长度和抗重复，选「手动调节」。

## 常见问题

- **启用 GPU 后闪退**：加速模式切「仅 CPU」，或看「检测详情」的失败原因
- **Apple 芯片首次使用某模型很慢**：CoreML 模式首次需编译优化，medium / large 可能要几分钟到几十分钟（期间进度显示正常现象）；不想等就把加速方式切成「Metal」，即开即用
- **q5 / q8 量化模型在 Mac 上不走 CoreML**：正常——量化模型无 CoreML 版本，会自动使用 Metal

---

> 信息更新于 2026-07。whisper.cpp 项目动态见[官方仓库](https://github.com/ggml-org/whisper.cpp)。
