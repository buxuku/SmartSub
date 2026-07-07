# 探索记录:TTS(字幕配音)功能与角色区分(说话人分离)

> 日期:2026-07-06 · 二轮 2026-07-07(时长对齐专项,见 §6.6)· 状态:**已立项** `openspec/changes/add-tts-dubbing-mvp`（本地 TTS + 字幕配音 MVP 已实现）
> 来源:explore mode 会话,基于代码事实核查(非假设)
> 产品冒烟:`scripts/tts-runtime-smoke.mjs`(worker 往返)、`scripts/tts-dubbing-e2e-smoke.mjs`(对齐管线零重叠)、`scripts/tts-align-smoke.mjs`(可听化对齐,调用 `dubbingAlignment`)

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

**核心 UX 难题:时长适配**。每句 TTS 产物时长 ≠ 字幕 cue 时长,译文比原文长是常态(中→英尤甚)。~~策略组合:1. speed 参数粗调 2. atempo 精调 3. 允许溢出到间隙~~ ← 此雏形已被二轮实验证伪(「允许溢出」直接导致双声重叠,speed 二次合成对 VITS 不可靠),完整方案见 §6.6 时长对齐六层防线。

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
- ⚠ 已知听感缺陷(刻意保留以暴露问题,二轮已量化+修复,见 §6.6):溢出侵入间隙时叠加写入(`track[i] += samples`)→ 前后句**双声重叠**(aishell3 轨道 21.8s 中重叠 3.62s,kokoro 2.78s);逐句贪心变速一超窗就拉满 → **语速忽快忽慢且偏快**(5 句中 4 句被变速,峰值 1.5x)
- VITS `speed` 参数语义确认:产物时长 ≈ 原时长/speed,可作精确适配抓手(粗调用它,细调可再叠 ffmpeg atempo)

冒烟结论:**双轨制中的本地轨技术风险已清零**。剩余工作是工程化(worker 化、模型目录/下载器、任务类型、UI)而非可行性。注意 aishell3 是 8kHz 电话音质,仅适合冒烟;产品化应选 Kokoro v1.1-zh(24kHz)或 melo/piper(22.05kHz)。

**第二轮:Kokoro v1.1 int8(24kHz,中英混合)复测**(`scripts/tts-kokoro-smoke.mjs`,dub 脚本加 `--engine=kokoro`):

- 模型:kokoro-int8-multi-lang-v1*1(147MB 包,103 音色:0-2 英文、3-57 中文女声 zf*\_、58-102 中文男声 zm\_\_),加载 719ms
- 中文女/男声、**中英混合单句**(「妙幕支持 whisper 和 faster-whisper 引擎…」)、变速、纯英文全部直出成功
- **RTF ≈ 0.61**(CPU 2 线程 int8):仍快于实时,但比 aishell3(0.023)慢 ~25 倍——1h 视频约 30min 有效语音需 ~18min 合成,批量场景需要多线程(numThreads 调高)或进度可视化,产品设计要按「分钟级阶段」预期
- SRT→整轨闭环同样跑通(`dubbed-track-kokoro.wav`);对照发现 **kokoro 的 speed 缩放不完全线性**(需求 1.08x 时产物恰好贴边、1.14x 时仍溢出 0.03s),精确适配需要二次合成或 ffmpeg atempo 微调兜底——「变速重合成」本身也让单句成本 ×2,产品侧可先按「字符/秒」启发式预估语速再合成
- 两处无害告警:lexicon 加载时 `Unknown token: ❓`(词典脏条目);英文词「faster-whisper」音素化出现 `\U+025a` 跳过(不阻断产出,听感需人工确认)

Kokoro 冒烟结论:**音质轨(24kHz)+中英混合可行性确认**;代价是 RTF 上升一个数量级,以及 speed 非线性带来的适配精度问题——两者都是工程参数问题,不是可行性问题。

## 6.6 二轮专项:时长对齐(2026-07-07,试听暴露问题 → 业界调研 → 对照实验修复)

