# SmartSub

SmartSub 是一个本地优先的视频字幕生成、翻译和校对工具。当前版本重点面向日语视频处理，同时保留 Whisper 本地转录、OpenRouter 转录和多种字幕翻译工作流。

## 功能

- 从视频或音频生成 SRT 字幕
- 支持日语源语言默认配置
- 支持内置 whisper.cpp 模型和本地 Whisper 命令
- 支持 OpenRouter `openai/gpt-4o-transcribe`
- 支持字幕翻译、字幕校对和视频合字幕
- 支持批量任务、任务取消和处理进度展示
- 支持 CUDA 加速包管理和自定义模型目录

## 本地开发

```bash
npm install
npm run dev
```

常用验证命令：

```bash
npm run verify:japanese
npm run verify:transcription
npm run verify:upstream-issues
npm run build
```

## Windows 发布

Windows release 通过 `Release Windows` workflow 生成。手动触发时可以留空版本号，workflow 会读取 `package.json` 的 `version`。
Windows 构建需要提前配置 `WINDOWS_ADDON_URL`，用于下载随安装包打包的加速模块。

## 模型

Whisper 模型可以在应用的「模型管理」页面下载或导入。低端设备建议从 `base` 或 `small` 开始；对精度要求更高时可使用 `large` 或 `large-v3-turbo`。

## 配置

OpenRouter 转录需要在「设置」里配置 API Key。为了获得更稳定的字幕时间轴，OpenRouter 路径会先按静音区间切分音频，再把每段转录结果映射回原始时间线。
加速包下载源由环境变量配置：`SMARTSUB_ADDON_RELEASE_BASE_URL` 用于安装包下载，`SMARTSUB_ADDON_VERSIONS_URL` 用于远程版本检查；可选的镜像源分别使用 `SMARTSUB_ADDON_RELEASE_MIRROR_BASE_URL` 和 `SMARTSUB_ADDON_VERSIONS_MIRROR_URL`。
