## Why

当前 6 个转写引擎（`builtin` / `fasterWhisper` / `funasr` / `qwen` / `fireRedAsr` / `localCli`）**全部为本地引擎**，受本机算力、显存与模型下载体积限制：弱机 / 无独显用户跑大模型很慢，且想要顶尖多语种准确率的人没有「零安装、即开即用」的选项。业界主流在线 ASR（OpenAI 兼容 Whisper、Deepgram、AssemblyAI、阿里 DashScope 等）通过 API/SDK 即可获得高质量转写，而本项目**已具备接入所需的半套基础设施**——`openai` / `@alicloud/*` / `@volcengine/openapi` 依赖，以及成熟的「翻译服务商（凭证字段 + 配置页 + 已配置/未配置分组 + 批量/限速/重试）」范式。

已用一次性 spike（`scripts/spike/asr-openai-compat.mjs`，走 DeerAPI 的 OpenAI 兼容端点）验证可行性：`whisper-1` 对中英文样本均产出**准确文本 + 词级时间戳**（10s 英文 ~2s、16s 中文 ~2.7s 返回）；中文虽只返回 1 个大段，但 59 个**字级** `words` 喂进现有成句管线后自动切成 4 条自然字幕——证明「云端出文字 + 本地补时间轴」可直接复用内置引擎的分词成句代码。

## What Changes

- **新增「云端听写服务商」这一与本地引擎并列的转写来源**，采用与翻译服务商**同构的多实例凭证模型**：用户可配置多个实例、有独立配置页、按「已配置 / 未配置」分组呈现。
- **首个服务商类型：OpenAI 兼容转写**（`base_url` + `api_key` + `model`，覆盖 OpenAI / Groq / SiliconFlow / DeerAPI 等）。架构上为后续类型（Deepgram / AssemblyAI / 阿里 DashScope Qwen3-ASR 等）预留 `ASR_TRANSCRIBER_MAP[type]` 分发位。
- **新增一个云 ASR 引擎适配器**接入现有 `routeTranscription`：抽音频 →（超服务商大小/时长上限时用 ffmpeg 压缩、必要时按静音切片并加块偏移）→ 调转写 API（优先 `verbose_json` + `timestamp_granularities:['word']`）→ 把 `words` 归一为内部 `NativeToken` → **复用现有** `tokensToTriples → groupTokenCues → mergeShortCues → enforceMinDisplayDuration → trimSubtitleTrailingSilence` 成句（因音频在本地，能量裁剪仍可用）→ 写 SRT。
- **无词级时间戳的模型优雅降级**：如 `gpt-4o-transcribe`（转写端点拒绝 `verbose_json`）回退到「按静音切片 + 段级文本」的粗粒度时间轴，并在 UI 标注。
- **并发与稳健性**：云引擎从并发钳制（`isRestrictiveEngine`）中**排除**，允许高并发；每次请求设**显式超时 + 有限重试**（避免 SDK 默认 10 分钟挂起，spike 已复现），并支持每服务商限速。
- **UI 融合**：云服务商的「已配置实例 ▸ 模型」并入现有「引擎 ▸ 模型」下拉；就绪判定 = **凭证已配置**（而非本地已装模型）。
- **隐私与成本护栏**：音频离开本机前给出**明确一次性提示**（本项目卖点之一是纯本地）；按音频时长给出**预估用量提示**。
- **非破坏性**：本地引擎行为零改动；未配置任何云服务商时应用行为完全不变。

## Capabilities

### New Capabilities

- `cloud-asr-transcription`: 云端在线语音转写作为一等转写来源。定义「云端听写服务商」的多实例凭证模型（首个类型为 OpenAI 兼容）、通过引擎适配器接入逐任务转写流程、把各服务商结果归一为内部时间轴并复用现有成句/裁剪管线、云引擎的高并发与超时/重试/限速策略、逐任务「引擎 ▸ 模型」选择与就绪判定、以及隐私/成本护栏。

### Modified Capabilities

<!-- openspec/specs/ 目前无既有 spec（前序变更尚未归档），本变更为纯新增能力、不更改既有 spec 级要求，故此处为空。 -->

## Impact

- **新增类型与注册**：`types/engine.ts`（新增云引擎 id）、`types/asrProvider.ts`（**新**：ASR 服务商类型 `AsrProviderType` 与字段定义，仿 `types/provider.ts`）、`main/helpers/engines/registry.ts`（注册云适配器）。
- **新增引擎适配器**：`main/helpers/engines/cloudAsrEngine.ts`（**新**，结构 ≈ `builtinEngine.ts`），消费下述服务商实现。
- **新增服务商实现层**：`main/service/asr/*`（**新**：各类型 `transcribe` 实现 + `ASR_TRANSCRIBER_MAP`，仿 `main/translate/services/translationProvider.ts` 的分发）。首版仅 `openaiCompatible`。
- **复用成句/时间轴**：`main/helpers/subtitleSegmentation.ts`（`NativeToken` 管线）、`main/helpers/subtitleTiming.ts`（`subtitleCueFromSegment` / `trimSubtitleTrailingSilence`）、`main/helpers/fileUtils.ts`（`formatSrtContent`）——**不改，仅调用**。
- **音频准备**：`main/helpers/audioProcessor.ts` 新增「云用音频准备」（压缩 / 按静音切片，复用 `energySpeechSegments`）；**本地路径不动**。
- **存储**：`main/helpers/store/types.ts` + `store/index.ts` 新增 `asrProviders`（多实例凭证）与「上次使用」记忆；凭证形态见 `design.md` D2。
- **并发**：`main/helpers/taskProcessor.ts` 的 `isRestrictiveEngine` **不含**云引擎（云可高并发）。
- **UI**：`renderer/lib/engineModels.ts`（`getEngineModelGroups` 纳入已配置云服务商，建议顺手数据驱动化）、`renderer/components/Models.tsx`、新「云端听写」配置页（仿翻译服务商页 `renderer/components/resources/ProvidersTab.tsx` 与 `renderer/pages/[locale]/translation`）、`renderer/components/tasks/InlineConfigBar.tsx`、`renderer/components/resources/engines/EngineIcon.tsx`（云引擎图标）。
- **i18n**：`renderer/public/locales/{zh,en}/*.json` 新增服务商 / 引擎徽标 / 隐私提示 / 成本提示等文案（`check:i18n` 通过）。
- **依赖**：复用现有 `openai`；后续 Deepgram/AssemblyAI 类型可用现有 `axios` 直连，无需新增依赖。
- **清理**：验证脚本 `scripts/spike/asr-openai-compat.mjs` 为一次性产物，实现落地后删除。
