---
sidebar_position: 1
---

# CUDA 加速

SmartSub支持使用NVIDIA CUDA技术进行GPU加速，大幅提高字幕生成的处理速度。本页面将指导您如何正确设置和使用CUDA加速功能。

## 什么是CUDA加速？

CUDA（Compute Unified Device Architecture）是NVIDIA推出的并行计算平台和编程模型，可以利用GPU的强大计算能力加速处理任务。在SmartSub中，CUDA加速可以使字幕生成速度提升2-10倍（取决于您的GPU型号和处理任务）。

## 系统要求

要使用CUDA加速，您的系统需要满足以下条件：

- **操作系统**：Windows或Linux（macOS不支持CUDA）
- **显卡**：NVIDIA GPU，支持CUDA
- **驱动程序**：已安装最新的NVIDIA显卡驱动
- **CUDA Toolkit**：已安装与应用兼容的CUDA版本

### 支持的CUDA版本

SmartSub提供了针对不同CUDA版本的发行包：

- **CUDA 11.8.0**：适用于较旧的显卡和驱动
- **CUDA 12.2.0**：适用于较新的显卡和驱动
- **CUDA 12.4.1**：最新版本，支持最新的GPU和功能

### 检查您的CUDA版本

要检查您的系统是否已安装CUDA以及安装的版本：

- **Windows**：打开命令提示符，输入 `nvcc --version`
- **Linux**：打开终端，输入 `nvcc --version`

如果命令返回版本信息，则表示您已安装CUDA。如果提示未找到命令，则需要安装CUDA Toolkit。

## 安装CUDA Toolkit

如果您尚未安装CUDA Toolkit，请按照以下步骤安装：

1. 访问[NVIDIA CUDA下载页面](https://developer.nvidia.com/cuda-downloads)
2. 选择您的操作系统、架构、发行版和版本
3. 下载并按照指示安装CUDA Toolkit
4. 安装完成后重启计算机
5. 通过上述命令验证CUDA是否正确安装

:::tip
建议安装与SmartSub兼容的CUDA版本。例如，如果您下载了支持CUDA 11.8的SmartSub版本，请安装CUDA Toolkit 11.8。
:::

## 选择正确的SmartSub版本

根据您安装的CUDA版本，下载对应的SmartSub版本：

1. 访问[SmartSub发布页面](https://github.com/buxuku/SmartSub/releases)
2. 寻找与您的CUDA版本匹配的版本，例如：
   - `windows-x64_cuda11.8.0`
   - `windows-x64_cuda12.2.0`
   - `windows-x64_cuda12.4.1`
3. 下载并安装相应版本

### 通用版本与优化版本

SmartSub提供两种类型的CUDA支持版本：

- **通用版本(generic)**：适用于大多数NVIDIA GPU
- **优化版本(optimized)**：针对特定GPU架构优化，通常性能更好

如果通用版本运行不稳定，建议尝试使用优化版本。

## 验证CUDA加速是否启用

安装后，您可以验证CUDA加速是否正常工作：

1. 启动SmartSub应用
2. 打开"设置"页面
3. 选择"高级设置"选项卡
4. 确认"启用CUDA加速"选项已勾选
5. 处理一个短视频文件，查看日志输出
6. 如果CUDA正常工作，日志中会显示"使用CUDA加速处理"的信息

## 优化CUDA性能

要获得最佳CUDA加速效果，可以尝试以下优化：

### 1. 更新显卡驱动

最新的NVIDIA驱动程序通常包含性能优化和bug修复：

1. 访问[NVIDIA驱动下载](https://www.nvidia.com/Download/index.aspx)页面
2. 选择您的显卡型号
3. 下载并安装最新驱动

### 2. 调整CUDA设置

在SmartSub的高级设置中，您可以调整CUDA相关参数：

- **CUDA线程数**：根据您的GPU核心数调整
- **CUDA流数量**：控制并行处理的程度
- **CUDA内存池大小**：分配给应用的GPU内存大小

### 3. 关闭其他GPU应用

处理时关闭其他使用GPU的应用程序，以确保SmartSub可以使用全部GPU资源。

### 4. 监控GPU使用情况

使用工具监控GPU使用情况，确保CUDA加速正常工作：

- **Windows**：使用任务管理器的"性能"选项卡
- **Linux**：使用`nvidia-smi`命令
- **两者平台**：可以使用NVIDIA的GPU-Z等工具

## 常见问题解决

### CUDA初始化失败

如果应用报告"CUDA初始化失败"：

1. 确认您已安装正确版本的CUDA Toolkit
2. 检查NVIDIA驱动是否最新
3. 确认您的GPU型号支持CUDA
4. 尝试重新安装CUDA Toolkit

### 性能不如预期

如果CUDA加速效果不明显：

1. 检查GPU使用率是否达到较高水平
2. 确认没有其他应用程序占用GPU资源
3. 尝试使用更小的模型，如medium或small
4. 更新到最新的NVIDIA驱动和CUDA版本

### 应用崩溃

如果启用CUDA后应用崩溃：

1. 尝试使用与您GPU兼容的优化版本
2. 减少并发任务数
3. 降低处理分辨率或采样率
4. 尝试不同版本的CUDA支持（如从12.2切换到11.8）

## 对比：CUDA加速与CPU处理

以下是使用不同配置处理一个10分钟视频的性能比较示例：

| 配置 | 处理时间 | 加速比 |
|------|---------|-------|
| CPU处理 (Core i7) | 约25分钟 | 1.0x |
| CUDA (GTX 1060) | 约10分钟 | 2.5x |
| CUDA (RTX 2080) | 约5分钟 | 5.0x |
| CUDA (RTX 3090) | 约3分钟 | 8.3x |
| CUDA (RTX 4090) | 约2分钟 | 12.5x |

:::note
实际性能会根据您的具体硬件、视频特性、选择的模型以及其他因素而有所不同。
:::

## 需要更多帮助？

如果您在设置或使用CUDA加速时遇到问题，请参考以下资源：

- [NVIDIA CUDA文档](https://docs.nvidia.com/cuda/)
- [SmartSub故障排除指南](../faq/troubleshooting)
- 在[GitHub Issues](https://github.com/buxuku/SmartSub/issues)上提问 