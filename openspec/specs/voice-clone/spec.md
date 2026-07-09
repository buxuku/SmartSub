# voice-clone Specification

## Purpose

TBD - created by archiving change add-voice-clone. Update Purpose after archive.

## Requirements

### Requirement: 克隆音色实体与存储

系统 SHALL 提供用户克隆音色实体 `ClonedVoice`（id `cv_<uuid>` / 名称 / 引擎判别 `zipvoice | volcengine` / 语言 / 参考音频路径与参考文本（本地引擎）/ 质检快照 / 试听样本 / 来源与创建时间），持久化于独立 store 键 `clonedVoices`；参考音频与试听样本 SHALL 落 `userData/voiceClones/<音色id>/`，删除音色 MUST 同步清理该目录。音色 SHALL 支持重命名与删除；删除后工作台引用该音色的合成 MUST 报可行动错误（提示重新选择音色），不得静默回落其它音色。

#### Scenario: 创建后持久可用

- **WHEN** 用户完成创建向导并保存音色
- **THEN** `clonedVoices` 新增记录、`userData/voiceClones/<id>/` 存在 ref.wav（与试听样本），应用重启后音色仍在列表与工作台下拉中

#### Scenario: 删除清理

- **WHEN** 用户在管理面板确认删除某音色
- **THEN** store 记录与音色目录同时移除，工作台引擎下拉即时不再出现该音色

### Requirement: 参考音频质检管线

系统 SHALL 提供参考音频质检管线，分三阶段：**analyze**（源媒体 → 16kHz 单声道分析副本 → VAD 语音段（silero 优先、能量法兜底）→ 20ms 帧分析 → 能量包络与自动选段建议）；**inspect**（任意选区实时产出 `VoiceQualityReport`：时长/有效语音/语音占比/最长静音/语音电平/峰值/削波占比/SNR 估算/verdict/问题清单）；**prepare**（从**原始源媒体**按选区定稿：首尾静音收敛、内部超长静音压缩、低音量自动增益（峰值保护）、统一 24kHz 单声道 16-bit wav）。质检决策逻辑 MUST 为纯函数并有固定向量单测；分级门槛 MUST 为：无语音或有效语音 < 3s 为 error（阻止创建），SNR 低 / 削波超限 / 语音占比低 / 低于引擎推荐时长为 warning（放行并提示），低音量与长静音为 info（自动处理并告知）。时长目标 MUST 按引擎参数化（zipvoice 推荐 5–10s、上限 15s；火山复刻推荐 10–25s、上限 30s）。

#### Scenario: 长视频自动选段

- **WHEN** 用户提交一个 30 分钟视频作为克隆素材
- **THEN** 系统自动分析并给出一个落在引擎推荐时长内、语音连贯（占比高、无长静音）的推荐选区，用户无需手工找片段

#### Scenario: 有效语音过短阻止

- **WHEN** 选区内有效语音不足 3 秒
- **THEN** 质检报告 verdict 为 poor 且含 error 级问题，向导禁止进入下一步并提示需要更长的清晰语音

#### Scenario: 嘈杂素材黄牌放行

- **WHEN** 选区 SNR 估算低于阈值（声音不清晰/背景噪音大）
- **THEN** 评分卡以警告样式提示噪音问题与「更换安静素材」建议，但允许用户继续创建

#### Scenario: 长静音与低音量自动处理

- **WHEN** 选区含 2 秒内部静音且整体音量过低
- **THEN** 定稿产物中该静音被压缩至约 300ms、音量被增益至目标电平（峰值不削波），评分卡以 info 说明已自动处理

#### Scenario: 定稿保留源音质

- **WHEN** 源媒体为 48kHz 视频而分析副本为 16kHz
- **THEN** 定稿参考音频从源媒体直接裁剪转出（24kHz 单声道 16-bit），不经 16kHz 分析副本二次转码

### Requirement: 克隆音色创建向导

系统 SHALL 提供四步创建向导（Dialog 形态，步间可回退）：①选素材（文件对话框 + 拖放 + 从最近任务导入；素材要求指引常驻展示；**顶部引擎选择：本地 ZipVoice（免费/离线）或火山复刻 2.0（需控制台购买槽位，附文档外链），选段与质检档位随引擎切换**）；②选段与质检（能量波形 + 语音段与推荐选区高亮 + 选区拖动微调 + 选区试听 + 实时质检评分卡）；③参考文本（**仅本地引擎**：来源含字幕时按选区预填字幕文本，否则 ASR 自动转写，无可用 ASR 时手动输入；MUST 提示用户逐字核对；**火山引擎跳过本步**——训练接口不需要转写文本）；④命名与保存（授权确认勾选 MUST 必选且不持久化；**火山分支增 speaker_id 槽位输入与服务端降噪/音源分离开关**；创建后自动合成试听样本并提供原声/克隆 A/B 对比；不满意可一键返回②换段）。

#### Scenario: 小白默认路径

- **WHEN** 用户拖入一个音频文件并全程接受默认（推荐选区、自动转写文本）
- **THEN** 仅需「确认选区 → 核对文本 → 命名勾选保存」三次确认即完成创建，全程无需理解任何音频参数

#### Scenario: 从最近任务免转写创建

- **WHEN** 用户从「最近任务」选择一个带字幕与视频的任务作为素材
- **THEN** 第③步参考文本按选区时间窗自动预填对应字幕行文本，无需 ASR 转写

#### Scenario: A/B 对比与换段回路

- **WHEN** 创建完成后用户对克隆效果不满意
- **THEN** 可在同一向导内 A/B 对比原声与克隆样本，并一键返回第②步更换选区后重新创建

#### Scenario: 授权确认

