# Design: add-xiaomi-mimo-audio-providers

## Context

MiMo ASR/TTS 均调用 `POST /v1/chat/completions`。ASR 接收单条 WAV/MP3 Base64，编码后字符串上限 10MB，只返回文本；TTS 以 assistant 消息承载播报文本，响应为 Base64 音频。两者均支持普通按量与 Token Plan 专属域名，凭据和 Base URL 不可混用。

## Decisions

### D1 · 品牌型固定模型

ASR/TTS 均注册为 `xiaomiMimo` 品牌型硬单例。模型字段保留在 schema 中但使用单选固定值，便于延续现有 provider 合同且避免把音色设计、复刻模型误暴露进基础接入。

### D2 · 共享 Chat Completions 协议边界

使用内置 `fetch`，不增加 SDK。共享工具负责校验 http(s)、移除尾斜杠或误粘的 `/chat/completions`、Bearer 头与错误正文抽取。默认 Base URL 为按量端点；Token Plan 用户可填控制台专属 URL。

### D3 · ASR 从入口直接预切片

`AsrProviderType.timestampMode='none'` 表示服务商确定不提供原生时间戳。云引擎在 `prepareCloudAudio` 与任何转写请求之前检查该能力，直接调用既有静音切片路径，目标块长 20 秒。每块文本按起止偏移生成粗粒度 cue，词时间轴保持为空。

ASR 原始上传安全上限取 7MiB，使 Base64 后约 9.34MiB，为 10MB 字符串限制和 JSON 开销留余量。语言仅映射 `zh* → zh`、`en* → en`、空/auto → auto，其它明确语言在上传前报错。网络错误和 HTTP 429/500/503 最多重试两次，并尊重取消。

### D4 · TTS 统一音频与语速

基础模型只暴露冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean；省略随集群变化的 `mimo_default`。请求非流式 WAV，不发送 style 或 speed。

响应必须先通过 RIFF/WAVE 校验，再由现有 ffmpeg 管线统一到 24kHz、单声道、PCM16。MiMo 没有数值语速参数，因此适配器在归一化后对 `request.speed` 执行 `atempo`；现有槽位复测仍可追加额外变速。失败请求不自动重试，避免重复合成计费或产生语义不确定的重复调用。

### D5 · 限流与用户提示

ASR/TTS 默认并发 2、请求起始间隔 0.7 秒。TTS 云闸读取可选 `requestInterval`，未配置的既有 provider 继续使用 0 秒。任务模型选择器对 `timestampMode='none'` 的云分组显示本地化“粗粒度时间轴”徽标，不改变保存的模型 ID。

## Risks / Trade-offs

- 20 秒分片时间轴精度低于词级时间戳，但能保证字幕拥有可用时间范围，并避免重复请求。
- TTS 后处理倍速可能带来轻微音质变化；这是兑现全局速度语义所需，且与既有云端超槽处理一致。
- 官方只公开 TTS 限时免费，未给结束日期；UI 与文档不承诺免费额度。ASR 按量价格为国内 0.5 元/小时。

## Migration

无数据迁移。新增类型在未填 API Key 时保持未配置；既有 ASR/TTS provider 的模型、限流与音频路径不变。
