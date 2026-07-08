## Why

「云端听写」的 OpenAI 兼容类型是**协议型多实例**（可对接 OpenAI / Groq / 硅基流动 / 各聚合站等一切 `/audio/transcriptions` 兼容端点），但目前新建实例时只给一张空表单——用户得自己知道并手填每家的 base URL 与模型名（如 Groq 是 `https://api.groq.com/openai/v1` + `whisper-large-v3-turbo`、硅基流动是 `https://api.siliconflow.cn/v1` + `FunAudioLLM/SenseVoiceSmall`）。发现性差、易填错。

这正是「零代码扩容」的最佳落点：这些家都走同一套 `openaiCompatible` 的 `transcribe` 实现，**无需新增服务商类型**，只要在「添加实例」时提供**命名预设**一键预填 base URL + 模型，即可让覆盖面暴涨、品牌可见。

## What Changes

- **新增 OpenAI 兼容类型的「命名预设」**：`OpenAI` / `Groq` / `SiliconFlow 硅基流动` 三个内置预设（base URL + 推荐模型），端点/模型名以各家官方 OpenAI 兼容转写文档为准（Groq、硅基流动已核实）。
- **面板「添加实例」升级为预设下拉**（仅**协议型且有预设**的类型）：下拉列出各预设 + 「自定义」；选预设→按预设值预填新建实例，选「自定义」→按类型默认新建（等价旧行为）。品牌型（单例）与无预设的协议型行为不变。
- **预设只覆盖字段值**（`apiUrl` / `models`），实例 `type` 恒为 `openaiCompatible`——**后端分发、凭据校验、任务页下拉、存储结构全部零改动**。用户仍需自行填入各家 API Key。
- **纯逻辑抽函数便于单测**：`getAsrPresetsForType(typeId)` 取清单、`buildInstanceFromPreset(type, preset?, idFactory?)` 构造实例（`test:engines` 覆盖）。
- **非破坏**：无预设/自定义路径与旧「添加实例」完全等价；已存实例不受影响。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cloud-asr-transcription`: 为「云端听写服务商类型呈现」新增「协议型命名预设」——协议型类型可声明常见 vendor 预设，配置面板在新建实例时提供预设一键预填。不改变既有转写 / 分发 / 时间轴 / 并发 / 隐私护栏等要求。

## Impact

- **类型/纯函数**：`types/asrProvider.ts` 新增 `AsrProviderPreset`、`ASR_PROVIDER_PRESETS`（键=类型 id）、`getAsrPresetsForType`、`buildInstanceFromPreset`。
- **面板**：`renderer/components/resources/engines/panels/CloudAsrPanel.tsx` 的协议型分区「添加实例」按钮在有预设时改为 `DropdownMenu`；`handleAdd(typeId, presetId?)` 经 `buildInstanceFromPreset` 统一构造。
- **i18n**：`renderer/public/locales/{zh,en}/resources.json` 新增 `cloudAsr.customPreset`；`cloudAsr.intro` 点名预设（`check:i18n` 通过）。
- **测试**：`scripts/test-engine-units.ts` 新增 `getAsrPresetsForType` / `buildInstanceFromPreset` / `multiInstance` 断言。
- **不改**：`main/service/asr/*`、`ASR_TRANSCRIBER_MAP`、云引擎适配器、`renderer/lib/engineModels.ts`、`main/helpers/store`（`asrProviders` 结构）。
