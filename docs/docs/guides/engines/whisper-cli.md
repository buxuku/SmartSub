---
sidebar_position: 8
title: 本地 Whisper CLI
description: 妙幕本地命令行引擎配置指南：调用你自行安装的 whisper 兼容命令（openai-whisper、whisper-ctranslate2 等）执行转写，支持自定义命令模板。
keywords: [whisper 命令行, openai-whisper, 自定义转写命令, whisper CLI]
---

# 本地 Whisper CLI（命令行引擎）

<ProviderMeta
  credentials="无需凭据"
  freeTier="完全免费"
  pricing="本地运行，无费用"
  bestFor="已有 whisper 环境、想复用自己的模型与参数组合的高级用户"
  offline
/>

如果你本机已经装好了 `whisper`（或兼容实现，如 `whisper-ctranslate2`、`insanely-fast-whisper`），可以让妙幕直接调用它转写——复用你现有的模型缓存与调优参数，不用重复下载。

## 在妙幕中配置

「引擎」页面选中「本地命令行」：

<div className="img-container">
  <img src="/img/v3/engines/whisper-cli.webp" alt="本地命令行引擎配置：自定义命令模板" />
</div>

1. 填写**自定义命令**模板，妙幕会在执行时替换其中的变量（音频路径、语言、输出目录等占位符，配置页有说明与示例）
2. 保存后测试一段短音频，确认命令能正常产出字幕文件
3. 任务向导中选择该引擎使用

## 注意事项

- 命令需在系统 PATH 中可执行；macOS 图形应用的 PATH 与终端可能不同，命令找不到时填**绝对路径**（如 `/opt/homebrew/bin/whisper`）
- 转写参数（模型、设备、beam size 等）直接写进命令模板即可，妙幕不干预
- 输出格式需为 SRT（whisper 系命令默认支持 `--output_format srt`）

## 适合谁

- 已用 pip 安装过 openai-whisper 并下载过模型的用户
- 需要特定 fork / 魔改版 whisper 的研究型用户
- 其他用户建议直接用[内置 whisper.cpp](./whisper-cpp) 或 [faster-whisper](./faster-whisper)，免配置

---

> 信息更新于 2026-07。
