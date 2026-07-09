# Design: add-voice-clone

> 上游规划见 `Design/tts-dubbing-exploration.md`（D5 / Phase 2）与 `.cursor/plans/声音克隆_v2.0_规划_096c1bd5.plan.md`。本文收敛为实施所需的技术决策。

## Context

- 基座（Phase 0 PoC 已真机验证）：vendor sherpa-onnx-node 1.13.2 已含 `OfflineTtsZipvoiceModelConfig` 与 `GenerationConfig.referenceAudio/referenceSampleRate/referenceText/numSteps`，`generateAsync` 检测到 `generationConfig` 自动切 `offlineTtsGenerateAsyncWithConfig`；native `.node` 不用动。zipvoice-distill int8 zh-en 模型（encoder 5.5MB + decoder 125MB + espeak-ng-data/lexicon/tokens）+ vocos vocoder（54MB，**独立 release 路径 `vocoder-models/`**）。
- 实测数据（darwin-arm64, numSteps=4）：加载 1204ms；RTF zh 0.31–0.34 / en 0.45 / 短文本 1.56；numSteps=8 RTF 0.56（质量收益待听感对比，默认 4）；**speed 参数严重非线性**（1.15→实际 0.72x，1.5→0.29x），不可用于对齐预控制。
- 质检原材料：内置 silero VAD（`detectSpeech`，随包 `extraResources/sherpa/vad/`）、能量法（`analyzePcm16WavEnergy`/`energySpeechSegments`）、`readWavInfo` WAV 头解析、ffmpeg 提取/裁剪；SNR/削波/响度检测需新写（已随本变更落地为纯函数）。
- ASR 转写入口：本地 sherpa ASR 常驻 worker（`transcribe`）+ 云端 8 家（`ASR_TRANSCRIBER_MAP`，统一 `{audioPath}→{segments}`）。
- 既有 UI 范式：`buildTtsViews` 数据驱动左栏、`TtsModelPanel`/`TtsProviderPanel` 右栏、Dialog/AlertDialog、`media://` + `new Audio` 试听、`@tanstack/react-virtual`。

## Goals / Non-Goals

**Goals:**

- 小白可完成的克隆创建路径：全自动默认（自动选段/质检/裁剪/增益/转写），专家可微调（手动拖选区、改文本、调 numSteps 不暴露——保持零参数）。
- 质量保障分级明确可测：硬错误阻止 / 黄牌放行 / info 自动处理，全部纯函数单测。
- 克隆音色与内置音色在工作台同等公民：行级覆盖/试听/重生成零改动。
- 双引擎架构就位：`ClonedVoice.engine` 判别联合，创建向导与质检管线按 `CLONE_TARGET_RANGES[engine]` 参数化——火山复刻接入时只加引擎绑定层。

**Non-Goals:**

- 火山复刻 2.0（→ `add-volcengine-voice-clone`：训练 API/双凭据/S\_ 音色路由）；ElevenLabs IVC（→ 更后续）。
- 麦克风录音、说话人分离、音乐/多人声自动检测（不可靠，指引文案 + 试听自查兜底）、本地降噪（伤相似度）。
- 克隆音色用于「纯文本转有声」等非配音场景（工作台外无入口）。

## Decisions

### 1. 音色实体：`ClonedVoice` 独立存储，voiceId 前缀 `clone:` 预留但 zipvoice 侧直用裸 id

`clonedVoices` 独立 store 键（不塞进 `ttsProviders`——音色是用户资产不是服务商配置）。工作台 voice 值：zipvoice 引擎的音色列表**就是**我的音色清单（该引擎无内置音色），voiceId 直接用 `cv_<uuid>`；`types/voiceClone.ts` 提供 `CLONE_VOICE_PREFIX`（`clone:`）工具函数，供后续变更把克隆音色挂到云端 provider 下拉（火山场景 `S_` 音色与内置音色同池需前缀区分）时使用，本变更不消费。
_备选_：统一 `clone:` 前缀贯穿两轨——zipvoice 侧多一层无谓解包，弃。

### 2. 质检管线：纯函数决策层 + 编排层两文件分治

`referenceAudio.ts`（零 IO，55 项单测）承载全部阈值与决策：帧分析/切片、SNR 估算（语音帧均能量 − 噪声帧均能量，无噪声帧取 40dB 上限）、报告分级、滑窗选段（得分 = 语音占比 × 充足度 − 长静音惩罚，超长单段段内截断）、静音压缩区间规划（>800ms → 300ms，首尾收敛 150ms）、自动增益（<-30dB 抬至 -20dB，峰值 -1dB 保护 + 20dB 封顶）。`cloneAudioPipeline.ts` 只做 IO：ffmpeg 提取 16k 分析副本、VAD（silero 失败回落能量法）、分析会话内存驻留（`Map<id, session>`，帧数据不过 IPC）、定稿 filter_complex 一次成型。
**定稿从原始源媒体裁剪**（非 16k 分析副本）：保留源音质喂给克隆引擎，输出统一 24kHz mono 16-bit（zipvoice 模型采样率；参考音频经 `readWave` 原样喂入，24k 免引擎内重采样损失）。

### 3. 时长目标按引擎参数化：`CLONE_TARGET_RANGES`

