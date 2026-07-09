# Proposal: add-voice-clone

> 依据：`Design/tts-dubbing-exploration.md` D5 与 Phase 2 既定路线（「v2 = zipvoice 本地零样本克隆；本项目恰好有原字幕可自动生成参考对，是差异化优势」）；`TtsCapabilities.clone` 能力位与 `cue.voiceId` 数据结构在 v1 已预留。声音克隆整体规划为双轨（本地 zipvoice + 火山复刻 2.0），本变更落地**克隆基建 + 本地 zipvoice**，火山复刻在后续变更 `add-volcengine-voice-clone` 落地。

## Why

配音工作台目前只有「枚举内置音色」（本地 kokoro/vits 的 sid 查表、云端服务商的字符串音色池），用户无法用自己/特定说话人的声音配音——这是换声、自媒体口播、纪录片译配等核心场景的头号诉求，也是同类产品（ElevenLabs、剪映）的标配能力。基座已就绪：内置 sherpa-onnx v1.13.2 的 vendor JS 已含 zipvoice 模型配置与 `GenerationConfig.referenceAudio/referenceText` 克隆 API（**不动 native 构建链**，Phase 0 PoC 已真机验证：模型加载 1.2s、numSteps=4 时 RTF 0.31–0.45 @ darwin-arm64）；VAD（内置 silero）、能量分析、ffmpeg 提取/裁剪、本地/云端 ASR（参考文本自动转写）全部现成。缺的只是「用户创建的音色」这一实体及其创建/质检/管理链路。

克隆效果的成败几乎完全取决于参考音频质量（低噪、单人、时长适中、文本精确匹配），而目标用户是小白——**创建向导必须把质量保障做成自动化默认路径**：自动选段、自动质检分级、自动静音裁剪与增益、ASR 自动转写参考文本，用户只需「选文件 → 听一遍确认 → 保存」。

## What Changes

- **新增「我的音色」实体与存储**：`ClonedVoice`（id/name/engine/language/refWavPath/refText/quality/sampleWavPath…），store 键 `clonedVoices`（manager 形制 `ttsProviderManager`）；参考音频与试听样本落 `userData/voiceClones/<id>/`；删除音色时清理目录。
- **新增参考音频质检管线**（用户核心关注的质量保障）：
  - **analyze**（整文件）：源媒体（音频或视频）→ 16k mono 分析副本 → Silero VAD 语音段（能量法兜底）+ 20ms 帧分析 → 能量包络（波形渲染用）+ 自动选段建议；
  - **inspect**（选区实时质检）：`VoiceQualityReport{durationMs, speechMs, speechRatio, longestSilenceMs, rmsDb, peakDb, clippingRatio, snrDb, verdict, issues[]}`，分级门槛——**硬错误阻止**（无语音 / 有效语音 <3s）、**黄牌放行**（SNR<15dB 不清晰 / 削波>1% / 语音占比<60% / 低于引擎推荐时长）、**info 自动处理**（低音量自动增益 / 长静音自动压缩）；
  - **prepare**（定稿）：从**原始源媒体**（非 16k 分析副本，保留源音质）按选区一次 ffmpeg filter_complex 成型——首尾静音收敛、内部 >800ms 静音压缩至 ~300ms、低音量自动增益（峰值保护）、统一 24kHz mono 16-bit wav；
  - 决策逻辑全部为纯函数（`referenceAudio.ts`），新增 `test:voice-clone` 单测（55 项已过）；编排层（ffmpeg/VAD/fs）独立成 `cloneAudioPipeline.ts`。
- **新增四步创建向导**（Dialog，小白友好）：① 选素材（拖放/浏览/从最近任务）+ 素材要求指引卡；② 波形选段（自动推荐区间高亮 + 手动拖动微调 + 选区试听）+ 实时质检评分卡（绿/黄/红 + 问题清单 + 建议）；③ 参考文本（ASR 自动转写 + 边听边校对；来源含字幕时按选区预填字幕文本；无 ASR 可用时手动输入）；④ 命名 + 「已获得声音所有者授权」勾选 + 创建即合成试听样本 + 原声/克隆 A/B 对比，不满意一键回②换段。
- **本地 zipvoice 引擎接入**：
  - `ttsModelCatalog` 新增 `zipvoice-distill-zh-en` 条目（模型整包 ~109MB + vocoder 单文件 ~54MB **双工件下载**，下载器扩展 extraFiles；源 ghproxy→github 不变）；
  - `tts-config.js` 加 `modelType:'zipvoice'` 分支（encoder/decoder/vocoder/tokens/dataDir/lexicon），`tts-worker.js` synthesize 消息扩展 `generationConfig{refWavPath, refText, numSteps}`——worker 内 `readWave` 读参考音频并按路径缓存（不跨线程传大数组）【已随 PoC 落地】；
  - `dubbingProcessor.buildEngineAdapter` 支持 zipvoice：voiceId = 克隆音色 id（`cv_…`）→ 查 `clonedVoices` 注入参考对；**对齐层按 `speedControl:'none'` 对待**（PoC 实测 zipvoice speed 参数严重非线性：speed=1.15 实际缩到 0.72x、1.5 缩到 0.29x，预控制不可用；行级变速走既有 atempo 复测分支，整体语速仍经 `generationConfig.speed` 透传由用户按听感调）。
