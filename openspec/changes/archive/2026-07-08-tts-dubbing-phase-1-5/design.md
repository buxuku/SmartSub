# Design: tts-dubbing-phase-1-5

> 上游依据：`openspec/changes/archive/2026-07-07-add-tts-dubbing/design.md`（决策 2 引擎抽象、决策 4 重叠 cue「顺延是默认、多轨是升级」、Non-Goals 中 Azure/ElevenLabs → v1.5）。本文只收敛 v1.5 四项的新增决策，v1 已定决策不重复。

## Context

- **引擎抽象已就位**：`TtsSegmentRequest`（text/voice/speed/outWavPath/signal → 16-bit PCM wav 落盘）+ `TtsCapabilities.speedControl: 'native'|'ssml'|'none'`；分发表 `TTS_SYNTHESIZER_MAP`（`main/service/tts/index.ts`）加一条映射即扩一家。`speedControl='ssml'` 在 `types/ttsProvider.ts` 与对齐引擎 `decideSpeedAction`（`canPreControl = native || ssml`）中已预留，**至今无实现者**——引擎适配器把 speed 直接传给 synthesize 函数，SSML 折算完全是 provider 内部事务，对齐层零改动。
- **品牌型 service 范式现成**：ASR 侧 `elevenlabs.ts + elevenlabsUtils.ts` 等「实现 + 纯工具分文件」形制，纯工具零 electron/fs 依赖可进单测；`testTtsConnection` 通用（真实合成一句），新类型自动生效；「配音服务」页左栏条目由 `buildTtsViews` 数据驱动，新增品牌型类型零 UI 代码自动外显。
- **重叠 cue 现状**：`computeSlots` 已产出 `overlapNext` 标记（重叠时本条槽位回落自身时长、不挤压）；`buildAlignmentPlan` cursor 走查把重叠后条顺延（`targetStart = max(start, cursor)`）。`assembleTrack` 是 PCM 采样级单轨拼接，规划保证段间不重叠。`duckMixIntoVideo` 已用过 `amix`（原轨×配音轨），但配音轨内部多轨互混尚无封装。
- **字符量现状**：工作台对合成量零展示；云端合成按字符计费（OpenAI 兼容/Azure/ElevenLabs 均字符口径），用户无法预估配额消耗。cue 文本在会话加载时已归一（换行折空格、trim），renderer 侧 `cues[]` 持有全部文本。
- **调研输入（2026-07）**：Azure F0 50 万字符/月免费、REST 可直出 riff wav、prosody rate 限 0.5–2.0 倍、计费含 SSML 标记字符；ElevenLabs REST `voice_settings.speed` 文档推荐 0.7–1.2（超界有 422 风险）、`output_format=pcm_24000` 直出裸 PCM、免费 1 万字符/月、国内需代理。

## Goals / Non-Goals

**Goals:**

- Azure Speech 与 ElevenLabs 两个品牌型 TTS provider 接入，形制对齐既有 ASR 品牌型 service（纯工具分文件 + 单测）；Azure 打通 `speedControl='ssml'` 分支。
- 工作台合成前可见「将合成的行数与字符量」，云端引擎附计费口径提示。
- 重叠 cue 提供「多轨混合」升级选项：重叠行锚定原始时间轴分轨拼接，`amix` 合为单条配音轨；默认行为（顺延）不变。
- 云端引擎就绪判定收敛到 `isTtsProviderConfigured`（品牌型必填凭据缺失不得进工作台下拉）。

**Non-Goals:**

- 火山豆包语音 / 阿里 CosyVoice / MiniMax / Fish Audio（调研第一二梯队其余项 → 后续变更；硅基流动 CosyVoice2 已有 OpenAI 兼容预设覆盖）。
- ElevenLabs 声音克隆管理（voice 管理仍是 voice_id 清单粘贴；克隆属 v2 能力域）。
- 精确计费金额估算/配额余量查询（各商口径与汇率各异，只做字符量事实 + 口径提示，不做金额换算）。
- 说话人自动分轨（多轨仅按时间轴重叠分配，不做 voiceId 分轨语义）。
- amix 之外的混音增强（响度归一 EBU R128 等）。

## Decisions

### 1. Azure：REST + subscription key 直连，SSML 构造为纯函数

