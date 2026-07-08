## Why

「云端听写」现已支持三家**异构**服务商——OpenAI 兼容（`whisper-1` / `gpt-4o-transcribe`）、ElevenLabs Scribe（`xi-api-key` + multipart）、Deepgram（`Token` + 二进制体），架构按 `provider.type` 经 `ASR_TRANSCRIBER_MAP` 分发。但**呈现层仍停留在「只有 OpenAI 兼容」的早期**：引擎卡副标题写「OpenAI 兼容的在线转写」、标签是 `[在线][免 GPU][多实例]`（无任何品牌）、`desc` 与 `cloudAsr.intro` 只提 OpenAI——用户打开「云端听写」**看不出它支持 ElevenLabs / Deepgram**。

对比同为「一个入口、多子成员」的 `sherpa`：它用副标题 `FunASR · Qwen · FireRed` + 标签 `[FunASR][Qwen3-ASR][FireRedASR]` 亮明子品牌，面板内还按族分区——`cloud` 没抄这个已验证成熟的范式。随着后续接入更多异构服务商（阿里 / 千问 / 豆包等），当前「扁平实例列表 + OpenAI 口径文案」只会更糊：发现性差、混类型实例难以归类。

关键前提：**这是纯呈现 / 信息架构问题，不涉及集成机制。** 后端引擎 id 恒为 `'cloud'`、`ASR_TRANSCRIBER_MAP` 按 `type` 分发、任务页「引擎 ▸ 模型」下拉（已按已配置实例分组）**均无需改动**——「合并」只发生在资源页左栏那**一个** cloud 入口。

## What Changes

- **B — 亮明服务商类型（信息架构，主要为 i18n）**：把「云端听写」类别文案改为**平级并列各服务商类型**，而非「OpenAI 兼容」当伞盖：
  - 副标题：`OpenAI 兼容 · ElevenLabs · Deepgram`（随新增类型增补）
  - 标签：`[OpenAI 兼容][ElevenLabs][Deepgram]`（品牌化，对齐 sherpa）
  - `desc` / `cloudAsr.intro`：点名各家、去掉「仅 OpenAI」的措辞
- **C — 面板内按服务商类型分区（对齐 `SherpaEngineGroupPanel`）**：`CloudAsrPanel` 从「单一扁平实例列表」改为**按 `AsrProviderType` 分区**：每区标题为类型名 + 图标、其下为该类型的实例列表、区内一个「添加实例」入口；无实例的类型区给「添加即用」提示（或折叠），使「支持哪些家」自解释。侧栏仍是**一个**「云端听写」入口。
- **D7 — 协议型多实例 / 品牌型硬单例**：给 `AsrProviderType` 加 `multiInstance` 标记。协议型（OpenAI 兼容，`multiInstance:true`）可多实例、保留「添加实例」；品牌型（ElevenLabs / Deepgram，留空）为硬单例——未配置显「配置」、配置后不再显示「添加」（封顶 1）。修正 C 在固定品牌上产生的「无意义多实例入口」。纯呈现，后端分发零改动。
- **确立并文档化「两级分类 + 三步扩展 recipe」**：类别（`engine:'cloud'`）→ 类型（`AsrProviderType`，各自 `fields` + 一个 `transcribe`）→ 实例（`AsrProvider`，用户凭据）。新增一家 = ① `ASR_PROVIDER_TYPES` 加一条（按真实形态设 `multiInstance`）；② `main/service/asr/<x>.ts` 实现 `transcribe`；③ `ASR_TRANSCRIBER_MAP` 注册（可选：`testConnection` 探测分支 + i18n 字段文案）。
- **非破坏**：`ASR_TRANSCRIBER_MAP`、云引擎适配器、任务页下拉、`store.asrProviders` 数据结构与已保存实例**零改动**；仅动资源页左栏的 cloud 文案与 `CloudAsrPanel` 布局。
- **明确不做（弃 D）**：**不**把各服务商拆成 `ENGINE_VIEWS` 的独立左栏项——理由见 `design.md`（侧栏随服务商膨胀、空服务商永久占位、与「云 = 同一套配置范式」相悖，且任务页已按实例分组，D 的区分度 B/C 已给到）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cloud-asr-transcription`: 新增「云端听写类别的服务商类型呈现」与「配置面板按服务商类型分区」两类要求，并把「两级分类（类别 ▸ 类型 ▸ 实例）+ 三步扩展 recipe」固化为服务商扩展规范。不改变既有转写 / 时间轴 / 并发 / 超时重试 / 隐私护栏等要求。

## Impact

- **i18n（主要）**：`renderer/public/locales/{zh,en}/resources.json` 的 `engines.cloud.{subtitle,tags,desc}` 与 `cloudAsr.{intro,newInstanceName}` 等改为多服务商口径；`npm run check:i18n` 通过。
- **UI 布局**：`renderer/components/resources/engines/panels/CloudAsrPanel.tsx` 由扁平列表改为按 `AsrProviderType` 分区渲染（枚举 `ASR_PROVIDER_TYPES`、区内「添加实例」）。建议抽出纯函数 `groupInstancesByType(providers)` 便于 `test:engines` 单测。
- **不改**：`types/asrProvider.ts`（类型 / 字段）、`main/service/asr/*`、`main/service/asr/index.ts`（`ASR_TRANSCRIBER_MAP`）、`renderer/lib/engineModels.ts`、`renderer/components/Models.tsx`、`main/helpers/store`（`asrProviders` 结构）。
- **文档**：README（zh/en）「云端听写」小节措辞对齐「多服务商 + 面板分区」；如涉及截图，后续人工更新。
