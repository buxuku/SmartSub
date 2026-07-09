# Proposal: link-cloud-cloned-voices

> 依据：用户反馈「用豆包和 ElevenLabs 生成音色之后，如果删除掉，如何重新直接从平台上面获取下来」。

## Why

云端克隆音色（火山 S\_ 槽位 / EL voice_id）是**账号资产**：本地删除记录不等于（也不应等于）资产消失。当前两处断裂：

1. **取不回**：本地记录删了（或换机、未用 .svoice 导出）后，没有任何入口把平台上仍存在的克隆音色重新接回来，只能重新训练/上传（火山还消耗训练次数）。
2. **EL 删除语义过重**：现行删除固定 best-effort 同步删云端，用户只是想清理本地列表时会误伤云端资产，且事先无感知。

## What Changes

- **「从平台取回」入口**（「我的音色」组第三个虚线入口，与创建/导入并列）→ `LinkCloudVoiceDialog`：
  - **ElevenLabs**：调 `GET /v1/voices` 过滤 `category === 'cloned'` 列出账号内 IVC 音色（已在本地的标记「已存在」置灰），点选即接回（名称随云端，语言可选）；
  - **火山**：无公开列表接口——输入 S\_ 槽位 ID，用现有状态接口校验（ready/training 均可接回，携训练次数），命名 + 语言后入库。
- **接回入库**：生成新 `ClonedVoice`（`trainStatus` 按云端实况；无本地参考音频/质检快照——面板已兼容缺省字段），随后 best-effort 合成试听样本。
- **EL 删除语义修正**：删除对话框对 EL 音色增加「同时删除云端音色（释放槽位）」勾选，**默认关**——默认仅删本地记录，云端资产可随时取回；勾选才调 DELETE 同步。
- IPC：`voiceClone:listCloudVoices`（EL）/ `voiceClone:linkCloudVoice`（双引擎）/ `voiceClone:remove` 增 `removeCloud` 参数。

**不做**：火山账号级音色列表爬取（无公开 API）；EL PVC 音色接回（IVC 同类目才可直接合成）。

## Capabilities

### Modified Capabilities

- `voice-clone`：新增「云端克隆音色接回」Requirement；「音色管理面板」删除语义修订（EL 云端删除改为显式勾选）。

## Impact

- **main**：`elevenlabsVoiceClone(Utils).ts`（listClonedVoices + category 过滤纯函数）；`ipcVoiceCloneHandlers.ts`（listCloudVoices / linkCloudVoice / remove.removeCloud）。
- **renderer**：`LinkCloudVoiceDialog`（新组件）、`TtsServicesTab` 入口、`ClonedVoicePanel` 删除勾选、`useClonedVoices` 两个新动作；i18n。
- **测试**：category 过滤/映射纯函数单测。