- **端点**：`https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`，region 必填字段拼接；可选 `endpoint` 字段整体覆盖（世纪互联 `*.tts.speech.azure.cn` 等主权云）。鉴权用 `Ocp-Apim-Subscription-Key` 头直传 key。_备选_：token 交换（issueToken 换 10 分钟 Bearer）——多一次往返、多一层缓存失效逻辑，REST 直传 key 官方支持且逐段合成本就短连接，弃。
- **音频**：`X-Microsoft-OutputFormat: riff-24khz-16bit-mono-pcm` 直出规范 wav，与管线合同（16-bit PCM 单声道）一致——落盘后 `readWavInfo` 校验，不合规才回落 ffmpeg 转码（形制 openaiCompatible 的 tryReadWav 双保险）。
- **SSML**：`buildAzureSsml(text, voice, rate)` 纯函数（azureUtils）——`<speak xml:lang>` 从 voice 名前缀推导（`zh-CN-XiaoxiaoNeural` → `zh-CN`），文本 XML 转义（`& < > " '`），speed→`<prosody rate="+15%">` 折算 clamp 到 Azure 文档区间 [0.5, 2.0]；speed≈1 时省略 prosody 元素（少计费字符）。固定向量单测。
- **能力声明**：`speedControl: 'ssml'`、`maxCharsPerRequest: 3000`（保守值；Azure 真实上限是 10 分钟音频，单条字幕远不触顶）、`concurrency: 2`（F0 并发配额低，字段可调）。
- **计费提示**：字段 tips 注明「按字符计费且含 SSML 标记字符；F0 每月 50 万字符免费」。

### 2. ElevenLabs：裸 PCM 直出 + 本地包 WAV 头，speed 走保守区间

- **请求**：`POST {base}/text-to-speech/{voiceId}?output_format=pcm_24000`，头 `xi-api-key`；body `{ text, model_id, voice_settings: { speed } }`。base 非必填回落 `https://api.elevenlabs.io/v1`（复用 ASR elevenlabsUtils 的 normalize 语义，独立实现于 TTS 侧纯工具）。
- **音频**：`pcm_24000` 为 24kHz 16-bit 单声道小端裸 PCM——**本地拼 44 字节 WAV 头直接落盘，零 ffmpeg 转码**。audioPipeline 导出 `writePcmAsWav(pcm, sampleRate, outPath)`（内部复用既有 `buildWavHeader`）。_备选_：请求 mp3 再 ffmpeg 转码（Edge 路径）——多一次进程开销且无收益，弃。
- **speed**：`voice_settings.speed` clamp 到 **[0.7, 1.2]**（文档推荐区间，超界部分模型 422）。对齐引擎请求 1.2–1.5 的部分由既有云端复测分支自动以 atempo 补足——`speedControl='native'` 语义不变，clamp 是 provider 内部折算。_备选_：按 REST 名义区间 0.25–4.0 放开——模型兼容性无保证，风险不值得，弃。
- **字段**：apiKey（必填）、model（默认 `eleven_multilingual_v2`）、voices = voice_id 清单（预填官方 premade 音色 id，全账号通用，tips 指引到 dashboard 复制自有/克隆音色 id）、apiUrl（选填）、requestTimeoutSec、concurrency（默认 2）。`maxCharsPerRequest: 5000`（v3 模型下限口径，保守通用）。
- **错误引导**：网络类失败（fetch failed/timeout）错误信息附「国内网络需代理直连 api.elevenlabs.io」提示；401 指向 xi-api-key；配置面板 tips 注明「免费 1 万字符/月，中文按字节膨胀计费（约 3 字符/字）」。

### 3. 字符量预估：renderer 纯计算，挂在合成发起入口旁

- **口径**：正文字符数 = cue.text 逐字符计数（跳过纯空白行——processor 对空行不发起合成）；两种范围随状态自动切换——「开始/继续配音」= 非 done/accepted 行合计，「全部重跑」= 全部行合计。展示「N 行 · M 字符」。
- **位置**：`DubbingFileBar` 开始按钮旁（合成决策点）；云端引擎选中时叠加 tooltip/辅助文案提示计费口径（按字符计费；Azure 含 SSML 标记略高于展示值；ElevenLabs 中文按字节膨胀；试听与单行重生成额外消耗）。本地引擎只展示行数/字符数不带计费提示。
- **实现**：useDubbing 内 `useMemo` 从 `cues` 汇总，零 IPC 零 main 侧改动。_备选_：main 侧算好随 session 返回——字符量随行编辑/重跑状态实时变化，renderer 本就持有全量文本，往返无意义，弃。

