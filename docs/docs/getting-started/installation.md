---
sidebar_position: 1
---

# 下载安装

本页面将指导您如何获取并安装SmartSub软件。

## 系统要求

SmartSub支持以下操作系统：

- Windows 7及以上版本
- macOS 10.13及以上版本
- Linux (Ubuntu, Debian等主流发行版)

## 选择适合您的版本

根据您的系统和硬件配置，选择适合的版本：

| 系统 | 芯片 | 显卡 | 下载安装包 |
| ---- | ---- | ---- | ---- |
| Windows | x64 | CUDA >= 11.8.0 < 12.0.0 | windows-x64_cuda11.8.0 |
| Windows | x64 | CUDA >= 12.4.1 | windows-x64_cuda12.4.1 |
| Windows | x64 | CUDA >= 12.2.0 | windows-x64_cuda12.2.0 |
| Windows | x64 | 无 CUDA | windows-x64_no_cuda |
| Mac | Apple | 支持 CoreML | mac-arm64 |
| Mac | Intel | 不支持 CoreML | mac-x64 |

:::tip
如果您使用带CUDA支持的版本，请确保已安装对应版本的CUDA驱动。您可以在[NVIDIA官网](https://developer.nvidia.com/cuda-downloads)下载CUDA toolkit。
:::

:::info 关于CUDA版本
- **带 *generic* 的版本**：是通用的版本，理论上支持常见的显卡
- **带 *optimized* 的版本**：是优化版本，提供了针对各个系列显卡的优化，兼容性更强
:::

## 下载安装步骤

1. 前往 [GitHub Releases](https://github.com/buxuku/SmartSub/releases) 页面
2. 根据您的系统和硬件配置，选择适合的版本下载
3. 下载完成后：
   - Windows: 双击`.exe`安装文件，按照提示完成安装
   - macOS: 双击`.dmg`文件，将应用拖到应用程序文件夹
   - Linux: 解压`.AppImage`文件，赋予执行权限后运行

### macOS注意事项

如果在macOS上运行时提示"应用已损坏"，请在终端中执行以下命令：

```bash
sudo xattr -dr com.apple.quarantine /Applications/SmartSub.app
```

之后再次启动应用即可。

## 首次启动

安装完成后，首次启动SmartSub时，您需要：

1. 下载运行所需的语音识别模型(详见[下载模型](download-models)章节)
2. 配置翻译服务(如需使用翻译功能)

这些设置都可以在后续使用中随时调整。

## 升级到新版本

当新版本发布时，您可以：

1. 前往[GitHub Releases](https://github.com/buxuku/SmartSub/releases)页面下载最新版本
2. 安装新版本(无需卸载旧版本，直接安装即可覆盖)
3. 所有您的设置和已下载的模型都将保留

## 从源码安装（开发人员）

如果您是开发人员并想从源码安装：

```bash
# 克隆代码仓库
git clone https://github.com/buxuku/SmartSub.git

# 进入项目目录
cd SmartSub

# 安装依赖
yarn install
# 或
npm install

# 启动开发环境
yarn dev
# 或
npm run dev
```

## 问题排查

如果您在安装或启动过程中遇到问题，请参考[常见问题](../faq/troubleshooting)章节或在[GitHub](https://github.com/buxuku/SmartSub/issues)上提交issue。 