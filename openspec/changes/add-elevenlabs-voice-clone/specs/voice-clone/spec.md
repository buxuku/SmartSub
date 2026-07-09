## ADDED Requirements

### Requirement: ElevenLabs 即时克隆引擎

系统 SHALL 支持以 ElevenLabs 即时克隆（IVC）创建云端克隆音色：创建走 `POST /v1/voices/add`（`xi-api-key` 鉴权，multipart 携音色名、质检管线定稿的参考音频与可选 `remove_background_noise`），响应即返 `voice_id`——**即时可用，MUST NOT 引入训练轮询**；音色以 `voice_id` 挂到对应 ElevenLabs provider 实例的音色池，合成走既有 ElevenLabs 通道。创建向导的 ElevenLabs 分支 MUST 跳过参考文本步（IVC 不需要转写）；素材时长档位按 IVC 推荐（30–120s，上限 180s）。本地删除 EL 克隆音色时 SHALL best-effort 同步删除云端 voice（IVC 槽位有限）；云端删除失败 MUST NOT 阻塞本地删除。凭据无效、槽位上限（voice_limit_reached）、素材被拒 MUST 报定向可读错误。

#### Scenario: 即时创建即时可用

- **WHEN** 用户以就绪的 ElevenLabs 实例走完向导（选段 → 命名保存）
- **THEN** 无训练等待，音色立即标记可用并生成试听样本，工作台该实例音色下拉即时出现

#### Scenario: 槽位上限可诊断

- **WHEN** 账号 IVC 槽位已满（服务端 voice_limit_reached）
- **THEN** 报错指向「删除不用的克隆音色或升级套餐」，而非笼统失败

#### Scenario: 删除同步云端

- **WHEN** 用户删除一个 ElevenLabs 克隆音色
- **THEN** 本地记录与文件即时移除，云端 voice 删除请求异步发出（失败仅记日志）