试听 §6.5 产物发现两类听感问题:**双声重叠**与**语速偏快**。本轮定位根因、调研业界方案、以 `scripts/tts-align-smoke.mjs` 对照实验验证修复。

### 根因(量化复现)

1. **重叠**:`tts-dub-smoke.mjs` 的「允许溢出侵入间隙」策略把每句死钉在 `cue.start` 并**叠加写入**(`track[i] += samples`),超窗部分与下一句混音。量化:aishell3 轨道 21.8s 中双声重叠 3.62s,kokoro 2.78s。
2. **语速快**,三层叠加:
   - 算法层:逐句贪心变速,一超窗就拉到需求值(封顶 1.5x),句间忽快忽慢;业界经验 >1.2x 听感开始「赶」,>1.5x 明显变调(pyvideotrans 博客同结论);
   - 模型层:**本地模型天然语速偏慢,放大变速需求**——实测 aishell3 sid0 仅 3.3 字/s、sid66 5.7 字/s(同模型音色间差 70%!),kokoro 3.0~4.5 字/s,而正常中文口语 4~5.5 字/s,Edge TTS 4.0~4.6 字/s;
   - 数据层:demo cue#4 刻意塞爆(2.5s 窗口 31 字 = 需 12.4 字/s),物理不可能,任何变速都救不了 → 只能靠译文长度控制或字幕重排。
3. **新发现的方案级坑:VITS(aishell3)合成时长不可复现**——同文本同参数连跑 3 次:7.80s / 7.63s / 7.19s(±0.6s;VITS 推理含随机采样)。kokoro 可复现(6.858/6.849/6.849)但 speed 非线性(§6.5 已知)。**推论:「变速重合成」路线不可靠(aishell3 二次合成时长随机,kokoro 成本×2 且非线性),精确适配的唯一可靠抓手是后置 ffmpeg atempo**——§3 原雏形中 speed 重合成与 atempo 的主次关系应颠倒。

### 业界方案调研(pyvideotrans / VideoLingo / Amazon)

- **pyvideotrans**(`_rate.py` SpeedRate,862 行):三阶段「收集→决策→执行」;四模式(仅音频加速 / 仅视频慢放 setpts / 协同各担一半 / 无变速拼接);**字幕间隙纳入本句可用时长**;`remove_silent_mid` 去静音;`align_sub_audio` **强制把字幕时间轴改到实际配音位置**。
- **VideoLingo**(细节最完整的生产级参照):① 翻译端 `target_multiplier 1.2` 控制译文膨胀;② 合成前 `estimate_duration()` 按音节预估,提前标记「太快/正常/太慢」;③ **塞不下的句子与邻句合并成 chunk 向邻句借富余时间+间隙,整个 chunk 用同一变速率**(听感一致);④ atempo 精调不二次合成(accept=1.2,max=1.4);⑤ `new_sub_times` 输出跟随实际音频的调整版字幕;⑥ 兜底:超 0.6s 内截尾,再超报错。
- **Amazon 自动配音论文**(Interspeech 2020-2022):isochrony(等时性)要从**翻译阶段**开始——verbosity control 控制译文长度匹配源时长,prosodic alignment 把源语音的「短语-停顿」结构投影到译文。核心洞察:**时长对齐是「翻译→合成→拼装」全链路问题,不是 TTS 后处理问题**。
- 共识:没有任何主流 TTS(含 ElevenLabs/MiniMax/CosyVoice 商业档)支持「合成指定时长」,对齐层必须自建且引擎无关。

### 时长对齐六层防线(按介入时机)与对照实验结果

```
①译文长度控制(翻译 prompt 字符预算,治本)→ ②音色级语速预估(按实测字/s 一次合成到位)
→ ③静音修剪(首尾能量修剪,每句白捡 0.1~0.3s)→ ④间隙感知 chunk 统一变速(邻句借时,≤1.2 优先,硬上限 1.4)
→ ⑤ffmpeg atempo 精调(唯一可靠精确抓手)→ ⑥非重叠拼装+字幕重排(游标推进决不叠写;SRT 跟随实际音频)
```

