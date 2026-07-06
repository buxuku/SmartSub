# 探索记录:TTS(字幕配音)功能与角色区分(说话人分离)

> 日期:2026-07-06 · 状态:探索结论 + 本地 MVP 冒烟验证通过,未立项
> 来源:explore mode 会话,基于代码事实核查(非假设)
> 冒烟脚本:`scripts/tts-smoke.mjs`(aishell3 基础合成)、`scripts/tts-kokoro-smoke.mjs`(Kokoro 24kHz/中英混合)、`scripts/tts-dub-smoke.mjs`(SRT→配音整轨闭环,`--engine=aishell3|kokoro`)

## 0. 关键发现:地基已经打好了

检查随包分发的 sherpa-onnx 原生库(`extraResources/sherpa/native/darwin-arm64/libsherpa-onnx-c-api.dylib`,版本 1.13.2)符号表,确认:

- `SherpaOnnxCreateOfflineTts` ✅ 已编译进原生库
- `SherpaOnnxCreateOfflineSpeakerDiarization` ✅ 已编译进原生库
- vendor JS 封装已就位:`extraResources/sherpa/vendor/non-streaming-tts.js`、`non-streaming-speaker-diarization.js`(sherpa-onnx-node 1.13.2 完整拷贝)

**结论:本地 TTS 和本地说话人分离都是零新增原生依赖**——只差模型下载、worker 调用和 UI。

vendored 类型声明(`vendor/types.js`)显示支持的 TTS 模型族:

| 模型族       | 说明                                             |
| ------------ | ------------------------------------------------ |
| VITS (piper) | 逐语种,60~120MB,音色多、速度快                   |
| Matcha-TTS   | 中文 baker/aishell3,英文 ljspeech                |
| Kokoro       | v1.1-zh ~300MB,中英混合,100+ 音色,中文场景主推   |
| Kitten       | 英文微型模型(~25M)                               |
| **ZipVoice** | **零样本声音克隆**(参考音频→克隆音色),天花板玩法 |
| Pocket       | 新增模型族                                       |

## 1. TTS 在产品里的定位

**定位 A —「字幕配音」任务(推荐主线)**:字幕 → 语音,把 SmartSub 从「字幕工具」延伸为「视频本地化工具」,与现有管线形成闭环:

```
视频 → ASR(+角色分离) → 源字幕 → 翻译 → 校对(改文本/改角色/试听)
                                            ↓
         合成视频 ← 混音/替换音轨 ← 时长对齐 ← 逐句 TTS(每角色一个音色)
```

**定位 B — 校对台朗读**:逐句试听辅助校对,小功能,可作为 A 的副产品顺手实现。

## 2. 接入方式:完全镜像现有架构,双轨制

现有架构已经给出标准答案,TTS 照抄两套成熟模式:

| 轨道         | 照抄对象                | 具体做法                                                                                                                                                                               |
| ------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本地 TTS** | FunASR 的 sherpa 运行时 | 新增 tts-worker(参照 `extraResources/sherpa/worker/sherpa-worker.js`),模型进「引擎与模型」页目录+下载器(参照 `main/helpers/funasrModelCatalog.ts` / `funasrModelDownloader.ts`)        |
| **云端 TTS** | 云端听写 `asrProviders` | 新增 `ttsProviders` 多实例凭据模型(参照 `types/asrProvider.ts` 的 ProviderType/Provider/预设槽位设计),OpenAI 兼容 `/v1/audio/speech` 打头,再扩 ElevenLabs / Azure / 火山豆包 / MiniMax |

主进程侧:

- `main/service/tts/*`:云服务商实现(镜像 `main/service/asr/*` 的 service + utils + testConnection 结构)
- `main/helpers/ttsProcessor.ts`:逐句合成 → 时长对齐 → ffmpeg 拼装
- 任务派发复用 `main/helpers/taskProcessor.ts` 的队列/并发/取消(AbortSignal)/进度那一整套

## 3. 用户交互形式

**入口**:启动台新增任务类型「字幕配音」(`renderer/lib/taskTypes.ts` 加一项;accepts: subtitle,或 media+字幕自动匹配——匹配逻辑校对台已有,见 `main/helpers/subtitleDetector.ts`)。

**任务配置页**(与现有 tasks/[type] 页同构):

- TTS 引擎/音色选择(本地模型 或 云服务商实例)
- 有角色标签时 →「角色→音色」映射面板
- 时长策略:语速自适应上限(如 0.8~1.5x)/ 允许溢出 / 截断
- 输出:纯音频(wav/mp3)/ 新增音轨软封装 / 替换原音轨(复用视频合成的 ffmpeg 设施)

**逐句进度**沿用现有任务卡片的阶段格子:解析字幕 → 合成(N/M 句) → 拼装 → 合入视频。

**校对台**:每句加「试听」按钮 + 角色列(下拉改角色)。

**核心 UX 难题:时长适配**。每句 TTS 产物时长 ≠ 字幕 cue 时长,译文比原文长是常态(中→英尤甚)。策略组合:

1. TTS 引擎 lengthScale/speed 参数粗调
2. ffmpeg atempo 精调(钳制在可听范围)
3. 仍超则允许溢出到下一句间隙

