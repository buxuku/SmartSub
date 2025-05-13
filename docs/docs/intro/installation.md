---
sidebar_position: 2
title: 下载与安装
---

# 下载与安装

本章节将指导您如何下载和安装妙幕（SmartSub）软件，以便开始使用其强大的字幕生成和翻译功能。

## 系统要求

妙幕支持以下操作系统：

- **Windows**：Windows 10/11 (64位)
- **macOS**：macOS 11.0 或更高版本（支持 Intel 和 Apple Silicon 芯片）
- **Linux**：主流 Linux 发行版

:::note 硬件加速支持

- **NVIDIA CUDA**：需要支持 CUDA 的 NVIDIA 显卡，并安装对应版本的 CUDA Toolkit
- **Apple Core ML**：需要 Apple Silicon (M系列) 芯片的 Mac 设备
  :::

## 选择适合您的版本

根据您的操作系统、处理器和显卡选择合适的版本：

| 系统    | 芯片  | 显卡                    | 下载安装包             |
| ------- | ----- | ----------------------- | ---------------------- |
| Windows | x64   | CUDA >= 11.8.0 < 12.0.0 | windows-x64_cuda11.8.0 |
| Windows | x64   | CUDA >= 12.4.1          | windows-x64_cuda12.4.1 |
| Windows | x64   | CUDA >= 12.2.0          | windows-x64_cuda12.2.0 |
| Windows | x64   | 无 CUDA                 | windows-x64_no_cuda    |
| Mac     | Apple | 支持 CoreML             | mac-arm64              |
| Mac     | Intel | 不支持 CoreML           | mac-x64                |

:::info 关于 CUDA 版本

- **通用版本(generic)**：适用于大多数显卡
- **优化版本(optimized)**：针对特定显卡系列优化，提供更好的兼容性
- CUDA Toolkit 版本理论上向后兼容，请根据您显卡支持的版本选择合适的软件包
  :::

## 下载软件

您可以通过以下方式获取妙幕软件：

1. 访问 [GitHub Release 页面](https://github.com/buxuku/SmartSub/releases/latest)
2. 根据上表选择适合您系统的安装包
3. 点击对应的安装包名称进行下载

## 安装步骤

### Windows

1. 下载 `.exe` 安装文件
2. 双击安装文件启动安装程序
3. 按照安装向导的提示完成安装
4. 安装完成后，从开始菜单或桌面快捷方式启动应用

### macOS

1. 下载 `.dmg` 安装文件
2. 双击打开 DMG 文件
3. 将 Smart Sub 应用拖动到 Applications 文件夹
4. 从启动台或 Applications 文件夹启动应用

:::caution macOS 安全提示
首次运行时，macOS 可能会提示"应用程序已损坏，无法打开"。这是因为应用未经 Apple 公证。您可以通过以下步骤解决：

1. 打开终端(Terminal)
2. 执行以下命令：

```bash
sudo xattr -dr com.apple.quarantine /Applications/Smart\ Sub.app
```

3. 输入您的管理员密码
4. 再次尝试打开应用
   :::

### Linux

1. 下载 AppImage 文件
2. 添加执行权限：

```bash
chmod +x SmartSub-*.AppImage
```

3. 直接运行 AppImage 文件：

```bash
./SmartSub-*.AppImage
```

## 初次启动

安装完成后，首次启动妙幕软件时，您需要：

1. 下载语音识别模型（详见[模型配置](../configuration/models)章节）
2. 配置翻译服务（如需使用翻译功能，详见[翻译服务配置](../configuration/translation-services)章节）

完成这些基本设置后，您就可以开始使用妙幕的强大功能了。

## 下一步

成功安装妙幕后，您可以继续阅读[快速入门](./quickstart)指南，了解如何使用基本功能生成和翻译字幕。