`scripts/tts-align-smoke.mjs` 实现 ③④⑤⑥(①②属翻译/合成前置层),同一 demo 对照:

| 指标     | 原策略(dub-smoke)             | 六层防线(align-smoke)         |
| -------- | ----------------------------- | ----------------------------- |
| 双声重叠 | aishell3 3.62s / kokoro 2.78s | **0 / 0**                     |
| 变速     | 逐句忽快忽慢,峰值 1.5x        | **全局统一 1.24x / 1.38x**    |
| 合成次数 | 超窗句 ×2                     | 全部 ×1(atempo 后置)          |
| 字幕     | 时间轴失真(音画不同步)        | 输出重排版 SRT,音字幕严格同步 |

代价:时间轴漂移(demo 中最大 +2.5s)——28s 语音物理上塞不进 21.7s 时间轴的必然取舍;真实字幕(源自真人语速)极少这么极端,且漂移在大间隙处会自然重新锚定(chunk 边界)。产品化时「最大漂移」应做成用户可选策略(严格对时轴→变速更狠 vs 宽松→更自然)。

### 在线 TTS 对照(本地限制是否成立?)

- **Edge TTS**(免费,pyvideotrans/VideoLingo 默认渠道):实测跑通(msedge-tts npm 包)。天然语速 4.0~4.6 字/s 更贴近真人;合成快(~900ms/句);**rate 参数精确线性**(+20% → 时长÷1.20,+50% → ÷1.50,误差 <1%)——比本地模型的 speed 参数可靠得多。缺点:非官方接口(逆向 Edge 朗读),有失效风险,不适合作为唯一依赖,适合作为云端轨免费选项。
- 硅基流动(CosyVoice2 等):现有 key 返回「需实名认证」,未测。
- **ElevenLabs**:已用 agent 邮箱完成注册+邮箱验证+创建 API key(账号 linxiaodong@agent.qq.com,key 名 smartsub-tts-explore,free tier 10k credits/月)。管理端点可用(订阅/音色列表正常),但 **TTS 合成被风控拦截**:`detected_unusual_activity`(代理/VPN 或多免费账号特征),免费层被禁用、要求升级付费。结论:ElevenLabs 免费层对数据中心/代理网络环境不友好,产品侧接入应按「用户自带 key(BYOK)」设计,与现有 asrProviders 模型一致,不依赖免费层。
- **结论:重叠/语速问题不是本地 TTS 的能力上限,是对齐算法问题;在线 TTS 一样需要同一套对齐层**(其天然语速快、rate 线性只是降低了④⑤的压力)。商业 TTS(ElevenLabs speed 0.7~1.2 / MiniMax speed 0.5~2)均无精确时长控制,BYOK 接入即可,无需为对照专门维护账号。

### 对既有结论的修正汇总

1. §3 时长适配雏形**作废**,以六层防线替代;「允许溢出」必须替换为「非重叠拼装+字幕重排」;
2. §6.5「变速重合成」路线**作废**(VITS 时长不可复现 + kokoro 非线性 + 成本×2),改为「一次合成 + atempo 后置精调」;
3. 新增设计注意点(原文档未提):**采样率统一**(aishell3 8k / kokoro 24k / Edge 24k / 视频 44.1k+,混装与合入视频需统一重采样);**多音色响度一致性**(不同 sid 响度差异明显,拼装前需按段响度归一,否则角色切换忽大忽小);**音色级语速校准**(「角色→音色」映射面板应展示每个音色实测字/s 并驱动②的预估)。

## 7. 待决策的开放问题

1. **场景优先级**:视频翻译配音(严格对时轴)还是有声朗读(宽松时轴)?决定时长对齐做多重。(§6.6 后收窄为:六层防线是公共底座,场景差异只体现在「最大漂移」参数上——严格模式漂移≈0 换更狠变速/截断,宽松模式允许漂移换自然语速)
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
