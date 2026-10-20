---
sidebar_position: 2
title: 下载软件
description: 下载妙幕（SmartSub）最新版：Windows、macOS（Homebrew / DMG）、Linux（deb / AppImage）安装包，以及夸克网盘与历史版本入口。
keywords: [SmartSub 下载, 妙幕下载, 字幕软件下载, 视频转字幕软件]
---

# 下载妙幕（SmartSub）

当前最新稳定版本：[![Release](https://img.shields.io/github/v/release/buxuku/SmartSub?style=flat-square&logo=github&color=blue)](https://github.com/buxuku/SmartSub/releases/latest)

import DownloadCards from '@site/src/components/DownloadCards';

<DownloadCards />

:::tip 不用按显卡选包
v3 起每个平台只有一个安装包。GPU 加速包（CUDA / Vulkan）安装后在应用内按需下载，无需预装 CUDA Toolkit；Apple 芯片自动启用 Core ML / Metal。
:::

## 其它下载渠道

- **夸克网盘**（国内推荐）：https://pan.quark.cn/s/0b16479b40ca
- **GitHub Releases**（全部历史版本）：https://github.com/buxuku/SmartSub/releases

## 代码签名策略（Code signing policy）

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/)

Windows 安装包的签名范围、团队角色和隐私政策，见[代码签名策略](/code-signing-policy)。签名从证书签发后的首个版本开始生效，此前发布的版本未签名。

## 安装遇到问题？

- macOS 提示「应用程序已损坏」、Windows SmartScreen 拦截等安装问题，见[下载与安装](/intro/installation)
- 模型下载缓慢或失败，见[模型选择与导入](/guides/engines/models)
- 其它问题查阅[常见问题](/faq)

## 更新升级

- 应用内置更新检测（设置中可开关「启动时检查更新」）
- Homebrew 用户：`brew upgrade --cask smartsub`
- 也可以直接下载新版覆盖安装，配置与模型不受影响
