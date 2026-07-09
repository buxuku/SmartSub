## ADDED Requirements

### Requirement: 云端克隆音色接回

系统 SHALL 提供「从平台取回」入口（「我的音色」组），把平台上已存在的云端克隆音色重新接入本地列表：ElevenLabs SHALL 拉取账号音色清单并仅展示 `category === 'cloned'` 的即时克隆音色（本地已存在的条目 MUST 标记且不可重复接回）；火山 SHALL 支持输入 S\_ 槽位 ID 并用状态接口校验存在性（ready/training 均可接回，训练次数随状态回填）。接回生成的新音色记录 MUST 标注云端实况状态、绑定对应 provider 实例，并 best-effort 合成试听样本；无本地参考音频与质检快照时管理面板 MUST 正常展示。

#### Scenario: 误删后取回 EL 音色

- **WHEN** 用户本地删除过某 EL 克隆音色（未勾选删云端），点击「从平台取回」并选择该音色
- **THEN** 音色重新出现在「我的音色」并可直接配音，无需重新上传素材

#### Scenario: 换机接回火山槽位

- **WHEN** 用户在新设备输入已训练的 S\_ 槽位 ID
- **THEN** 状态校验通过后音色入库（状态与训练次数按云端实况），可直接在工作台使用

#### Scenario: 无效槽位可诊断

- **WHEN** 用户输入不存在或无权访问的 S\_ 槽位 ID
- **THEN** 展示状态接口的定向错误（凭据/槽位不存在），不产生本地记录

## MODIFIED Requirements

### Requirement: ElevenLabs 即时克隆引擎

系统 SHALL 支持 ElevenLabs 即时克隆（IVC）作为第三条克隆引擎轨道：创建走 `POST /v1/voices/add`（multipart：name/files/可选 remove_background_noise），上传成功即返回 `voice_id` 并 MUST 立即置为可用（无训练轮询）；合成复用现有 ElevenLabs provider 通道（voice_id 直接作为合成音色）；创建前 MUST 校验已配置的 ElevenLabs 实例（合成 Key 即克隆 Key）。**本地删除 EL 音色时 SHALL 默认仅删除本地记录（云端资产保留、可随时取回）；删除对话框 SHALL 提供「同时删除云端音色（释放槽位）」显式勾选（默认关），勾选时才 best-effort 调用 `DELETE /v1/voices/{id}`，失败不阻断本地删除。**错误 MUST 定向分类：401/403 凭据或套餐、voice_limit 槽位上限、素材质量拒绝。

#### Scenario: 上传即用

- **WHEN** 用户以 60 秒清晰素材走向导创建 EL 克隆音色
- **THEN** 创建完成即为可用状态并合成试听样本，音色出现在工作台 ElevenLabs 实例的音色池

#### Scenario: 默认删除保留云端

- **WHEN** 用户删除某 EL 克隆音色且未勾选「同时删除云端音色」
- **THEN** 仅本地记录与文件被删除，ElevenLabs 账号中的音色保留，可经「从平台取回」重新接入

#### Scenario: 勾选后同步删云端

- **WHEN** 用户删除时勾选「同时删除云端音色（释放槽位）」
- **THEN** 系统调用云端删除；即使云端删除失败，本地删除仍完成且失败仅记日志
