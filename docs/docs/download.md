---
sidebar_position: 2
title: 下载软件
---

# 下载妙幕（SmartSub）

在本页面，您可以找到妙幕（SmartSub）软件的最新版本下载链接，以及如何选择适合您系统的版本。

## 最新版本

当前最新稳定版本：[![Release](https://img.shields.io/github/v/release/buxuku/SmartSub?style=flat-square&logo=github&color=blue)](https://github.com/buxuku/SmartSub/releases/latest)

您可以通过以下按钮访问最新版本的下载页面：

<div style={{textAlign: 'center', margin: '30px 0'}}>
  <a href="https://github.com/buxuku/SmartSub/releases/latest" className="button button--primary button--lg">
    下载最新版
  </a>
</div>

## 选择适合您的版本

妙幕提供针对不同操作系统和硬件配置的版本。请根据您的系统环境选择合适的安装包：

| 系统    | 芯片  | 显卡                    | 下载安装包             |
| ------- | ----- | ----------------------- | ---------------------- |
| Windows | x64   | CUDA >= 11.8.0 < 12.0.0 | windows-x64_cuda11.8.0 |
| Windows | x64   | CUDA >= 12.4.1          | windows-x64_cuda12.4.1 |
| Windows | x64   | CUDA >= 12.2.0          | windows-x64_cuda12.2.0 |
| Windows | x64   | 无 CUDA                 | windows-x64_no_cuda    |
| Mac     | Apple | 支持 CoreML             | mac-arm64              |
| Mac     | Intel | 不支持 CoreML           | mac-x64                |

:::info 如何选择

- **Windows 用户**：如果有 NVIDIA 显卡，推荐选择对应 CUDA 版本的安装包；如果没有 NVIDIA 显卡或不确定，选择 no_cuda 版本
- **Mac 用户**：如果使用 M1/M2/M3 等 Apple Silicon 芯片的 Mac，选择 mac-arm64 版本；如果使用 Intel 芯片的 Mac，选择 mac-x64 版本
  :::

### 关于 CUDA 版本

- **通用版本 (generic)**：适用于大多数显卡，兼容性好
- **优化版本 (optimized)**：针对特定显卡系列优化，提供更好的兼容性和性能
- CUDA Toolkit 版本理论上向后兼容，请根据您显卡支持的版本选择合适的软件包

## 安装前准备

### 验证系统要求

- **Windows**: Windows 10/11 (64位)
- **macOS**: macOS 11.0 或更高版本
- **硬件加速**:
  - **NVIDIA CUDA**: 需要支持 CUDA 的 NVIDIA 显卡并安装 CUDA Toolkit
  - **Apple Core ML**: 需要 Apple Silicon (M系列) 芯片的 Mac 设备

### 下载 CUDA Toolkit (如需 CUDA 加速)

如果您打算使用 CUDA 加速功能，需要先安装对应版本的 CUDA Toolkit:

1. 访问 [NVIDIA CUDA 下载页面](https://developer.nvidia.com/cuda-downloads)
2. 选择您的操作系统和版本
3. 下载并安装 CUDA Toolkit

## 历史版本

您可以在 [GitHub Releases 页面](https://github.com/buxuku/SmartSub/releases) 找到所有历史版本的下载链接。

## 网络问题解决方案

如果您在中国大陆地区下载 GitHub 发布的文件遇到困难，可以尝试以下方法：

1. 使用国内镜像网站（如果有）
2. 使用加速器或代理服务
3. 尝试在非高峰时段下载

## 安装后配置

成功下载并安装妙幕后，您需要：

1. [下载语音识别模型](./configuration/models)
2. [配置翻译服务](./configuration/translation-services)（如需使用翻译功能）

有关详细的安装和配置指南，请参阅[安装指南](./intro/installation)章节。

## 支持与反馈

如果您在下载或安装过程中遇到任何问题，可以：

1. 查看[常见问题](./faq)章节
2. 在 [GitHub Issues](https://github.com/buxuku/SmartSub/issues) 中搜索或提交问题
3. 加入微信交流群获取社区支持
