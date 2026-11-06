---
sidebar_position: 6
title: 常见问题
description: 妙幕（SmartSub）常见问题解答：macOS 应用已损坏、模型下载失败、GPU 加速闪退、云端听写隐私、翻译服务连接失败、Edge TTS 不可用等问题的解决方案。
keywords:
  [
    SmartSub 常见问题,
    应用程序已损坏,
    模型下载失败,
    CUDA 闪退,
    字幕识别不准,
    FAQ,
  ]
---

# 常见问题

遇到问题先来这里查。没找到答案的话，打开[日志中心](/advanced/logs)复制相关日志，到 [GitHub Issues](https://github.com/buxuku/SmartSub/issues) 反馈，或加入 QQ 交流群。

## 安装与启动

### macOS 提示「应用程序已损坏，无法打开」

这是 macOS 对未上架应用的隔离机制，并非应用损坏。终端执行后重新打开：

```bash
sudo xattr -dr com.apple.quarantine /Applications/SmartSub.app
```

### Windows 提示缺少 VCRUNTIME140.dll

安装 [Microsoft Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) 后重启电脑再试。

### 从 2.x 升级要注意什么？

直接安装最新版即可：v3 安装包不再按 CUDA 版本区分，GPU 加速包在应用内按需下载；已有配置与模型继续可用。

## 模型与引擎

### 模型下载缓慢或失败

1. 在「设置 → 下载源（高级）」切换下载源（国内加速 / 官方直连），或配置网络代理
2. 手动下载后导入：从 [hf-mirror 镜像](https://hf-mirror.com/ggerganov/whisper.cpp/tree/main)（国内快）或 [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main) 下载模型文件，在「引擎」页面点「导入模型」，详见[模型选择与导入](/guides/engines/models)
3. 完全不想下模型？改用[云端听写](/guides/cloud-asr/overview)，填 API Key 即可转写

### Apple 芯片提示找不到 encoder.mlmodelc

非量化模型走 CoreML 时需要配套的 `encoder.mlmodelc` 文件：从模型源下载同名文件解压后放模型同目录。`q5` / `q8` 量化模型不需要（自动走 Metal）。也可以在引擎页把加速方式切为「Metal」，全部模型即开即用。

### 启用 GPU 加速后应用闪退

「引擎」页面把加速模式切为「仅 CPU」，或改用其它转写引擎；「检测详情」面板会给出失败原因（驱动过旧、显存不足等）。NVIDIA 用户优先升级显卡驱动。

### 使用 large 模型提示显存不足

换 `medium` / `small`，或用量化版本（如 `large-v3-turbo` 的 q5 / q8），并减少并发任务数。

## 转写与字幕

### 识别结果不准确

1. 换更大的模型（small → medium → large 系列）
2. 明确指定源语言而非「自动检测」
3. 中文内容试试 FunASR / FireRedASR 引擎，多数场景比同级 whisper 模型准
4. 嘈杂音频先降噪；专业术语靠[校对台](/features/proofreading)与 AI 润色兜底

### 处理速度太慢

1. 启用 [GPU 加速](/advanced/hardware-acceleration)
2. 用小一号的模型或量化版本；`large-v3-turbo` 比 `large-v3` 快很多
3. 没有显卡就用[云端听写](/guides/cloud-asr/overview)，速度与本机性能无关

### 字幕一行太长 / 断句不理想

1. 工具栏的「断句与精修」里设置「单条最长字数」，或改用 AI 语义断句
2. 在「场景」里选一个贴近内容的场景（如会议访谈 / 播客、影视 / Vlog、短剧 / 短视频），会一并套用更合适的断句
3. 仍不理想，到「更多设置 › 专家」的「断句精调」里调整单条字幕最长时长与停顿断句间隔

## 翻译

### 翻译服务连接失败

1. 「翻译」页对应服务商点「测试翻译」看具体报错
2. 核对 API Key、Base URL 是否正确，账户余额与请求配额是否充足
3. 网络受限时在「设置 → 网络代理」配置代理
4. 临时切换到「自动免费翻译」应急（无需配置）

### AI 翻译译文错位 / 格式乱

v3.5 起自带多层对齐防护，自动修复大多数错位；仍有问题时在服务商配置里开启「回显对齐校验」，或换一个模型（提示词遵循能力更强的模型错位更少）。

### DeepLX 频繁失败

DeepLX 依赖自部署服务且上游接口不稳定：把并发降到 1–2、增大请求间隔，或改用内置免费翻译 / 其它服务。

### 术语表不生效？

应用内词库只作用于 **AI 翻译**；百度、阿里、火山、腾讯等传统机翻的术语要在对应厂商控制台维护，详见[术语表](/advanced/glossary)。

## 配音与合成

### Edge TTS 用不了了

Edge 免费通道为逆向接口（曾大规模断供），**不承诺可用性**。断供时切换到本地 Kokoro / VITS（免费离线），或 Azure / 火山豆包等正式服务，见[配音服务总览](/guides/tts/overview)。

### 配音时间轴对不上 / 语速被拉快

工作台会自动预控语速、复核时长并向静音间隙借时间；超过 1.5 倍语速红线的行进入人工处理清单——精简该行文案、单行重生成或接受变速，见 [TTS 配音](/features/tts-dubbing#时间轴对齐配音不跑轴)。

### 烧录后的视频体积变大

硬件加速编码同画质下体积可能比 CPU 编码大 30%–100%；对体积敏感时编码方式选 CPU，见[视频合成](/features/video-merge#画质与编码)。

## 视频下载

### 下载引擎安装失败

「下载」页顶部重试安装（走多镜像源）；也可在「设置 → 网络代理」配好代理后重试。

### 视频只有低清晰度可选 / 会员内容下载失败

多数平台高清与会员内容需要登录态：点「站点 Cookie」导入浏览器登录态后重新解析，见[在线视频下载](/features/video-download#站点-cookie解锁高清与会员内容)。

## 隐私

### 使用云端服务时，我的数据去哪了？

- 本地引擎（whisper.cpp / FunASR / 本地 TTS 等）：**文件不出本机**
- 云端听写 / 云端翻译 / 云端配音：内容会上传到**你自己配置的服务商端点**，妙幕不经手第三方中转；首次使用云端听写有隐私确认。请勿用云端服务处理敏感内容
- 站点 Cookie 仅保存在本地，只用于下载请求

## 还没解决？

1. 打开[日志中心](/advanced/logs)复制错误前后的日志
2. 附上应用版本、系统信息与复现步骤，[提交 Issue](https://github.com/buxuku/SmartSub/issues)
3. 或加入 QQ 交流群交流（入口见 [GitHub 仓库](https://github.com/buxuku/SmartSub)）
