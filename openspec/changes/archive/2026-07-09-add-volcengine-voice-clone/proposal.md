# Proposal: add-volcengine-voice-clone

> 依据：`add-volcengine-tts-provider`（已归档）Non-Goals 显式预留「声音复刻（`seed-icl-*` 资源、`S_` 开头音色、`model_type` 参数）——属 v2 克隆能力域」；`add-voice-clone` 已落地克隆基建（`ClonedVoice` 实体、创建向导、质检管线、`CLONE_TARGET_RANGES.volcengine` 参数）——本变更补上云端引擎绑定层。

## Why

本地 zipvoice 克隆免费即时，但 int8 蒸馏模型的相似度与自然度有天花板；火山「声音复刻 2.0」（ICL，10–30s 参考音频）是 2026-07 调研的中文克隆产品级梯队，且豆包 TTS provider 已接入（合成通道、错误分类、音色展示体系现成）。用户已在 `add-voice-clone` 里获得完整的创建向导与质检管线（火山档位参数 `CLONE_TARGET_RANGES.volcengine` 从第一天就在），缺的只是：训练/状态两个 API、双凭据、合成资源路由。对追求产品级效果、接受付费购买音色槽位的用户，这是最小成本的质量升档。

## What Changes

- **豆包 TTS 类型扩展克隆凭据与能力位**：`volcengine` 类型新增可选字段 `appId`（APP ID）与 `accessToken`（Access Token）——声音复刻训练接口走旧版双凭据（`X-Api-App-Key` + `X-Api-Access-Key`），与合成用的单 `X-Api-Key` 并存；`capabilities.clone: true`。仅配置合成 Key 的用户零影响（克隆字段可选，不参与 `isTtsProviderConfigured` 就绪判定）。
- **训练与状态 API**（`main/service/tts/volcengineVoiceClone.ts` + `volcengineVoiceCloneUtils.ts` 纯工具）：
  - 训练 `POST /api/v3/tts/voice_clone`：speaker*id（用户在控制台购买的 `S*`槽位）+ 参考音频 base64（wav，来自克隆管线 prepare 产物，≤10MB 上限校验）+`language`（cn=0/en=1）+ `model_types: [4]`（ICL 2.0）+ 可选 `extra_params`（`enable_audio_denoise`服务端降噪 /`voice_clone_enable_mss` 音源分离——质检黄牌时的服务端兜底开关）；
  - 状态 `POST /api/v3/tts/voice_clone/status`：`status` 2（Success）/ 4（Active）判可用；
  - 错误分类定向引导（形制 `volcTtsErrorHint`）：凭据无效 / speaker_id 不存在或已删除 / 训练次数上限 / 音频质量拒绝（WER/SNR）。
- **合成资源路由**：`S_` 开头音色（克隆音色）合成时 `X-Api-Resource-Id` 自动切 `seed-icl-2.0`（纯函数 `volcResourceIdForVoice`，普通音色沿用实例 `resourceId` 不变）。试听（testConnection / previewVoice）同路由。
- **创建向导引擎分叉**：Step1 顶部新增引擎选择（本地 ZipVoice 免费 / 火山复刻 2.0 需购买槽位，带 docsUrl 外链与定价提示）；火山分支：质检档位切 `CLONE_TARGET_RANGES.volcengine`（推荐 10–25s）、**跳过参考文本步**（训练接口不需要转写文本），Step4 增 speaker*id 输入（S* 前缀校验 + 控制台指引）、服务端降噪/音源分离开关（默认关，质检有 low-snr 黄牌时建议开）；创建 = 上传训练 → 轮询状态（约 90s 内）→ ready 后合成试听样本（走豆包合成通道）。轮询未就绪不阻塞——音色以 `training` 状态入库，面板/向导可手动刷新。
- **工作台注入**：火山克隆音色（`trainStatus='ready'`）注入对应豆包 provider 实例的 voice 下拉（id = speakerId、label = 音色名，与内置音色同池展示）。
- **管理面板**：`ClonedVoicePanel` 火山分支——训练状态 Badge（训练中/可用/失败）、手动刷新状态、失败原因展示与重新上传。

**不做**（Non-Goals）：ElevenLabs 即时克隆（后续变更）；`demo_text` 试听文本参数（用本地合成试听替代）；DiT 系列 `model_type 2/3`（ICL 2.0 是官方主推）；训练接口的 `text` WER 校验参数（提高失败率，不透传）；speaker_id 槽位的下单/管理（控制台职责，UI 仅外链指引）。

## Capabilities

### New Capabilities

（无——克隆能力域 `voice-clone` 与云服务商能力域 `tts-cloud-providers` 均已存在，本变更为两者的交集扩展。）

### Modified Capabilities

- `voice-clone`：新增「火山复刻云端训练引擎」Requirement（双凭据/训练与状态 API/轮询语义/降噪与音源分离开关/speaker_id 槽位指引）；「克隆音色创建向导」Requirement 增引擎分叉 Scenario（火山跳过文本步、槽位输入）。
- `tts-cloud-providers`：「火山引擎豆包语音合成服务商」Requirement 增补克隆凭据字段与 `S_` 音色资源路由语义。

## Impact

- **类型**：`types/ttsProvider.ts`（volcengine fields 增 appId/accessToken、capabilities.clone）；`types/voiceClone.ts` 已含 `speakerId/providerId/trainStatus/trainError` 字段（Change A 预留），零改动。
- **main 侧新增**：`main/service/tts/volcengineVoiceCloneUtils.ts`（URL/headers/body/状态解析/错误分类纯函数）+ `volcengineVoiceClone.ts`（train/queryStatus HTTP）。
- **main 侧修改**：`volcengineTtsUtils.ts`（`volcResourceIdForVoice` 路由纯函数）、`volcengine.ts`（合成调用路由）、`ipcVoiceCloneHandlers.ts`（create 火山分支 + `voiceClone:volcRefreshStatus`）。
- **renderer 侧**：`CloneVoiceWizard.tsx`（引擎选择卡 + 火山 Step4 字段 + 跳过 Step3）、`ClonedVoicePanel.tsx`（训练状态/刷新）、`useDubbing.ts`（火山克隆音色注入 provider voices）。
- **i18n**：`voiceClone.json` 增引擎选择/槽位指引/训练状态文案；`resources.json` 增 appId/accessToken 字段 tips；`check:i18n` 守卫。
- **测试**：`test:voice-clone` 增 volcengineVoiceCloneUtils 固定向量用例（headers/body/状态判定/资源路由/错误分类）。
- **待实测风险**：训练接口请求体的 `audio`/`audios` 字段名文档与示例不一致（以示例 `audios` 实现，真机校准）；双凭据是否可用新版单 Key 替代（文档未明示，实现按文档双凭据，真机验证）；ICL 训练时长的轮询窗口（默认 3s × 30 次）。
