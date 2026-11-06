---
title: 代码签名策略（Code signing policy）
description: 妙幕（SmartSub）Windows 安装包的代码签名策略：签名提供方、签名范围与流程、团队角色，以及隐私政策。
keywords:
  [SmartSub 代码签名, 妙幕 代码签名, SignPath, Windows 安装包签名, 隐私政策]
---

# 代码签名策略（Code signing policy）

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/)

妙幕（SmartSub）是开源项目。Windows 安装包的代码签名由 [SignPath.io](https://about.signpath.io/) 免费提供，证书由 [SignPath Foundation](https://signpath.org/) 签发。

:::note 当前状态
签名从证书签发后的首个版本开始生效，此前发布的版本未签名。
:::

## 签名范围

- 只签名 Windows 安装包 `SmartSub_Windows_<版本>_x64.exe`，也就是本项目自己构建的文件。
- 不签名第三方二进制文件。
- macOS 与 Linux 安装包不在本策略范围内。

## 签名流程

1. 维护者推送版本标签（例如 `v3.10.2`），GitHub Actions 在 GitHub 托管的运行环境里，从[源码仓库](https://github.com/buxuku/SmartSub)构建安装包。
2. 构建产物提交给 SignPath。SignPath 会校验它确实来自本仓库的这次构建，不接受从其它地方上传的文件。
3. 每个正式版本在签名前都需要 Approver 人工批准。
4. 签名完成后，安装包发布到 [GitHub Releases](https://github.com/buxuku/SmartSub/releases)。

整个流程的配置都在仓库的 [release.yml](https://github.com/buxuku/SmartSub/blob/main/.github/workflows/release.yml) 里，可以公开查看。

## 如何验证签名

在已签名的安装包上右键，选择「属性」→「数字签名」，签名者应为 SignPath Foundation。

## 团队角色

| 角色      | 职责                              | 成员                                 |
| --------- | --------------------------------- | ------------------------------------ |
| Authors   | 可以直接修改源码                  | [@buxuku](https://github.com/buxuku) |
| Reviewers | 审核外部贡献者提交的 Pull Request | [@buxuku](https://github.com/buxuku) |
| Approvers | 批准每一次发布签名                | [@buxuku](https://github.com/buxuku) |

## 隐私政策 {#privacy-policy}

以下说明针对 SmartSub 桌面应用。

- **不收集使用数据**：SmartSub 不收集、不上传任何使用数据，也不含统计或遥测 SDK。
- **启动时的网络请求**：启动时自动联网只用于检查更新，共两项：
  - 应用更新：向 GitHub Releases 请求版本信息。可以在设置中关闭「启动时检查更新」。
  - faster-whisper 运行时更新：只有安装了该运行时才会进行，每天一次（失败时下次启动重试）。请求 GitHub 上的两个静态文件（`checksums.sha256` 和 `manifest.json`），GitHub 不可用时依次尝试 GitCode 和 GitHub 代理镜像（ghproxy）。只提示有新版本，不自动下载，也不受「启动时检查更新」开关控制。
- **使用功能时才联网**：
  - 下载语音模型、GPU 加速包和视频下载引擎（yt-dlp / lux）。
  - 下载在线视频：只访问你输入的链接。
  - 云端听写、云端翻译、云端配音，以及内置的免费翻译（有道 / 必应 / 谷歌接口）：相关音频或文本会发送到你选择或配置的服务。开始云端听写任务前会弹出隐私确认，勾选「不再提醒」后不再弹出。这些服务适用它们各自的隐私政策，请勿用它们处理敏感内容。
- **本地引擎**：whisper.cpp、FunASR、本地 TTS 等本地引擎处理的文件不出本机。
- **本机保存**：API 凭据、站点 Cookie 和任务数据只保存在本机。崩溃诊断与日志不会自动上传，诊断包由你自己决定是否附到问题反馈里。

## 反馈

如果你对已签名的文件有疑问，或发现签名被滥用，请在 [GitHub Issues](https://github.com/buxuku/SmartSub/issues) 反馈，也可以联系 SignPath 的支持邮箱 [support@signpath.io](mailto:support@signpath.io)。