- **WHEN** 用户未勾选「已获得声音所有者授权」
- **THEN** 保存按钮不可用；勾选状态不跨次记忆，每次创建都需显式勾选

#### Scenario: 火山分支跳过文本步

- **WHEN** 用户在第①步选择火山复刻引擎
- **THEN** 质检档位切换为火山推荐时长（10–25s），第②步通过后直接进入命名保存步（含 speaker_id 输入），不出现参考文本步

### Requirement: 参考文本获取

参考文本获取 SHALL 按三级回退：字幕预填（素材来自带字幕的最近任务）→ ASR 自动转写（本地 ASR 已安装优先，其次用户已配置的云端 ASR 服务商）→ 手动输入；转写不可用 MUST 降级为手动输入并说明原因，不得阻断向导。任何来源的文本 MUST 允许用户编辑校对后再提交。

#### Scenario: 本地 ASR 优先

- **WHEN** 用户已安装本地 ASR 模型且配置了云 ASR 服务商
- **THEN** 选区转写走本地模型（免费、不出网），云服务商不被调用

#### Scenario: 无 ASR 降级

- **WHEN** 用户未安装本地 ASR 也未配置云 ASR
- **THEN** 第③步提示需手动输入参考文本，提供选区重听按钮辅助听写

### Requirement: 音色管理面板

「配音服务」页 SHALL 新增「我的音色」组（每音色一个左栏条目：名称、引擎标识、状态点），右栏管理面板 SHALL 提供：试听样本播放与重新生成、参考音频回放、质检报告卡（verdict、关键指标、问题清单）、重命名、删除（确认对话框）、来源文件与创建时间。组内 SHALL 有「创建克隆音色」入口；无音色时 SHALL 展示空态引导。

#### Scenario: 面板信息完备

- **WHEN** 用户选中某个克隆音色条目
- **THEN** 右栏可试听样本与参考音频、查看创建期质检报告、执行重命名/删除

### Requirement: voiceClone IPC 命名空间

声音克隆相关 IPC SHALL 使用 `voiceClone:` 命名空间，invoke 统一返回 `{success, data?, error?}`；分析会话的帧级数据 MUST 驻留 main 进程内存（跨 IPC 只传会话 id 与轻量视图），向导关闭或更换素材时 MUST 释放会话并清理分析副本临时文件。

#### Scenario: 统一返回结构

- **WHEN** 渲染进程调用任一 `voiceClone:` invoke 接口
- **THEN** 成功与失败均以 `{success, …}` 结构返回，异常不以未捕获 reject 泄漏

#### Scenario: 会话释放

- **WHEN** 用户关闭创建向导
- **THEN** 对应分析会话从内存移除，分析副本 wav 被删除

### Requirement: 火山复刻云端训练引擎

系统 SHALL 支持以火山「声音复刻 2.0」（ICL）创建云端克隆音色：训练走 `POST https://openspeech.bytedance.com/api/v3/tts/voice_clone`（`X-Api-App-Key` + `X-Api-Access-Token` 双凭据，来自豆包 TTS provider 实例的可选克隆凭据字段），请求携用户在控制台购买的 `S_` speaker_id 槽位、质检管线定稿的参考音频（base64，超 10MB MUST 前置拒绝）、语言与 `model_types: [4]`（ICL 2.0）；可选服务端处理开关 `enable_audio_denoise`（降噪）与 `voice_clone_enable_mss`（音源分离）MUST 默认关闭并在质检含噪音黄牌时提示可开启（同时说明降噪损失相似度的代价）。训练后 SHALL 有限轮询状态接口（`status` 2/4 判可用）：就绪则合成试听样本并入库 `ready`；轮询窗口内未就绪 MUST 以 `training` 状态入库并允许手动刷新，MUST NOT 无限阻塞创建流程；训练失败入库 `failed` 并保留可读失败原因。headers/body 构造与状态判定 MUST 为纯函数并有固定向量单测。

#### Scenario: 训练并轮询就绪

- **WHEN** 用户以有效凭据与 speaker_id 完成火山分支创建
- **THEN** 参考音频上传训练，轮询到 status=2/4 后音色标记可用并生成试听样本

#### Scenario: 轮询超窗不阻塞

- **WHEN** 轮询窗口结束时训练仍未完成
- **THEN** 音色以「训练中」状态入库、向导正常收尾，管理面板可手动刷新状态，就绪后自动补试听样本

#### Scenario: 凭据缺失可指引

- **WHEN** 用户选择火山引擎但 provider 实例未配置 appId/accessToken
- **THEN** 向导阻止进入训练并指引前往「配音服务」页补齐克隆凭据，不影响该实例的普通合成可用性

#### Scenario: 训练失败可诊断

- **WHEN** 训练被服务端拒绝（speaker_id 不存在/次数上限/音频质量不达标）
- **THEN** 音色标记失败并展示定向原因，支持更换素材或槽位后重新上传

### Requirement: 克隆音色合成资源路由

豆包 TTS 合成 SHALL 按音色自动路由资源版本：`S_` 开头（克隆音色）MUST 以 `X-Api-Resource-Id: seed-icl-2.0` 发起，其余音色沿用实例配置的 `resourceId`；路由为纯函数并有单测。工作台批量合成、行级重生成、试听与测试连接 MUST 全链路生效，克隆音色与内置音色在交互上无差别。

#### Scenario: 克隆音色自动切资源

- **WHEN** 工作台以 `S_` 克隆音色发起合成而实例 resourceId 为 seed-tts-2.0
- **THEN** 请求头携 seed-icl-2.0，返回音频为克隆音色；同会话内普通音色行仍按 seed-tts-2.0 发起
