## Why

克隆音色向导第③步「参考文本」的自动转写目前只走 FunASR SenseVoice（再回落云 ASR）。用户已安装 faster-whisper / whisper.cpp 模型时仍会看到「没有可用的语音识别引擎」，与任务页「本地引擎已就绪」的心智冲突；统一存储路径把 FunASR 扫空后问题更易暴露。需要把「本地 ASR」对齐为窄级联探测，并修正不可用文案。

## What Changes

- 参考文本 ASR：本地候选扩为 **SenseVoice（FunASR）→ faster-whisper（最小已装 CT2）→ builtin ggml（最小已装模型）→ 云 ASR → 手动**
- 轻量 `wav→text` 调用（不走任务 `TranscribeContext` / 写 SRT）
- 本地尝试期间占用既有转写闸门；IPC 传入 `AbortSignal`
- `engineLabel` 反映真实引擎；不可用文案明确列出探测范围（SenseVoice / Whisper / 云 ASR）
- **不做**：Qwen / FireRed、向导引擎下拉、统一存储路径引导/搬迁

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `voice-clone`: 参考文本获取的「本地 ASR」从单一 SenseVoice 扩展为窄级联；不可用提示与 `engineLabel` 语义更新

## Impact

- `main/helpers/voiceClone/referenceTranscriber.ts`（主改）
- `main/helpers/ipcVoiceCloneHandlers.ts`（AbortSignal）
- `renderer/public/locales/{zh,en}/voiceClone.json`（文案）
- 可能轻触 `CloneVoiceWizard.tsx`（若需展示更细失败原因）
- 复用：funasr / modelCatalog / whisper / pythonRuntime / transcribeGate / 云 ASR 既有入口
