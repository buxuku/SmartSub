## MODIFIED Requirements

### Requirement: ElevenLabs 服务商

系统 SHALL 提供品牌型云 TTS 服务商类型 `elevenlabs`（硬单例）：凭据为必填的单 API Key（`xi-api-key` 头）；音色清单支持在线拉取（`voiceListMode`）与预置名称映射；合成走官方 TTS 端点、输出经统一转码归口为 16-bit PCM 单声道 wav。能力声明 SHALL 含 `clone: true`：即时克隆（IVC）产出的 `voice_id` MUST 可直接作为合成 voice 使用（与内置音色同池、无需资源切换）。

#### Scenario: 类型出现在配音服务页

- **WHEN** 用户打开「配音服务」页的「在线服务」组
- **THEN** ElevenLabs 为可配置条目，表单由 schema 字段驱动渲染

#### Scenario: 克隆音色直接合成

- **WHEN** 工作台以 IVC 克隆音色的 voice_id 发起合成
- **THEN** 走既有 ElevenLabs 合成通道成功产出音频，无需任何额外资源头或路由