zipvoice `{min 3s, ideal 5–10s, max 15s}`（官方明示过长参考拖慢推理且劣化质量）；volcengine `{min 5s, ideal 10–25s, max 30s}`（官方最佳实践 10–30s，>30s 服务端截断）。硬下限 3s 为两引擎公共线（`CLONE_MIN_SPEECH_MS`）。向导第②步的自动选段与质检评分卡都吃这组参数——火山接入时零改动。

### 4. 参考文本：三级获取 + 强制人工确认

zipvoice 对 refText 精确度敏感（官方：不匹配则明显劣化），故文本步不可跳过，获取三级：

1. **字幕预填**（差异化优势）：来源是「最近任务」的 workItem（视频+字幕）时，按选区时间窗取交叠字幕行拼接预填；
2. **ASR 自动转写**：本地 sense-voice（已装则优先，免费）→ 用户已配置的云 ASR（次选）→ 都没有走 3；
3. **手动输入**：边听选区录音边打字（选区试听按钮就在旁边）。
   无论来源，UI 均要求用户核对（文案「请逐字核对，与录音完全一致效果最好」）。转写走既有 `transcribe` 合同，segments 拼接为纯文本。

### 5. zipvoice 对齐能力位：`speedControl: 'none'`

PoC 实测 speed 非线性且波动大（见 Context），预控制第 1 层对它失效。引擎适配器声明 `'none'` → 对齐引擎自动走「原速合成 + atempo 后处理」既有分支（第 2 层复测），行为正确且零新逻辑。用户「整体语速」仍经 generationConfig.speed 透传（听感调节用途，不参与对齐决策）。canResynthesize = true（本地免费）但 speedControl 'none' 下复测直接 atempo（重合成不改 speed 无意义）。

### 6. 模型下载：spec 增 `extraFiles`（vocoder 独立工件）

`TtsModelSpec` 增可选 `extraFiles: Array<{name, releasePath, bytes}>`——zipvoice 条目声明 vocos vocoder（`vocoder-models/vocos_24khz.onnx`）。下载器在整包解包后逐个下载 extraFiles 到模型目录（复用 `downloadFileParallel` 与源回退），进度并入同一 `tts:<id>` key（整包 85% + extra 15% 权重）；`requiredFiles` 含 `vocos_24khz.onnx`，手动导入校验同口径。
_备选_：让用户手动放 vocoder，弃（小白路径必须一键）。

### 7. 向导形态：全屏 Dialog 四步，分析会话 main 驻留

向导为受控 Dialog（非独立页）：入口在「配音服务」页与工作台 voice 下拉空态，创建完成回到入口上下文。四步线性可回退；第②步波形 = `envelope`（100ms 归一化能量条）+ 语音段高亮 + 选区拖柄（自绘 div，不引波形库）；选区变化 300ms 防抖调 `voiceClone:inspectRange`（纯内存，快）。分析会话（帧级数据 ~每小时 540KB×3 数组）驻留 main 的 `Map`，向导关闭/换文件时 `disposeAnalysis` 释放并删分析副本 wav。
试听样本文本固定双语一句（与 `previewVoice` 同款），创建时同步合成（zipvoice RTF<0.5，几秒内完成）；A/B 对比 = 两个 `new Audio` 互斥播放（参考 ref.wav vs sample.wav）。

### 8. 授权合规：勾选前置，不做声纹校验

第④步「我已获得该声音所有者的授权，仅用于合法用途」必勾（业界惯例，ElevenLabs 同款）；不做任何技术校验（不可行）。勾选状态不持久化——每次创建都要勾（有意的摩擦）。

## Risks / Trade-offs

- [zipvoice RTF ~0.4，200 行批量合成约 8–15 分钟] → 行级进度既有；引导语提示克隆引擎较慢；numSteps 固定 4（8 的质量收益未证实）。
- [int8 蒸馏模型克隆相似度有天花板] → 试听 A/B 前置预期管理；追求产品级效果的用户由后续火山复刻承接（UI 预留引擎选择位）。
- [VAD 对音乐/混响误判语音段] → 能量法与 silero 双重来源仍可能误判；选段建议只是默认值，波形 + 选区试听让用户耳朵兜底。
- [ASR 转写含错别字直接影响克隆质量] → 强制核对文案 + 字幕预填优先（人工校对过的文本）。
- [分析会话内存驻留，异常退出残留分析副本 wav] → 落 temp 目录（既有启动清理策略覆盖）。
- [双工件下载引入的进度权重是近似值] → 视觉近似即可，完成判定以 requiredFiles 为准。

## Migration Plan

纯新增（新 store 键/新 IPC 命名空间/新组件），无数据迁移。回滚 = 移除「我的音色」组与向导入口；`clonedVoices` 键残留无副作用。zipvoice 模型条目随 catalog 版本发布，旧版本应用不识别该 id（`TtsModelId` 联合类型编译期隔离）。

## Open Questions

- zipvoice 中英混说文本的表现（模型双语但混说未实测）——实现期真机听感确认，必要时向导语言选择限定单语提示。
- 「从最近任务导入」的字幕行选段交互粒度：v1 先落「按选区时间窗自动取交叠行文本」，不做「点字幕行反选选区」（后续按反馈加）。