这块值得单独出设计。

## 4. 角色区分:现有引擎支持矩阵

| 引擎                             | 原生角色分离 | 说明                                                                                                                       |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| whisper.cpp(内置)                | ❌           | 仅 tinydiarize(tdrz 专用英文 small 模型,只标「换人了」不标「是谁」),不算真支持                                             |
| faster-whisper                   | ❌           | WhisperX 正是在它之上叠 pyannote 才有的分离                                                                                |
| FunASR / Qwen3 / FireRed(sherpa) | ❌           | SmartSub 用的 sherpa ASR 运行时不含;FunASR Python 生态的 cam++ 我们没用                                                    |
| 本地 Whisper CLI                 | ❌           | 标准 whisper CLI 无                                                                                                        |
| **ElevenLabs Scribe**            | ✅           | `diarize` 参数,词级 speaker_id,最多 32 人                                                                                  |
| **Deepgram**                     | ✅           | `diarize=true`,词级 speaker                                                                                                |
| **Gladia**                       | ✅           | 原生 diarization,utterance 级 speaker(solaria-3 还专门强化多说话人)                                                        |
| **火山豆包**                     | ✅           | `with_speaker_info`                                                                                                        |
| **腾讯云极速版**                 | ✅           | `speaker_diarization=1`——当前代码显式写死 `'0'`(`main/service/asr/tencentUtils.ts` 注释「不在本期范围」),打开即用          |
| **讯飞大模型转写**               | ✅           | `roleType=1` 角色分离                                                                                                      |
| 阿里云极速版                     | ❌           | 仅多声道 channel_id;说话人分离在非极速版                                                                                   |
| OpenAI 兼容                      | ⚠️           | whisper-1/gpt-4o-transcribe 无;OpenAI 官方另有 gpt-4o-transcribe-diarize 专用模型,但不属于通用兼容协议,Groq/硅基流动不支持 |

云引擎侧基本是「参数打开 + 响应解析加 speaker 字段」的透传活——现有 `AsrWord {word,start,end}` 结构(见 `main/service/asr/*Utils.ts`)加个 `speaker?` 就能承载。

## 5. 本地引擎补齐:WhisperX 思路完全可行,且比想象的近

WhisperX 的角色区分本质 = **ASR 与 diarization 是两个解耦的 pass,靠时间轴重叠合并**:

```
音频 ──┬──→ ASR 引擎(任意一个) ──→ 带时间戳的 segments/words
       │
       └──→ Diarization ──→ [(0.0s-3.2s, S0), (3.4s-7.1s, S1), …]
                │
                ↓  时间重叠归属(whisperx 的 assign_word_speakers,
                ↓  纯几十行逻辑,TS 移植非常容易)
                ↓
        带 speaker 标签的字幕 / 校对数据
```

WhisperX 用的 diarization 是 pyannote(PyTorch)。而 **sherpa-onnx 的 OfflineSpeakerDiarization 就是 pyannote 管线的 ONNX 移植**(pyannote segmentation-3.0 ~9MB + 3D-Speaker/WeSpeaker 声纹嵌入 ~30-70MB + fast clustering),且如第 0 节所说——**这条管线已经编译在随包分发的原生库里**。

因此推荐架构不是「逐引擎实现」,而是把角色分离做成**引擎无关的横切层**(与 VAD 同级的公共设施):

- 7 个本地/CLI 引擎 → 一次实现,全部覆盖(音频本来就在本地,与 ASR 可并行跑)
- 云引擎已原生支持的 → 优先透传原生结果(声学+语义联合判断,通常更准,且省本地算力)
- 云引擎不支持的(阿里云/OpenAI 兼容) → 也能用本地横切层兜底

模型体积小(合计 <100MB),完全适配现有模型目录/下载器基建。

**角色标签存哪**:

- 内部流转:校对数据 JSON 加 `speaker` 字段(`main/helpers/proofreadData.ts` 产出)
- 交付物:SRT 用可选 `[S1]` 前缀(默认关,避免污染文本);ASS 有标准 Actor 字段可写

## 6. 分期路线建议

- **Phase 1 — TTS MVP**:「字幕配音」任务类型;本地 Kokoro/piper + OpenAI 兼容云 TTS;单音色;时长自适应;输出音频/软封装音轨
- **Phase 2 — 角色区分**:sherpa diarization 横切层 + 云引擎 speaker 透传(腾讯那行 `'0'` 改成可配置就是第一滴血)+ 校对台角色列
- **Phase 3 — 多角色配音闭环**:角色→音色映射、混音/替换合成、试听;天花板是 ZipVoice 克隆原声

## 6.5 本地 MVP 冒烟验证(2026-07-06,已跑通)

用随包内置原生库 + vendor JS 实测,两个脚本均零新增依赖跑通:

**`scripts/tts-smoke.mjs` — 基础合成**(模型:vits-icefall-zh-aishell3,31MB,174 音色,8kHz):

