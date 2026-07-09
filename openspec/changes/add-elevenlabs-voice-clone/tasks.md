# Tasks: add-elevenlabs-voice-clone

- [x] 1.1 `types/voiceClone.ts`：`VoiceCloneEngine` 增 `'elevenlabs'`、`CLONE_TARGET_RANGES.elevenlabs`（5s/30–120s/180s）、svoice 校验放通（EL 需 speakerId 同火山）；`types/ttsProvider.ts` ELEVENLABS capabilities.clone
- [x] 1.2 `elevenlabsVoiceCloneUtils.ts` 纯函数：`buildElevenAddVoiceURL/buildElevenDeleteVoiceURL`（base 规范化复用）、`elevenCloneErrorHint`（401 凭据/voice_limit_reached 槽位上限/素材拒绝）+ 单测
- [x] 1.3 `elevenlabsVoiceClone.ts`：`addElevenVoice(provider, {name, refWavPath, removeNoise})`（原生 FormData/Blob multipart → voice_id）与 `deleteElevenVoice(provider, voiceId)`
- [x] 1.4 `ipcVoiceCloneHandlers.ts`：create EL 分支（provider 校验 → prepare → addVoice → speakerId/providerId/ready 入库 → EL 通道试听样本）；remove 时 EL 音色 best-effort 删云端；import 重绑同品牌实例
- [x] 1.5 向导：引擎第三卡（需就绪 EL provider）；EL 跳过 Step3；Step2 处理选项 EL 分支「服务端去背景音」Switch；Step4 无槽位输入（语言选择 + 槽位占用提示）
- [x] 1.6 `useDubbing` 克隆音色注入泛化为云端引擎按 providerId 绑定（volcengine→豆包实例、elevenlabs→EL 实例）；`ClonedVoicePanel`/列表引擎标 i18n
- [x] 1.7 回归：test:voice-clone（156 passed）/ test:dubbing（137 passed）/ check:i18n ✓ / build ✓；真机（用户，需 EL 订阅）待验证
