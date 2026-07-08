# Proposal: tts-dubbing-phase-1-5

> 依据：`openspec/changes/archive/2026-07-07-add-tts-dubbing/design.md` 的 Non-Goals 与 Open Questions 中显式推迟到 v1.5 的三项——Azure Speech / ElevenLabs 云服务商、amix 多轨混合；叠加 2026-07 云端 TTS 接入调研结论（Azure 免费额度最厚、SSML rate 正好走预留的 `speedControl='ssml'` 分支；ElevenLabs 音质天花板但中文性价比低、按需后置接入）。

## Why

配音 v1 MVP（工作台 + 本地 kokoro/vits + OpenAI 兼容 + Edge TTS）已落地，但云端选择面窄且免费档只有不承诺可用性的 Edge：Azure F0 每月 50 万字符免费、140+ 语种 400+ 音色、国内可直连，是普通用户的最佳白嫖档；ElevenLabs 是英文内容创作者的音质/克隆天花板。两者都是品牌型 service（各半天量级），「配音服务」页与分发表本次重构已铺好，接入成本最低窗口就是现在。

同时补齐两个 v1 遗留的体验缺口：云端合成按字符计费但工作台全程不展示字符量（用户无法预估配额消耗，Azure/ElevenLabs 免费额度都是字符口径，接入后该缺口被放大）；重叠 cue 目前只有「检测 + 告警 + 按 start 顺延」，双语字幕/多说话人叠字幕场景配音会被强行错开，archive design 决策 4 预设的升级路径（拆多轨分别合成再 amix）在 v1.5 兑现。

## What Changes

- **新增 Azure Speech 配音服务商**（品牌型硬单例）：region + subscription key 凭据（可选 endpoint 覆盖，支持世纪互联等主权云）；REST `cognitiveservices/v1` 直出 `riff-24khz-16bit-mono-pcm` wav；`speedControl='ssml'`——对齐引擎预留的 SSML 分支首次接通（speed → `<prosody rate>`，SSML 构造与 XML 转义为纯函数可单测）；配置面板提示「计费含 SSML 标记字符、F0 每月 50 万字符免费」。
- **新增 ElevenLabs 配音服务商**（品牌型硬单例）：xi-api-key 凭据 + model_id（默认 `eleven_multilingual_v2`）+ voice_id 清单；`output_format=pcm_24000` 裸 PCM 本地包 WAV 头（零 ffmpeg 转码，包头为纯函数可单测）；`voice_settings.speed` 原生语速（`speedControl='native'`）；配置面板提示「免费 1 万字符/月、中文按约 3 字符/字计费、国内需网络代理」。
- **新增合成字符量预估展示**：工作台在发起批量合成前展示「下次运行将合成的行数与字符量」（全量与剩余行两种口径随状态自动切换）；云端引擎附计费口径提示（按字符计费 / Azure 含 SSML 附加 / 单行重生成额外消耗）。
- **新增重叠 cue 多轨 amix 混合**：对齐规划新增轨道分配（重叠行锚定原 start 分配到空闲轨道，贪心不新增则开新轨），导出期逐轨 PCM 拼接后 `amix` 混为单条配音轨（含防削波限幅）；工作台新增重叠处理模式选项「顺延（默认）/ 多轨混合」——v1「顺延是默认、多轨是升级」的语义按原设计兑现，默认行为不变。
- **顺带收敛**：工作台引擎下拉的云端就绪判定从「voices 非空」收敛为 `isTtsProviderConfigured`（新增带必填凭据的品牌型后，半配置实例不得进下拉）。

## Capabilities

### New Capabilities

（无——四项全部落在既有配音能力域内。）

### Modified Capabilities

- `tts-cloud-providers`：新增 Azure Speech 与 ElevenLabs 两个品牌型服务商类型需求（凭据/端点/音频格式/语速控制/计费提示/错误分类）。
- `dubbing-alignment`：重叠 cue 消解从单一「按 start 顺延」扩展为「顺延（默认）/ 多轨混合」双策略；槽位规划输出（`AlignmentPlan`）增加轨道编号。
- `dubbing-pipeline`：新增多轨混合导出需求（逐轨拼接 + amix 合轨 + 防削波），既有单轨路径不变。
- `dubbing-workbench`：新增合成字符量预估展示需求与重叠处理模式选项需求；引擎下拉就绪判定收敛。

## Impact

- **类型**：`types/ttsProvider.ts`（新增 `TTS_AZURE_SPEECH` / `TTS_ELEVENLABS` 类型定义与能力声明）；`types/dubbing.ts`（`DubbingConfig.overlapMode`、`AlignmentPlanItem.lane`）。
- **main 侧新增**：`main/service/tts/azure.ts` + `azureUtils.ts`、`main/service/tts/elevenlabs.ts` + `elevenlabsUtils.ts`（形制 ASR 品牌型 service：纯工具分文件、可单测）。
- **main 侧修改**：`main/service/tts/index.ts`（分发表加两条映射）；`main/helpers/dubbing/alignment.ts`（`buildAlignmentPlan` 增加 mix 模式轨道分配）；`main/helpers/dubbing/audioPipeline.ts`（新增 `amixWavs` 多输入混流）；`main/helpers/dubbing/dubbingProcessor.ts`（导出期按轨分组拼接）。
- **renderer 侧修改**：`renderer/hooks/useDubbing.ts`（字符量汇总、overlapMode 配置、就绪判定收敛）；`DubbingConfigPanel` / `DubbingFileBar`（字符量展示、重叠模式选项）；「配音服务」页零代码自动外显新服务商（`buildTtsViews` 数据驱动）。
- **i18n**：`resources.json`（两家服务商字段 tips）、`dubbing.json`（字符量/重叠模式文案），zh/en 齐备。
- **测试**：`test:dubbing` 扩展（SSML 构造/转义、PCM 包 WAV 头、mix 模式轨道分配与回归）；无新增依赖（两家均为原生 fetch REST）。
- **风险**：ElevenLabs 国内不可直连（错误信息引导配代理/切换）；amix 叠加人声可能削波（限幅兜底）；Azure F0 并发配额低（默认并发 2，可配置调低）。
