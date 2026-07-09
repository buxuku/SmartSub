# Design: add-volcengine-voice-clone

## Context

- Change A（`add-voice-clone`）已就位：`ClonedVoice` 实体（`speakerId/providerId/trainStatus/trainError` 字段已预留）、四步创建向导、质检管线（`CLONE_TARGET_RANGES.volcengine = {min 5s, ideal 10–25s, max 30s}` 已定义）、`voiceClone:` IPC。
- 豆包 TTS provider 已接入（`add-volcengine-tts-provider`）：V3 单向流式合成（单 `X-Api-Key`）、错误分类、音色标签体系。
- 火山声音复刻 2.0（官方文档 2026-07 口径）：训练 `POST /api/v3/tts/voice_clone`（`X-Api-App-Key` + `X-Api-Access-Key` 双凭据）；参考音频 wav/mp3 等 ≤10MB，最佳 10–30s、低噪单人单轨，>30s 服务端截断；`model_types:[4]` = ICL 2.0；状态查询 `/voice_clone/status`，`status` 2/4 可合成；合成走既有 V3 端点 + `X-Api-Resource-Id: seed-icl-2.0` + `speaker = S_xxx`。speaker_id 槽位需控制台购买。

## Goals / Non-Goals

**Goals:**

- 复用 Change A 的全部创建体验（选材/选段/质检），火山分支只增「引擎选择 + 槽位/开关 + 训练轮询」三处。
- 训练不阻塞：轮询窗口内未就绪的音色以 `training` 状态入库，后台可继续、面板可刷新。
- 合成零感知：`S_` 音色自动路由 `seed-icl-2.0`，工作台/试听/批量与内置音色无差别。

**Non-Goals:** ElevenLabs IVC；DiT 复刻档（model_type 2/3）；WER 文本校验透传；槽位购买管理。

## Decisions

### 1. 凭据：双凭据可选字段，不参与就绪判定

`volcengine` 类型增 `appId`/`accessToken` 可选字段（仅克隆训练用）。不改 `isTtsProviderConfigured` 语义——合成就绪与克隆就绪解耦；向导火山分支单独校验「provider 已配置合成 Key + appId/accessToken 齐备」，缺失时给出面板跳转指引。
_备选_：复用单 X-Api-Key 调训练接口——文档明示训练接口走 App Key + Access Token，按文档实现（真机若验证单 Key 可用再简化）。

### 2. 训练调用形态：一次上传 + 有限轮询 + 状态入库

`voiceClone:create`（engine='volcengine'）主流程：prepare 产物 ref.wav（24k mono，与 zipvoice 同管线）→ base64（≤10MB 前置校验）→ train → 轮询 status（3s × 30 次 ≈ 90s）→ ready 则合成试听样本（previewVoice 走豆包云通道 + S\_ 音色）→ 入库 `trainStatus: 'ready'`；轮询超窗仍 `training` 也入库返回（UI 提示可稍后刷新），训练失败入库 `failed` + `trainError`。`voiceClone:volcRefreshStatus` 供面板/向导手动刷新（成功顺手补试听样本）。
参考音频/质检快照照常存本地（音色资产的构成部分；火山侧删除槽位不影响本地记录，重传可复用）。

### 3. 合成路由：纯函数按音色前缀切资源

`volcResourceIdForVoice(voice, configured)`：`voice.startsWith('S_')` → `'seed-icl-2.0'`，否则原样返回 configured。挂在 `synthesizeWithVolcengine` 的 header 构造处，testConnection/preview/批量全链路自动生效。错误码 45000000（越权/不存在）在克隆场景的文案增补「确认音色训练完成且属于当前账号」。

### 4. 向导分叉：引擎选择卡置于 Step1 顶部，火山跳过 Step3

两张单选卡（本地 ZipVoice：免费/离线/即时；火山复刻 2.0：效果更好/需购买槽位 + docsUrl 外链）。选火山后：`CLONE_TARGET_RANGES.volcengine` 驱动选段与质检（Change A 已参数化，零改动）；Step2 next 直接进 Step4（训练接口不需要参考文本；stepper 显示三步）；Step4 增 speaker*id 输入（必填，`S*` 前缀校验 + 控制台指引文案）、降噪/音源分离开关（默认关；质检报告含 low-snr 黄牌时开关旁给「建议开启」提示——服务端降噪损相似度的 trade-off 一并说明）。

### 5. 工作台注入点：火山克隆音色进 provider voices（id = speakerId）

`useDubbing.refreshEngines` 云端分支：豆包实例的 voices 列表尾部追加该实例绑定（`providerId` 匹配）且 `trainStatus='ready'` 的克隆音色（`{id: speakerId, label: name}`）。合成时 voice 即 S\_ id，走决策 3 路由——`cue.voiceId`/行级覆盖/试听零改动。zipvoice 侧维持 Change A 形态（克隆音色挂本地引擎）。

## Risks / Trade-offs

- [请求体 `audio`/`audios` 文档不一致] → 按官方示例 `audios` 实现，utils 纯函数集中易改，真机校准（tasks 3.x）。
- [双凭据体系与新版控制台演进] → 字段可选 + 定向错误文案；若实测单 Key 可用，删字段为纯简化。
- [ICL 训练时长波动] → 有限轮询 + training 状态入库 + 手动刷新，不做无限等待。
- [服务端降噪损相似度] → 默认关 + 黄牌联动建议，把 trade-off 交给用户明示选择。

## Migration Plan

纯增量：新字段可选、新 IPC 通道、向导新分支默认仍 zipvoice。回滚 = 隐藏引擎选择卡；已建火山音色记录残留无副作用（合成时报可行动错误）。

## Open Questions

- 训练接口是否还需要 `X-Api-Resource-Id`（如 `volc.megatts.voiceclone`）——V3 文档 header 表未列，按无实现，401/403 时真机补验。
- 轮询窗口 90s 是否覆盖 ICL 2.0 P95 训练时长——实现期真机标定。
