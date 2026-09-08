# Proposal: add-xiaomi-mimo-audio-providers

## Why

妙幕已有统一云 ASR 与云 TTS 框架，但 Xiaomi MiMo 的音频模型使用 Chat Completions 多模态协议，不能通过现有 `audio/transcriptions` 或 `audio/speech` 兼容入口接入。用户需要在国内可直连的同一平台完成转写和基础配音，并准确理解 ASR 计费与 TTS 限时免费的差异。

## What Changes

- 新增 Xiaomi MiMo 品牌型 ASR 服务商，固定使用 `mimo-v2.5-asr`。
- MiMo ASR 无原生词/段时间戳，直接按静音切为约 20 秒分片后转写，避免整文件请求后再次计费转写。
- 新增 Xiaomi MiMo 品牌型 TTS 服务商，固定使用 `mimo-v2.5-tts` 与 8 个预置音色。
- MiMo TTS 输出统一为 24kHz 单声道 PCM16 WAV；因 API 无数值语速参数，在适配器内用 `atempo` 应用任务整体语速。
- ASR 和 TTS 共用 URL 归一化、Bearer 鉴权与错误提取，兼容按量及 Token Plan Base URL。
- 配置 UI、模型选择器提示、中英文资源、README 与文档站同步新增 MiMo 信息。

## Capabilities

### Modified Capabilities

- `cloud-asr-transcription`: 增加 Xiaomi MiMo ASR、无时间戳服务商预切片和粗粒度时间轴提示。
- `tts-cloud-providers`: 增加 Xiaomi MiMo 基础 TTS、请求间隔和后处理语速。
- `docs-provider-guides`: 增加 MiMo ASR/TTS 独立配置指南与总览入口。

## Impact

- `types/{asrProvider,ttsProvider}.ts`
- `main/service/{xiaomiMimoUtils,asr/xiaomiMimo,tts/xiaomiMimo}.ts`
- `main/helpers/engines/cloudAsrEngine.ts`
- `main/helpers/dubbing/dubbingProcessor.ts`
- `renderer/components/Models.tsx` 与 zh/en 资源
- `docs/docs/guides/{cloud-asr,tts}`、README zh/en/ja

不包含 SSE 流式、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 或自然语言风格指令。
