# Proposal: add-elevenlabs-voice-clone

> 依据：既定后续清单第 3 项（用户拍板）。`TtsCapabilities.clone` 与 `ClonedVoice` 双轨架构从设计起即预留第三轨；ElevenLabs TTS provider（合成/音色映射/错误分类）已在 Phase 1.5 接入。

## Why

克隆双轨的空档：zipvoice 免费但相似度有天花板、跨语言弱；火山复刻质量高但需国内账号 + 付费槽位。ElevenLabs 即时克隆（IVC）填补国际用户与跨语言场景——多语种克隆能力业界第一梯队（29 语种同一音色）、**即时可用（无训练轮询）**、随订阅套餐附带（Starter 起含 10 个 IVC 槽）。合成侧零新增：IVC 产出的 `voice_id` 直接走现有 ElevenLabs synthesize 通道。

## What Changes

- **引擎第三轨**：`VoiceCloneEngine` 增 `'elevenlabs'`；`CLONE_TARGET_RANGES.elevenlabs = {min 5s, ideal 30–120s, max 180s}`（官方推荐 1–2 分钟素材；质检/选段/波形全链路参数化自动适配）。
- **IVC API**（`main/service/tts/elevenlabsVoiceCloneUtils.ts` 纯函数 + `elevenlabsVoiceClone.ts`）：
  - 创建 `POST /v1/voices/add`（`xi-api-key` + multipart：name/files/remove_background_noise）→ 即返 `voice_id`；
  - 删除 `DELETE /v1/voices/{id}`（本地删除音色时 best-effort 同步删云端——IVC 槽位有限，不删占坑）；
  - 错误分类：401 凭据 / 槽位上限（voice_limit_reached）/ 素材拒绝。
- **向导分叉**：引擎选择第三卡（需已配置 ElevenLabs provider）；**跳过参考文本步**（IVC 不需要转写）；Step2 处理选项卡 EL 分支提供「服务端去背景音」开关（`remove_background_noise`）；Step4 无槽位输入（voice 自动创建，音色名即 EL voice name）；创建即 ready + 试听样本（走 EL 合成通道）。
- **工作台注入**：EL 克隆音色（speakerId = voice_id）注入对应 ElevenLabs provider 实例的音色下拉（复用火山注入形制，判定改为按 engine→providerType 映射）。
- **类型能力位**：`TTS_ELEVENLABS.capabilities.clone = true`。

**不做**：PVC（专业克隆，需 30 分钟素材 + 官方审核流程）；语音库分享/社区音色。

## Capabilities

### Modified Capabilities

- `voice-clone`：新增「ElevenLabs 即时克隆引擎」Requirement（IVC 创建/删除同步/无文本步/即时可用语义）。
- `tts-cloud-providers`：ElevenLabs Requirement 增补克隆能力位与 IVC voice_id 合成语义。

## Impact

- **types**：`voiceClone.ts`（engine 联合 + target range + svoice 引擎校验放通）、`ttsProvider.ts`（capabilities.clone）。
- **main**：新增 `elevenlabsVoiceCloneUtils.ts`/`elevenlabsVoiceClone.ts`；`ipcVoiceCloneHandlers.ts`（create EL 分支 + remove 云端同步）。
- **renderer**：`CloneVoiceWizard`（第三卡/跳文本步/去背景音开关）、`useDubbing`（EL 克隆音色注入）、`ClonedVoicePanel`（EL 引擎标）；i18n。
- **测试**：utils 固定向量单测（URL/表单字段/错误分类/引擎校验）。
