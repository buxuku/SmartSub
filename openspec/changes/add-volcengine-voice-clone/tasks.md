# Tasks: add-volcengine-voice-clone

## 1. 类型与凭据

- [x] 1.1 `types/ttsProvider.ts`：volcengine 类型 fields 增可选 `appId`（text）与 `accessToken`（password），tips 说明「声音复刻训练凭据（旧版控制台 APP ID + Access Token），需先在控制台购买音色槽位」；`capabilities.clone: true`；不改 `isTtsProviderConfigured` 语义（可选字段不参与就绪判定）
- [x] 1.2 `renderer/public/locales/{zh,en}/resources.json`：`ttsVolcAppId(Tips)` / `ttsVolcAccessToken(Tips)` 字段与 tips（含控制台槽位购买指引）；`check:i18n` 通过

## 2. 训练/状态 API 与合成路由

- [x] 2.1 新增 `main/service/tts/volcengineVoiceCloneUtils.ts` 纯工具：`VOLC_CLONE_TRAIN_URL`/`VOLC_CLONE_STATUS_URL`/`VOLC_CLONE_MAX_AUDIO_BYTES` 常量、`buildVolcCloneHeaders`（X-Api-App-Key / X-Api-Access-Key / X-Api-Request-Id / Content-Type）、`buildVolcCloneTrainBody`（`audios:{data,format}` 按官方示例；`model_types:[4]`；extra_params 降噪/mss 开关按需携带）、`parseVolcCloneStatus`（2/4 → ready、3/0 → failed、其余 → training）、`volcCloneErrorHint`（凭据/槽位不存在/次数上限/质量拒绝四类定向）、`isVolcCloneSpeaker`/`volcResourceIdForVoice`
- [x] 2.2 新增 `main/service/tts/volcengineVoiceClone.ts`：`trainVolcCloneVoice`（≤10MB 前置校验 → base64 → fetch，AbortSignal.timeout 120s → BaseResp/code/header 三源错误提取 + 分类）与 `queryVolcCloneStatus`
- [x] 2.3 `volcengineTtsUtils.ts`：新增 `volcResourceIdForVoice(voice, configured)` 纯函数；`volcengine.ts` 合成调用改经该路由（S\_ → seed-icl-2.0，普通音色零影响）；45000000 错误文案增补克隆场景成因
- [x] 2.4 `scripts/voice-clone/test-voice-clone-units.ts` 增固定向量用例：clone headers/body（含开关省略语义）、状态解析（2/4/1/3/0/缺省六态）、资源路由（S\_/普通/配置缺省 + 两份实现同语义）、错误分类四类；`test:voice-clone` 86 项全过

## 3. IPC 与创建流程

- [x] 3.1 `ipcVoiceCloneHandlers.ts`：create 火山分支——`requireVolcCloneProvider` 前置校验（合成 Key + appId/accessToken 齐备，失败零落盘）+ speaker_id 格式校验 → prepare 产物 → train → `pollVolcTraining`（3s × 30）→ ready 合成试听样本（previewVoice 云通道 + S\_ 音色）/ 超窗以 training 入库 / 失败入库 failed+trainError；新增 `voiceClone:volcRefreshStatus`（手动刷新，ready 顺手补样本）与 `voiceClone:volcRetrain`（复用参考音频重训同槽位）
- [ ] 3.2 真机验证（持续回填，2026-07-09 用户真实槽位实测）：
  - **音频字段名定稿 `audio`**——按官方示例的 `audios` 实测报 `HTTP 400 "add unmapped key audios to params store"`（参数表口径正确、示例有误），已改回并加单测；同时修正错误分类（裸 `audio` 关键词会把参数错误误判为质检拒绝，改 wer/snr/quality/denoise 精确匹配）
  - **双凭据鉴权走通、训练上传成功**（豆包后台显示训练完成）
  - **V3 状态查询端点定稿 `POST /api/v3/tts/get_voice`**（用户凭据直测）：文档主篇写的 `/api/v3/tts/voice_clone/status` 实测 **404 "Endpoint does not exist"**（训练成功后应用一直显示「训练中」的根因——status 轮询全程打在不存在的端点上，且错误被静默）。`get_voice` 实测 200：顶层 `status: 2` + `speaker_status[]`（该音色同时挂 model_type 1/5 两档）+ `demo_audio` + `available_training_times`。修复三层：①端点改 `get_voice`；②状态解析多形态兼容（顶层/`data.`/`speaker_status[]`、字符串态、`found` 信号，13 项单测）+ V1 `mega_tts/status` 回退通道保留；③刷新/重训失败 toast 可见 + 原始响应进日志
  - **克隆音色合成链路真机走通**：`S_VwLuAGE72` + `X-Api-Resource-Id: seed-icl-2.0` 经 `/api/v3/tts/unidirectional` 返回 code 0 PCM 音频（资源路由 2.3 的实测确认）

## 4. UI 分叉

- [x] 4.1 `CloneVoiceWizard.tsx`：Step1 顶部引擎选择双卡（ZipVoice 免费/离线 vs 火山复刻需槽位；无就绪豆包实例时禁用并指引）；质检档位随引擎（`CLONE_TARGET_RANGES[engine]` 参数化零改动，切引擎时选区按新档位收口）；火山分支 stepper 三步（跳过参考文本步，back 路由适配）
- [x] 4.2 Step4 火山字段：语言选择 + speaker_id 输入（S\_ 前缀校验 + 控制台指引）+ 降噪/音源分离 Switch（默认关；质检含 low-snr 黄牌时旁注「检测到噪音偏大，建议开启」）；创建后训练中/失败态展示（trainingSlowNotice / trainFailedDesc）
- [x] 4.3 `ClonedVoicePanel.tsx`：火山训练状态 Badge（训练中/可用/失败）、训练中「刷新状态」、失败展示 trainError +「重新上传训练」（复用原参考音频）；左栏条目状态点按 trainStatus
- [x] 4.4 `useDubbing.ts`：豆包实例 voices 尾部注入绑定该实例且 ready 的克隆音色（id = speakerId / label = 音色名）；`voiceClone.json` 增引擎选择/槽位/训练状态文案（zh/en），`check:i18n` 通过

## 5. 验收

- [ ] 5.1 真机端到端（需付费槽位）：火山分支创建（黄牌素材开降噪）→ 训练就绪 → 工作台选克隆音色批量合成 → 导出；训练中关闭向导 → 面板刷新到就绪 → 样本补齐
- [x] 5.2 回归：`test:voice-clone` 86 项 / `test:dubbing` 137 项 / `check:i18n` 全过；渲染层项目内 `tsc -p renderer` 新文件零错误；普通豆包音色合成路由不受影响（route 单测覆盖 S\_ 判定不误伤）
