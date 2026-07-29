## Context

克隆参考文本转写在 `referenceTranscriber.ts`：切选区临时 16k mono wav → SenseVoice（sherpa）→ 首个已配置云 ASR → `{available:false}`。任务转写走 `TranscriptionEngineAdapter` + `TranscribeContext`（写 SRT、进度、断句），不宜复用。既有轻量入口：sherpa `runtime.transcribe`、faster-whisper `PythonRuntimeManager.transcribe`、builtin `whisperAsync`、云 `getAsrTranscriber`。转写闸门在 `transcribeGate.ts`（sherpa / faster-whisper 互斥）。

## Goals / Non-Goals

**Goals:**

- 窄本地级联：FunASR SenseVoice → faster-whisper → builtin ggml，再云 ASR，再手动
- 与 UI「已装模型」判定同源（catalog / `getModelsInstalled` / runtime installed）
- 短音频冷启动可控：优先小模型（tiny→base→…）
- 正确 `engineLabel` + 诚实不可用文案
- 闸门 + AbortSignal，避免与批量任务抢资源、取消可中断

**Non-Goals:**

- Qwen / FireRed 入链
- 向导内引擎选择器（方案 B）
- 统一 `storageRoot` 搬迁/打开旧目录引导（另案）
- 经任务 adapter 全量转写管线

## Decisions

### D1 · 窄级联顺序

1. FunASR（优先 `sensevoice-small`，否则其它已装 FunASR ASR）— 保留原设计：免费、auto 语种、常与克隆 VAD 共用 sherpa worker
2. faster-whisper — 用户常见安装；挑最小已装 CT2
3. builtin whisper.cpp — 挑最小已装 ggml
4. 云 ASR（现逻辑）
5. `available: false`

_备选_：宽级联含 Qwen/FireRed — 模型过大、对 5–15s 过重，首版排除。

### D2 · 轻量调用，不经 adapter

各候选直接调底层 API，拼接 segments/`text` 为纯文本；不写 SRT、不发 `taskFileChange`。

### D3 · 最小模型启发式

CT2 / ggml：在已装集合中按 `tiny` → `tiny.en` → `base` → `base.en` → `small` → … 取第一个命中；无命中则取 catalog 列出的任意已装项。FunASR：优先 sensevoice。

### D4 · 转写闸门

本地 sherpa / faster-whisper 尝试 MUST `acquireTranscribeSlot` / release（与任务同锁）。builtin 若现网无槽也可不占 sherpa/Python 锁，但取消仍尊重 signal。

### D5 · AbortSignal

`voiceClone:transcribeRange` 经任务上下文或 handler 内 AbortController 把 signal 传入 `transcribeReferenceRange` 与 `cutRangeWav`；向导关闭/重识别应中止在途请求。

### D6 · 文案

`transcribeUnavailable` 改为说明：未检测到可用的 SenseVoice / Whisper（faster-whisper 或内置）/ 已配置云 ASR，请边听边手动输入（或安装模型 / 配置云服务）。不暗示「机器上完全没有引擎」。

## Risks / Trade-offs

- [faster-whisper 冷启动慢] → 向导已有 loading；优先小模型；失败继续下一候选
- [与批量任务抢锁] → D4 闸门；等待或失败后降级下一候选/云/手动
- [storageRoot 下本地全空] → 本变更不修路径；文案仍诚实，用户清统一根或搬模型后级联生效
- [多候选失败噪声日志] → 每候选 warning 一行，不刷屏 error

## Migration Plan

无数据迁移；默认行为对已装 SenseVoice 用户不变（仍第一优先）。回滚 = 恢复单一 SenseVoice 路径。

## Open Questions

（无 — 探索阶段已拍板：窄级联；仅级联+文案；闸门与 AbortSignal 采纳。）
