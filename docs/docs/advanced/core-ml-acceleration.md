---
sidebar_position: 2
---

# Core ML 加速

SmartSub支持在搭载Apple Silicon芯片(M系列)的Mac设备上使用Core ML加速，显著提高字幕生成的处理速度。本页面将指导您如何正确设置和使用Core ML加速功能。

## 什么是Core ML加速？

Core ML是Apple的机器学习框架，专为在Apple设备上高效运行机器学习模型而设计。在SmartSub中，Core ML加速可以充分利用M系列芯片(如M1、M2、M3)的神经网络引擎，提供2-5倍的性能提升，同时降低能耗。

## 系统要求

要使用Core ML加速，您的系统需要满足以下条件：

- **设备**：搭载Apple Silicon芯片(M1, M1 Pro, M1 Max, M1 Ultra, M2, M2 Pro, M2 Max, M3, M3 Pro, M3 Max等)的Mac
- **操作系统**：macOS 12 (Monterey) 或更高版本
- **SmartSub版本**：必须下载ARM64版本的SmartSub

:::note
Intel芯片的Mac设备不支持Core ML加速功能。
:::

## 如何启用Core ML加速

在搭载Apple Silicon芯片的Mac上，SmartSub会自动启用Core ML加速，无需额外配置。但您需要确保：

1. 您下载的是适用于Mac ARM64的版本
2. 您已下载包含Core ML支持的模型文件

## 下载正确的SmartSub版本

要确保获得Core ML加速支持：

1. 访问[SmartSub发布页面](https://github.com/buxuku/SmartSub/releases)
2. 下载`mac-arm64`版本的安装包
3. 安装应用程序

## 模型准备

Core ML加速需要特定的模型文件支持：

### 自动下载

当您在SmartSub中下载模型时，如果检测到您的设备是Apple Silicon Mac，应用会自动下载适合Core ML的模型文件：

1. 在应用中进入"模型管理"页面
2. 选择并下载所需模型
3. 系统会自动下载标准模型文件(.bin)和Core ML模型文件(encoder.mlmodelc)

### 手动下载与导入

如果需要手动导入模型：

1. 下载标准Whisper模型文件(.bin)
2. 对于非量化模型(不带q5_0或q8_0后缀的模型)，还需下载对应的`encoder.mlmodelc`文件：
   - 从[Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main)或[镜像站](https://hf-mirror.com/ggerganov/whisper.cpp/tree/main)下载
   - 找到与您模型对应的`encoder.mlmodelc.zip`文件
   - 解压后得到`encoder.mlmodelc`文件夹

3. 导入步骤：
   - 将模型文件(.bin)导入到SmartSub
   - 将解压后的`encoder.mlmodelc`文件夹放在与模型同一目录中
   - 或者使用"导入Core ML模型"功能将其导入

:::tip
量化模型(带q5_0或q8_0后缀)不需要单独的Core ML模型文件，但不会获得完整的Core ML加速效果。
:::

## 验证Core ML加速是否启用

要确认Core ML加速是否正常工作：

1. 启动SmartSub
2. 打开"设置"页面
3. 选择"系统信息"选项卡
4. 查看"硬件加速"部分，应显示"Core ML: 可用"
5. 处理一个视频文件，查看日志输出
6. 日志中应该有"使用Core ML加速处理"的信息

或者，您可以查看应用的日志文件，寻找类似以下的信息：

```
[INFO] Loading Core ML model from /Users/username/Library/Application Support/SmartSub/models/encoder.mlmodelc
[INFO] Core ML acceleration enabled
```

## 优化Core ML性能

要获得最佳Core ML加速效果，可以尝试以下优化：

### 1. 使用非量化模型

非量化模型(如ggml-base.bin)与Core ML配合使用时性能最佳。量化模型(如ggml-base-q5_0.bin)虽然也能工作，但Core ML加速效果会受限。

### 2. 关闭其他资源密集型应用

处理时关闭其他资源密集型应用程序，为SmartSub提供更多系统资源。

### 3. 保持设备充电

MacBook在充电状态运行时通常有更好的性能表现，因为系统不会过度进行功耗管理。

### 4. 更新macOS

确保您的macOS是最新版本，Apple经常在系统更新中优化Core ML性能。

## 对比：Core ML加速与CPU处理

以下是在不同Apple设备上处理10分钟视频的性能比较示例：

| 设备 | 处理模式 | 处理时间 | 加速比 |
|------|----------|---------|-------|
| MacBook Air (M1) | CPU模式 | 约20分钟 | 1.0x |
| MacBook Air (M1) | Core ML | 约8分钟 | 2.5x |
| MacBook Pro (M1 Pro) | CPU模式 | 约15分钟 | 1.0x |
| MacBook Pro (M1 Pro) | Core ML | 约5分钟 | 3.0x |
| MacBook Pro (M2 Max) | CPU模式 | 约10分钟 | 1.0x |
| MacBook Pro (M2 Max) | Core ML | 约3分钟 | 3.3x |
| Mac Studio (M1 Ultra) | CPU模式 | 约8分钟 | 1.0x |
| Mac Studio (M1 Ultra) | Core ML | 约2分钟 | 4.0x |

:::note
实际性能会根据您的具体设备、模型大小、视频特性以及其他因素而有所不同。
:::

## 电池和散热管理

使用Core ML加速时，您可能会注意到：

- **电池消耗**：Core ML比纯CPU处理更高效，但仍会消耗较多电池
- **设备发热**：处理期间设备可能会变热，这是正常现象
- **风扇噪音**：配备风扇的Mac可能会提高风扇转速进行散热

为了更好的处理体验，建议：

- 长时间处理时连接电源适配器
- 确保设备放置在通风良好的平面上
- 避免在高温环境中进行密集处理

## 常见问题解决

### Core ML模型无法加载

如果系统报告"无法加载Core ML模型"：

1. 确认您下载的是正确的`encoder.mlmodelc`文件
2. 确保该文件与您的模型版本匹配
3. 检查文件是否完整，可能需要重新下载
4. 确保文件放置在正确的目录中

### 性能不如预期

如果Core ML加速效果不明显：

1. 检查Activity Monitor中的CPU/GPU使用情况
2. 确认您使用的是非量化模型
3. 关闭后台运行的其他应用程序
4. 尝试重启应用程序或计算机

### 应用崩溃

如果启用Core ML加速后应用崩溃：

1. 尝试使用较小的模型(如base或small，而非large)
2. 检查是否有macOS更新可用
3. 重新下载并安装SmartSub
4. 暂时禁用Core ML加速(可在高级设置中配置)，然后报告问题

## 与CUDA加速的比较

与NVIDIA CUDA加速相比，Core ML加速有以下特点：

1. **集成度**：Core ML深度集成到macOS系统中，无需额外安装驱动或库
2. **能效**：Core ML通常更节能，对电池寿命影响较小
3. **性能**：在相似级别的硬件上，顶级的CUDA GPU可能提供更高的性能，但高端M系列芯片也非常强大
4. **可用性**：所有Apple Silicon Mac都自动支持Core ML，而CUDA仅适用于搭载NVIDIA GPU的PC

## 需要更多帮助？

如果您在设置或使用Core ML加速时遇到问题，请参考以下资源：

- [Apple Core ML文档](https://developer.apple.com/documentation/coreml)
- [SmartSub故障排除指南](../faq/troubleshooting)
- 在[GitHub Issues](https://github.com/buxuku/SmartSub/issues)上提问 