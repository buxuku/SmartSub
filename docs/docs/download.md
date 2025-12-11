---
sidebar_position: 2
title: 下载软件
---

# 下载妙幕（SmartSub）

在本页面，您可以找到妙幕（SmartSub）软件的最新版本下载链接，以及如何选择适合您系统的版本。

## 最新版本

当前最新稳定版本：[![Release](https://img.shields.io/github/v/release/buxuku/SmartSub?style=flat-square&logo=github&color=blue)](https://github.com/buxuku/SmartSub/releases/latest)

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<div className="download-section" style={{marginTop: '40px', marginBottom: '40px'}}>
  <Tabs groupId="os-choice" queryString="os">
    <TabItem value="windows" label="Windows" default>
      <div className="row" style={{marginBottom: '1rem'}}>
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Windows (NVIDIA CUDA 12.4.0+)</h3>
            </div>
            <div className="card__body">
              <p>适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 12.4.0 或更高版本。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Windows_2.3.7_x64_12.4.1_optimized.exe" className="button button--primary button--block">
                下载 (EXE)
              </a>
            </div>
          </div>
        </div>
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Windows (NVIDIA CUDA 12.2.0+)</h3>
            </div>
            <div className="card__body">
              <p>适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 12.2.0 或更高版本。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Windows_2.3.7_x64_12.2.0_optimized.exe" className="button button--primary button--block">
                下载 (EXE)
              </a>
            </div>
          </div>
        </div>
      </div>
      <div className="row">
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Windows (NVIDIA CUDA 11.8.0)</h3>
            </div>
            <div className="card__body">
              <p>适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 11.8.0 版本。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Windows_2.3.7_x64_11.8.0_optimized.exe" className="button button--primary button--block">
                下载 (EXE)
              </a>
            </div>
          </div>
        </div>
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Windows (无 CUDA)</h3>
            </div>
            <div className="card__body">
              <p>适用于 Windows x64 系统。如果您没有 NVIDIA 显卡，或不确定 CUDA 版本，请选择此版本。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Windows_2.3.7_x64_no_cuda_optimized.exe" className="button button--primary button--block">
                下载 (EXE)
              </a>
            </div>
          </div>
        </div>
      </div>
    </TabItem>
    <TabItem value="macos" label="macOS">
      <div className="row">
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Mac (Apple Silicon)</h3>
            </div>
            <div className="card__body">
              <p>适用于配备 Apple Silicon (M系列) 芯片的 Mac。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Mac_2.3.7_arm64.dmg" className="button button--primary button--block">
                下载 (DMG)
              </a>
            </div>
          </div>
        </div>
        <div className="col col--6" style={{marginBottom: '1rem'}}>
          <div className="card">
            <div className="card__header">
              <h3>Mac (Intel)</h3>
            </div>
            <div className="card__body">
              <p>适用于配备 Intel 处理器的 Mac。</p>
            </div>
            <div className="card__footer">
              <a href="https://github.com/buxuku/SmartSub/releases/download/v2.3.7/SmartSub_Mac_2.3.7_x64.dmg" className="button button--primary button--block">
                下载 (DMG)
              </a>
            </div>
          </div>
        </div>
      </div>
    </TabItem>
  </Tabs>
</div>

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
