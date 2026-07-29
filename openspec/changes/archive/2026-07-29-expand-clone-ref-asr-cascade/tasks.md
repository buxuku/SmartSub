## 1. 本地窄级联核心

- [x] 1.1 在 `referenceTranscriber.ts` 抽取 segments/`text` 拼接与候选结果类型（含 `engineLabel`）
- [x] 1.2 保留并整理 FunASR 候选（优先 SenseVoice；`isReady` 与 catalog 同源；sherpa 闸门）
- [x] 1.3 新增 faster-whisper 候选：runtime + 最小 CT2 启发式；`PythonRuntimeManager.transcribe`；闸门
- [x] 1.4 新增 builtin ggml 候选：`getModelsInstalled` + 最小模型启发式；`whisperAsync` 取纯文本
- [x] 1.5 `transcribeReferenceRange` 按 SenseVoice → CT2 → ggml → 云 串联；单候选失败记 warning 继续；成功提前返回

## 2. 取消与 IPC

- [x] 2.1 `voiceClone:transcribeRange` 传入 `AbortSignal`（任务上下文或 handler AbortController）到 `cutRangeWav` / 各候选
- [x] 2.2 确认向导关闭或重新识别时在途转写可中止（不留僵尸请求）

## 3. 文案与展示

- [x] 3.1 更新 `voiceClone.json` zh/en `transcribeUnavailable`（点明 SenseVoice / Whisper / 云 ASR）
- [x] 3.2 确认向导「由 {{engine}} 识别」使用真实 `engineLabel`（非写死 SenseVoice）
- [x] 3.3 `check:i18n` 通过

## 4. 验证

- [x] 4.1 手测：仅 SenseVoice → 仍走 FunASR、不出网
- [x] 4.2 手测：无 FunASR、有 faster-whisper 或 ggml → 本地回落成功并显示引擎名
- [x] 4.3 手测：本地全无、云可用 / 全无 → 云或手动文案正确
- [x] 4.4 如有现成单测脚手架，为最小模型启发式补纯函数测；否则手测记录即可