- **管理 UI**：「配音服务」页左栏新增第三组「我的音色」（每音色一条目：名称 + 引擎标 + 状态点）；右栏新增 `ClonedVoicePanel`（试听样本/参考音频回放、质检报告卡、重命名、删除确认、来源信息）；空态引导 + 「创建克隆音色」入口。
- **工作台集成**：zipvoice 引擎出现在引擎下拉（就绪 = 模型已装），其音色列表 = 我的音色（zipvoice 侧全部音色都是克隆音色）；无克隆音色时引导创建；行级 voice 覆盖、试听、单行重生成等既有交互零改动直接可用。
- **IPC**：新增 `voiceClone:` 命名空间（pickSource / analyze / inspectRange / transcribeRange / create / list / rename / remove / disposeAnalysis），统一 `{success, data?, error?}`；分析会话（帧数据）驻留 main 内存不过 IPC。

**不做**（Non-Goals，见 design）：火山复刻 2.0 与 ElevenLabs 即时克隆（→ `add-volcengine-voice-clone` 及后续）、麦克风录音输入、说话人分离/多人声自动检测、本地降噪（伤相似度，明示换素材）、克隆音色跨设备同步。

## Capabilities

### New Capabilities

- `voice-clone`：克隆音色实体与存储、创建向导（选材/选段/文本/试听保存）、参考音频质检管线（分析/选段建议/定稿处理与分级门槛）、参考文本获取（ASR 转写/字幕预填/手动）、音色管理面板、`voiceClone:` IPC。

### Modified Capabilities

- `tts-local-engine`：模型目录新增 zipvoice 条目（双工件下载）；新增「零样本克隆合成」Requirement（synthesize 消息 generationConfig 合同、参考音频 worker 缓存、numSteps 默认 4）。
- `dubbing-workbench`：「配音服务」页左栏新增「我的音色」组；工作台引擎/voice 下拉纳入克隆音色（zipvoice 引擎音色 = 我的音色，空态引导创建）。

## Impact

- **类型**：新增 `types/voiceClone.ts`（`ClonedVoice`/`VoiceQualityReport`/`CloneSegmentSuggestion`/`CLONE_TARGET_RANGES`/IPC 视图）。
- **main 侧新增**：`main/helpers/voiceClone/referenceAudio.ts`（质检纯函数【已落地】）、`cloneAudioPipeline.ts`（分析/定稿编排【已落地】）、`voiceCloneManager.ts`（store 读写 + 文件清理）、`referenceTranscriber.ts`（本地 sense-voice → 云 ASR → 手动兜底）、`ipcVoiceCloneHandlers.ts`。
- **main 侧修改**：`ttsModelCatalog.ts`（zipvoice 条目 + spec 增 extraFiles）、`ttsModelDownloader.ts`（extraFiles 下载）、`sherpaOnnx/ttsRuntime.ts`（synthesize 请求透传 generationConfig）、`dubbing/dubbingProcessor.ts`（zipvoice 引擎适配）、`systemInfoManager.ts`（zipvoice 模型状态携克隆音色数）、`background.ts`（注册 handlers）。
- **worker 侧**（extraResources，不经 webpack）：`tts-config.js` zipvoice 分支、`tts-worker.js` generationConfig 透传与参考音频缓存【已随 PoC 落地】。
- **renderer 侧**：新增 `components/voiceClone/CloneVoiceWizard.tsx`（四步向导）+ `components/tts/ClonedVoicePanel.tsx`；修改 `TtsServicesTab.tsx`（第三组）、`hooks/useDubbing.ts`（zipvoice 引擎音色注入）、`DubbingConfigPanel.tsx`（空态引导）。
- **i18n**：`renderer/public/locales/{zh,en}/voiceClone.json` 新 namespace（向导/质检文案量大，独立成篇），`check:i18n` 守卫。
- **测试**：`scripts/voice-clone/test-voice-clone-units.ts`（55 项【已落地】）+ `scripts/voice-clone/zipvoice-poc.mjs`（真机克隆合成/RTF【已落地】）；`npm run test:dubbing` 既有 137 项回归。
- **依赖**：零新增（ffmpeg-static/fluent-ffmpeg/sherpa vendor 均现成）。
- **已验证风险数据**（Phase 0 PoC @ darwin-arm64, numSteps=4）：模型加载 1204ms；RTF 中文 0.31–0.34、英文 0.45、短文本（一两个词）1.56（固定开销占比高）——比 kokoro 慢约一个量级，批量合成耗时明显增加，UI 行级进度已有；speed 非线性（见上）→ 对齐按 'none' 处理。