- 模型加载 266ms;`numSpeakers=174` 正确暴露
- 3 句合成(不同 sid + 1.2x 变速)全部成功,ffmpeg 校验 wav 有效
- **RTF ≈ 0.023**(M 系芯片 CPU 2 线程):合成 10.4s 音频仅耗 244ms,快于实时 40+ 倍——本地逐句配音的性能完全不是问题

**`scripts/tts-dub-smoke.mjs` — SRT→配音整轨闭环**(双角色演示 SRT,含 `[S1]/[S2]` 前缀约定):

- 解析 SRT → 角色→音色映射(S1→sid0,S2→sid66)→ 逐句合成 → 时长适配 → 时间轴拼装单条 wav,全链路通
- 时长适配雏形已验证:产物超窗时按 `需求变速比 = 产物时长/窗口` 重合成,钳制 1.5x 上限,仍超则记录溢出侵入间隙。实测:可救回的句子确实塞回窗口(4.50s→变速 1.49x 后 4.50s ✓),刻意塞爆的句子(2.5s 窗口 vs 7.7s 台词)钳制后仍溢出 2.62s——证明**纯变速救不了所有句子,溢出策略/译文长度控制必须是一等设计**
- VITS `speed` 参数语义确认:产物时长 ≈ 原时长/speed,可作精确适配抓手(粗调用它,细调可再叠 ffmpeg atempo)

冒烟结论:**双轨制中的本地轨技术风险已清零**。剩余工作是工程化(worker 化、模型目录/下载器、任务类型、UI)而非可行性。注意 aishell3 是 8kHz 电话音质,仅适合冒烟;产品化应选 Kokoro v1.1-zh(24kHz)或 melo/piper(22.05kHz)。

**第二轮:Kokoro v1.1 int8(24kHz,中英混合)复测**(`scripts/tts-kokoro-smoke.mjs`,dub 脚本加 `--engine=kokoro`):

- 模型:kokoro-int8-multi-lang-v1*1(147MB 包,103 音色:0-2 英文、3-57 中文女声 zf*_、58-102 中文男声 zm\__),加载 719ms
- 中文女/男声、**中英混合单句**(「妙幕支持 whisper 和 faster-whisper 引擎…」)、变速、纯英文全部直出成功
- **RTF ≈ 0.61**(CPU 2 线程 int8):仍快于实时,但比 aishell3(0.023)慢 ~25 倍——1h 视频约 30min 有效语音需 ~18min 合成,批量场景需要多线程(numThreads 调高)或进度可视化,产品设计要按「分钟级阶段」预期
- SRT→整轨闭环同样跑通(`dubbed-track-kokoro.wav`);对照发现 **kokoro 的 speed 缩放不完全线性**(需求 1.08x 时产物恰好贴边、1.14x 时仍溢出 0.03s),精确适配需要二次合成或 ffmpeg atempo 微调兜底——「变速重合成」本身也让单句成本 ×2,产品侧可先按「字符/秒」启发式预估语速再合成
- 两处无害告警:lexicon 加载时 `Unknown token: ❓`(词典脏条目);英文词「faster-whisper」音素化出现 `\U+025a` 跳过(不阻断产出,听感需人工确认)

Kokoro 冒烟结论:**音质轨(24kHz)+中英混合可行性确认**;代价是 RTF 上升一个数量级,以及 speed 非线性带来的适配精度问题——两者都是工程参数问题,不是可行性问题。

## 7. 待决策的开放问题

1. **场景优先级**:视频翻译配音(严格对时轴)还是有声朗读(宽松时轴)?决定时长对齐做多重。
2. **「本地优先」卖点是否延续到 TTS**?本地 Kokoro 中文可用但音色数量/自然度不如云端(火山/MiniMax/ElevenLabs);倾向双轨、本地默认。
3. **替换原音轨时背景音怎么办**?真配音需要「原音轨-人声+TTS」,人声分离(UVR5/Demucs 类)是另一个重依赖大坑。MVP 建议只做「混音压低原音量」或「整轨替换」,人声分离另立项。
4. **角色标签在纯字幕交付物上的呈现**:默认只进校对数据/配音内部用,还是提供 `[S1]` 前缀导出选项?

## 附:核查过的代码锚点

- 引擎适配器接口/注册:`main/helpers/engines/types.ts`、`registry.ts`
- 云 ASR 服务商类型与多实例模型:`types/asrProvider.ts`
- 云 ASR 各家实现:`main/service/asr/*`(腾讯 `speaker_diarization=0` 在 `tencentUtils.ts` L78/L95)
- sherpa worker 模式:`extraResources/sherpa/worker/sherpa-worker.js`(ASR+VAD,worker_threads,纯 JS)
- sherpa 原生库状态:`main/helpers/sherpaOnnx/sherpaLibPaths.ts`(SHERPA_VERSION 1.13.2,随包内置)
- 任务队列/并发/取消:`main/helpers/taskProcessor.ts`
- 单文件处理管线(阶段划分参考):`main/helpers/fileProcessor.ts`
- 任务类型定义:`renderer/lib/taskTypes.ts`
- 字幕-视频自动匹配(配音任务可复用):`main/helpers/subtitleDetector.ts`
- 校对数据类型:`types/proofread.ts`
