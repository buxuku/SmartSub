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

通过应用下载的 CUDA / Vulkan 加速包会在解压前校验 SHA-256；清单缺少校验信息或校验失败时会尝试其他下载源。新插件校验和解压成功后才替换旧插件，失败时保留已有安装。诊断包的 `addon.json` 会记录新安装插件的实际下载源、发布版本、压缩包与 `addon.node` 的哈希，便于确认不同电脑使用的是否为同一构建；旧安装没有这些记录时不会被标记为已校验。

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

- **启用 GPU 后闪退**：先将加速模式切为「仅 CPU」。Windows / Linux 可在「导出诊断包」中使用下述转写诊断，收集 GPU 后端的错误信息
- **Apple 芯片首次使用某模型很慢**：CoreML 模式首次需编译优化，medium / large 可能要几分钟到几十分钟（期间进度显示正常现象）；不想等就把加速方式切成「Metal」，即开即用
- **q5 / q8 量化模型在 Mac 上不走 CoreML**：正常——量化模型无 CoreML 版本，会自动使用 Metal

### Vulkan / CPU 对照诊断

先暂停其他转写任务，再打开「导出诊断包」中的「Whisper 转写诊断」。选择已安装的模型和测试后端，点击「运行测试」。诊断使用内置短音频，不会更改正常转写的加速设置，也不会自动上传资料。每次测试最多 3 分钟，可随时取消。

建议每次只改变一个选项：先用同一模型分别测试 Vulkan 和 CPU；若只有 Vulkan 失败，再保持 Vulkan 不变，关闭 VAD 测一次，或换成已安装的小模型测一次。

完成后导出诊断包。`gpu.json` 包含 Windows 显卡的驱动版本；`addon.json` 的 `diagnosticProbes` 保留最近 6 次测试，包括模型、后端、VAD、执行阶段、原生设备日志、stderr 尾部和退出分类。原生退出事件同时保存在 `crash/crash-events.jsonl`；若有转储，其摘要也会导出。

诊断进程独立运行，原生库崩溃时应用可以继续导出资料。这里的隔离只用于诊断；普通转写的执行方式不变。测试完成只说明当前模型能处理这段示例，不能保证所有音频都正常。某些 Windows 退出码会丢失精度，报告会注明 `realCodeLost`，需要结合崩溃事件和转储确认具体异常。

---

> 信息更新于 2026-07。whisper.cpp 项目动态见[官方仓库](https://github.com/ggml-org/whisper.cpp)。