### 4. 多轨混合：轨内 cursor 走查、轨间独立，导出期逐轨拼接后 amix

- **配置**：`DubbingConfig.overlapMode?: 'shift' | 'mix'`，默认 `'shift'`（= 今天的顺延行为，默认不变）；UI 仅当会话存在重叠行时显示该选项（无重叠时无意义，避免噪音）。
- **轨道分配**（alignment 纯函数）：mix 模式下 `buildAlignmentPlan` 按 start 排序做贪心区间划分——每行放入「已放段末端 ≤ 本行 start」的最小编号轨道，放不下则开新轨；`AlignmentPlanItem` 新增 `lane: number`（shift 模式恒 0，字段向后兼容）。**cursor 走查改为每轨独立**：轨内仍按既有语义顺延/截断消解残余冲突（含 shift 溢出），轨间互不挤压——重叠行因此锚定原始 start 不再被错开。
- **导出**（dubbingProcessor + audioPipeline）：plan items 按 lane 分组 → 每轨 `assembleTrack` 补齐到统一 totalDurationMs → 新封装 `amixWavs(inputs[], outPath)`（`amix=inputs=N:duration=longest:normalize=0` + `alimiter` 防削波，输出 16-bit PCM wav，走既有 runSave 取消模式）→ 汇成单条配音轨后进既有背景音/输出形态路径。**单轨时跳过 amix**（mix 模式但无重叠行 = 与今天字节级同路径）。_备选_：一次 ffmpeg 以 adelay 逐段偏移混流——放弃 PCM 采样级精确拼接、filter 图随行数线性膨胀（千条字幕不可行），弃。
- **顺延字幕导出交互**：mix 模式下重叠行不产生顺延，`shiftedTimeline` 自然输出原时间轴（逐轨 cursor 的 targetStart）；无需特判。

### 5. 就绪判定收敛：`isTtsProviderConfigured` 取代「voices 非空」

`useDubbing.refreshEngines` 现判 `voices.length > 0` 即 ready——对 v1 两类型碰巧成立（voices 是唯一强语义必填），对 Azure/ElevenLabs（key/region 必填）会把半配置实例放进下拉、运行时才报错。收敛为 renderer 直接 import `isTtsProviderConfigured`（types 纯函数，双端可用）判定。风险极低的行为收紧：既有用户中「voices 有值但必填缺失」的实例本就不可用。

## Risks / Trade-offs

- [ElevenLabs 国内不可直连，测试连接/合成将超时] → 错误信息显式引导「配置系统代理或切换其它服务商」；不做内置代理配置（应用无此先例，系统代理已覆盖）。
- [amix 多轨人声叠加可能削波] → `alimiter` 限幅兜底；轨道数实际 ≤3（重叠通常两两），风险面小。
- [Azure prosody rate 与实际时长非线性（同 kokoro 实测教训）] → 既有第 2 层复测防线兜底（云端 atempo），SSML 分支不假设线性。
- [ElevenLabs speed clamp [0.7,1.2] 使 1.2–1.5 区间全走 atempo，音质损失概率高于其它引擎] → 可接受：atempo ≤1.25 人耳基本无感；宁可稳定不 422。
- [字符量展示口径 ≠ 账单口径（SSML 附加/字节膨胀）] → 展示值定位「正文字符量参考」，计费差异以文案显式声明，不承诺对账。
- [mix 模式下轨内残余冲突仍会顺延，用户可能误以为多轨=完全零顺延] → 同轨顺延仅发生在「同一时刻三行以上互叠且前行超长」的极端场景；行级 overlap/顺延标记照常暴露。

## Migration Plan

纯新增 + 默认行为不变：`overlapMode` 缺省 `'shift'` 与今天逐字节同路径；`lane` 字段新增缺省 0；两个新 provider 类型未配置时对既有用户零感知。回滚 = 移除类型注册与 UI 选项，无数据迁移。

## Open Questions

- **ElevenLabs 预填 premade voice_id 集合**：实现期以官方文档当期 premade 清单为准挑 3–4 个（多语模型通用款），固化进 preset 默认值。
- **Azure 默认 region**：倾向 `eastasia`（国内延迟最优），实现期确认 F0 层该 region 可开。
