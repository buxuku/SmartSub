# TTS 配音功能探索与路线图

> 状态：探索定稿（2026-07）。本文档是 TTS 配音功能从 0 开始的完整分析：场景建模、代码基座盘点、引擎选型、时间轴对齐方案、UX 设计、模块划分与实施路线图。
>
> 说明：本文不基于 `explore/tts-dubbing` 分支的旧探索；该分支仅作为「sherpa TTS 在本工程可跑通」的可行性佐证被引用。

---

## 1. 背景与目标

SmartSub 已具备「视频 → 字幕 → 翻译字幕」的完整链路。TTS 配音是链路的自然延伸，目标覆盖以下场景：

| #   | 场景                           | 输入                                 | 输出                   |
| --- | ------------------------------ | ------------------------------------ | ---------------------- |
| ①   | 视频 + 原字幕 → TTS            | 视频、原语言字幕                     | 换声效果（同语言重配） |
| ②   | 视频 + 原字幕 → 翻译字幕 → TTS | 视频、翻译字幕                       | 翻译配音（一条龙）     |
| ③   | 字幕 → TTS                     | 仅字幕文件                           | 纯音频文件             |
| ④   | 已有视频 + 对应字幕 → TTS      | 视频、外部字幕                       | 音频 + 合成音轨        |
| ⑤   | 其它                           | 校对后配音、双语双音轨、纯文本转有声 | —                      |

场景 ①②④ 中，用户可能只要音频文件，也可能要一步到位替换/合成音轨。

**核心挑战**：时间轴对齐（isochrony）——译文与原文时长天然不等，需要避免语速过快过慢、多角色重叠等问题。

---

## 2. 结论摘要与已拍板决策

**一句话结论**：五个场景可以统一成一条「配音管线」——`字幕源(+可选视频) → 声音方案 → 逐条合成 → 时间轴对齐 → 输出形态`。产品形态上做**独立配音工作台**（而非塞进主任务流），引擎层走**本地 sherpa-onnx + 云端 provider 双轨**，对齐层用**五层防线**（翻译期压长 → 合成期调速 → 后处理变速 → 间隙借用 → 人工兜底）。

### 已拍板决策（D1–D7）

| #   | 决策点             | 结论                                                                                                                                                                                                |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | v1 场景边界        | 独立「配音工作台」：输入 = 一份字幕 + 可选视频（天然覆盖场景①②③④，区别只是用户选哪份字幕）；主流程完成横幅提供「去配音」衔接。主任务流内嵌一条龙配音**不做**，留待工作台体验验证后作为 v2+ 批量形态 |
| D2  | 多角色             | v1 = **按字幕行手动指定 voice**（数据结构预留 `cue.voiceId`）；自动说话人分离（diarization）不做（业界公认不可靠，VideoLingo 明确放弃），远期实验                                                   |
| D3  | 背景音             | v1 = 「静音原轨」/「压低原轨（ducking）+ 配音叠加」两个选项；人声/伴奏分离（sherpa-onnx spleeter/UVR）放 v2                                                                                         |
| D4  | 引擎优先级         | v1 = 本地 kokoro（多语 103 音色）+ vits-zh（中文补充）+ OpenAI 兼容 + Edge TTS（标注「免费试用档，不承诺可用性」）；Azure、ElevenLabs 放 v1.5                                                       |
| D5  | 声音克隆           | v2 = zipvoice 本地零样本克隆（参考音频 + 参考文本；本项目恰好有原字幕可自动生成参考对，是差异化优势）；v1 不做                                                                                      |
| D6  | 视频慢放（setpts） | 不做（v1/v2 均不做）。全片重编码、改变观感，复杂度留给音频侧                                                                                                                                        |
| D7  | 导航归属           | 本地 TTS 模型 + 云端配音服务商统一进「引擎与模型」页新增**「配音」区块**（与云 ASR 服务商同页同形制）；配音工作台为新导航项「配音」                                                                 |

---

## 3. 现状盘点（代码基座勘察结论）

### 3.1 任务管线

- 现有 `processFile` 四阶段：`extractAudio → extractSubtitle → translateSubtitle → 收尾`（`main/helpers/fileProcessor.ts`）。
- 阶段状态机字段模式：`''/loading/done/error` + `${stage}Progress` + `${stage}Error`，随 `taskFileChange` 等四个 IPC 事件流转，并镜像进 `workItems` 持久化（`main/helpers/workItemStore.ts` 的 `STAGE_KEYS`，新增阶段需同步扩展）。
- 取消体系现成：`runWithTaskContext` + `AbortSignal` + `TaskCancelledError`。
- 字幕解析：`parseSubtitleEntries` + `parseStartEndTime`（`main/helpers/subtitleFormats.ts`）直接给出每条 cue 的 `startMs/endMs/text`——对齐引擎的输入现成。

### 3.2 ffmpeg 能力缺口（重要）

现有封装只有「提取音频 / 压缩 / 静音切片 / 字幕烧录与软封装」。**没有任何 atempo 变速、concat 拼接、amix 混流、音轨替换的封装**——配音管线的音频侧需要全部新写。可复用模式：

- `runFfmpegSave(command, outPath, signal)`：AbortSignal 取消 + 半成品清理（`main/helpers/audioProcessor.ts`）；
- `runningCommands` 取消注册表（按 fileUuid kill 进程）。

另注意：应用未捆绑 ffprobe，测量 wav 时长应读 WAV 头或用 `ffmpeg -i` 解析，不要依赖 `ffprobe`。

### 3.3 sherpa-onnx 基座（就绪度超预期）

- 当前内置的同一份 `sherpa-onnx.node`（v1.13.2）**已包含 TTS C API**；vendor JS（`extraResources/sherpa/vendor/sherpa-onnx.js`）已导出 `OfflineTts` / `GenerationConfig`。**不需要动 native 构建链**。
- 常驻 worker 模式（`sherpaFunasrRuntime.ts` + `sherpa-worker.js`）可照抄为独立 TTS worker（与 ASR worker 分进程，崩溃隔离）。
- 模型 catalog + 下载器模板（`qwenModelCatalog/Downloader` 的「release 整包 + 并行下载 + 解包进度 + `downloadProgress`/`modelDownloadDetail` 事件」）可近乎照抄；进度 key 约定 `tts:<id>`，模型目录 `userData/models/tts`（`settings.ttsModelsPath` 可覆盖）。
- 经验教训（来自旧探索分支实测）：kokoro/vits 模型 ModelScope 无镜像、HF 镜像 401，下载源只能 `ghproxy → github`。

### 3.4 UI 范式

- **工具页范式**（配音工作台直接套用）：`subtitleMerge` = 薄页面壳 + Panel 组件 + 单一状态 hook（`useSubtitleMerge`）+ 命名空间 IPC（`xxx:` 前缀，invoke 统一返回 `{success, data?, error?, cancelled?}`）+ 进度事件推送。
- **行级编辑 + 播放器范式**（借鉴 proofread）：`components/subtitle/VideoPlayer` + `media://` 自定义协议播放本地文件，字幕行 ↔ 播放进度双向联动。
- **服务商配置范式**：schema 驱动表单（`ProviderField[]` 声明 → `ProviderForm` 渲染）+ 测试连接 + 已配置 Badge + 防抖持久化；云 ASR 服务商已在「引擎与模型」页的 `CloudProviderPanel` 管理——TTS 服务商按 D7 同页扩展。
- 新页面登记四处：`Layout.tsx` 的 `NAV_ITEMS`、i18n namespace（`renderer/public/locales/{zh,en}/dubbing.json`）、启动台 `CARDS`、`CommandPalette`。

---

## 4. 场景统一建模

```
输入源                    ┌─────── 配音管线（统一内核）────────┐      输出形态
                          │                                  │
①视频+原字幕(ASR产物) ────┤  cue[](startMs,endMs,text,voiceId?) ├──→ A 仅音频 (wav/mp3)
②视频+翻译字幕(一条龙)────┤    → 声音方案(引擎/voice/语速)      ├──→ B 替换音轨的视频
③纯字幕文件 ─────────────┤    → 逐条 TTS 合成                 ├──→ C 混音视频(保留背景音)
④已有视频+外部字幕 ───────┤    → 时间轴对齐                    ├──→ D 新增音轨 (mkv 多音轨)
⑤校对后字幕/其它 ─────────┤    → 按槽位拼接成完整音轨           ├──→ (可叠加软/硬字幕)
                          └──────────────────────────────────┘
```

**关键洞察**：场景 ①②④ 本质是同一件事（有视频 + 有一份字幕），区别只在「字幕的语言和来源」；场景 ③ 是「无视频」子集（输出只能是 A）。所以配音功能的自然输入是**「一份字幕 + 可选视频」**，而不是「任务类型」。这决定了它更像 `subtitleMerge`（工具页），而不是 `tasks/[type]`（批量流水线）。

场景 ⑤ 的潜在形态：校对完成后配音（proofread 衔接）、双语双音轨（原声轨 + 配音轨都保留在 mkv）、纯文本转有声（无时间轴，不需要对齐引擎，是最简单子集，远期可顺手支持）。

---

## 5. 引擎层设计：本地 + 云端双轨

### 5.1 本地（sherpa-onnx）

| 模型家族               | 语言                   | 特点                                  | 语速控制                |
| ---------------------- | ---------------------- | ------------------------------------- | ----------------------- |
| **kokoro** v1.x        | 多语含 zh/en，103 音色 | 82M，本地质量最佳梯队                 | `speed`                 |
| vits-piper             | 各单语种全             | 小、快、免费                          | `speed`(=1/lengthScale) |
| vits-zh (aishell3 等)  | 中文多音色             | 中文补充                              | `speed`                 |
| matcha                 | zh/en                  | 需额外 vocoder                        | `speed`                 |
| **zipvoice**(-distill) | zh/en                  | **零样本声音克隆**：参考音频+参考文本 | `speed`                 |

- v1 落地 kokoro + vits-zh；zipvoice 克隆放 v2（见 D5）。
- zipvoice 克隆需要「参考音频的精确转写文本」——本项目恰好有原字幕，按字幕时间轴从原视频截取参考片段 + 对应字幕文本即可，天然适配（其它工具没有的数据优势）。
- **本地引擎的战略优势**：合成免费 → 对齐策略可以「迭代重合成」（先合一次测时长，超了改 speed 再合），云端这么干要双倍花钱。

### 5.2 云端（provider 形制对齐 asrProviders）

| 引擎         | 语速预控制                                                                                     | 克隆                      | 免费额度          | 风险 / 备注（2026-07 现状）                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI 兼容  | tts-1(-hd) `speed` 0.25–4.0；gpt-4o-mini-tts 的 speed 参数不可靠（用 `instructions` 描述语速） | 无                        | 看端点            | 一个类型吃下 OpenAI/Groq/硅基流动等聚合端点，性价比最高的第一个云通道（v1）                                                                                                                              |
| Edge TTS     | rate ±%                                                                                        | 无                        | 完全免费无 key    | 逆向接口：2025-12 曾大规模断供（新增 10min 上限/4096 字节块/鉴权变更），Node 侧 `msedge-tts`/`edge-tts-universal` 已修复但**随时可能再断**。产品上定位「免费试用档，不承诺可用性」（v1，带显式风险标注） |
| Azure Speech | SSML `prosody rate` 0.5–2.0                                                                    | Custom Neural Voice（贵） | F0 每月 50 万字符 | 500+ 音色最全；计费按**含 SSML 标记的字符数**（UI 要提醒）（v1.5）                                                                                                                                       |
| ElevenLabs   | `voice_settings.speed` 0.7–1.2                                                                 | 即时克隆强                | 1 万字符/月       | $0.10/1k 字符（multilingual v2）。其整套 Dubbing API（$0.33/min）不用——我们是自建管线（v1.5）                                                                                                            |

### 5.3 引擎抽象（接口草图）

对齐 `main/service/asr` 的分发表形制：

```ts
interface TtsSegmentRequest {
  text: string;
  voice: string;
  speed?: number; // 1.0 = 原速
  outWavPath: string; // 统一落 16-bit PCM wav，供对齐管线读取
  signal?: AbortSignal;
}

interface TtsCapabilities {
  speedControl: 'native' | 'ssml' | 'none'; // 决定对齐引擎走哪条分支（唯一耦合点，design 期定死）
  clone?: boolean;
  maxCharsPerRequest?: number;
  concurrency?: number; // 云端限速（复用 cloudProviderGate 思路）
}
```

- 云端：`main/service/tts/index.ts` 分发表 `TTS_SYNTHESIZER_MAP` + 各 provider 实现 + `testConnection`（TTS 无廉价探针，用真实合成一句 "Hello" 验证，形制同 ASR testConnection 的返回结构）。
- 本地：TTS worker 常驻，`load / synthesize / cancel / dispose` 消息协议，模型实例按参数 cache。
- 配置 UI：直接复制 `ProviderForm` schema 驱动模式（fields 声明 + 测试连接 + 已配置 Badge + 防抖持久化）。

---

## 6. 时间轴对齐（核心挑战）

### 6.1 业界方案调研结论

**pyVideoTrans**（最工程化的开源实现，`SpeedRate` 对齐引擎）：

- 预处理：**把每条字幕 end_time 扩展到下条 start_time**——静音间隙并入可用槽位，实测能把 1.75x 的加速需求降到 1.4x（对音质影响巨大）。
- 四模式：仅音频加速 / 仅视频慢放(setpts) / 协同各半（ratio>1.2 时音视频各分担一半时间差）/ 无变速拼接。
- 变速引擎：rubberband（保音高，优先）→ ffmpeg atempo 链式串联（兜底，单级限 [0.5, 2.0]，如 3x = `atempo=2.0,atempo=1.5`）。
- 拼接：槽位制——短了补静音、长了截断，最后 concat。

**学术界**（EMNLP 2025 demos / IWSLT 2024）：共识是**在翻译阶段就控制时长**（isochrony）——LLM 按源语音时长预测目标音素数，迭代改写译文直到长度达标（比合成后变速的音质代价小一个量级）；以及 pause-aware（保留原语音停顿结构）、多译文候选按时长 rerank。

**商业产品**（ElevenLabs Dubbing Studio）：时间轴 + 说话人轨道 UI，**每个 clip 可单独重生成**、可 dynamic generation（允许 clip 长度自适应顺延）、clip/track 级克隆。启示：**全自动一次到位不现实，产品级方案都留了人工修正回路**。

**VideoLingo**：明确放弃多说话人（"whisperX diarization 不够可靠"）——印证自动 diarization 是行业级难题（→ D2）。

### 6.2 五层防线（成本递增，逐层拦截）

```
第0层 翻译期  译文长度预算进翻译 prompt（本项目自有 AI 翻译链路，加提示词零成本；
              可选"超长行 LLM 缩写"作为修复动作）                     [v2]
第1层 合成期  speed 预控制：ratio = 预估时长/可用槽位 → 折算 speed 参数一次合成到位
              （本地=speed；Azure=SSML rate；11labs=speed；
              预估 = 字符数 × 语种语速基准，用实测数据逐步校准）        [v1]
第2层 复测    实测 wav 时长，仍超 → 本地引擎改 speed 重合成（免费）；
              云端改 atempo 后处理（省钱）                            [v1]
第3层 间隙借用 pyVideoTrans 的 end_time 扩展法：把本条之后的静音间隙让给超长配音 [v1]
第4层 兜底    超过音质红线（建议 1.5x）→ 标记"过长行"清单交给用户：
              改文案 / 单行重生成 / 接受变速
              （可选：字幕时间轴跟随音频顺延，输出新 srt——纯音频输出场景有用）[v1]
```

### 6.3 单条字幕的决策树

```
可用槽位 = next.start - cur.start   （末条到媒体结尾）
ratio    = 预估时长 / 可用槽位
 ├ ratio ≤ 1.0        → 原速合成，尾部补静音
 ├ 1.0 < ratio ≤ 1.15 → 合成期 speed 预控制，一次到位（人耳基本无感）
 ├ 1.15 < ratio ≤ 1.5 → speed 预控制 + 复测微调（atempo 或重合成）
 └ ratio > 1.5        → 过长行：进人工兜底清单（UI 黄色警告）
```

最终拼接遵循槽位制：每条配音占一个槽位，短补静音、长（兜底后仍超）截断或顺延（用户选项），`concat` 合成完整音轨。

### 6.4 重叠与多角色

- **重叠字幕**（对话同屏、cue 时间交叠）：单轨拼接会撞车。v1 方案：检测重叠 → 拆成多条轨道分别合成再 `amix` 混合；工程上先落最低限度「检测 + 告警 + 按 start 顺延」，amix 多轨在同版本内视工作量决定。
- **多角色声音**：按 D2，v1 = 行级手动指定 voice（配音工作台列表里每行一个 voice 下拉，默认全局 voice），数据结构 `cue.voiceId` 为将来自动分离预留。

### 6.5 背景音保留

| 阶段 | 做法                                                                                         | 成本                       |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------- |
| v1   | 「静音原轨」或「压低原轨（ducking）+ 配音 amix 叠加」                                        | 一条 ffmpeg filter         |
| v2   | 人声/伴奏分离（sherpa-onnx 官方支持 spleeter/UVR 2-stem，模型下载体系现成）→ 伴奏 + 配音混合 | 全片一次分离推理，耗时明显 |

---

## 7. UX 设计

### 7.1 接入方案对比与选择

| 方案                     | 形态                                                                                                 | 优点                                                             | 缺点                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| A 主流程内嵌             | formData 加配音开关，processFile 加 synthesizeSpeech 阶段                                            | 一条龙、批量                                                     | 配置爆炸；one-shot 出片难满意；失败重试粒度差 |
| B 独立配音工作台         | 像 subtitleMerge：字幕+可选视频进 → 预览/调整/重生成 → 导出                                          | 契合「试听-调整-重生成」循环（商业产品共识）；边界清晰可独立交付 | 从主任务过来要多一跳                          |
| **C = B + 衔接（选定）** | B 的工作台 + 主流程 CompletionBanner「去配音」（复用现有「去校对/去合成」模式，带 srt+视频路径跳转） | 兼顾链路顺滑与体验深度                                           | —                                             |

理由：配音的品质不确定性远高于转写/翻译（时长、断句、多音字、语气），必须有行级预览-修正回路；而主任务流是批量 one-shot 形态，两者气质不合。方案 A 留到工作台体验被验证后作为 v2+ 批量形态。

### 7.2 配音工作台页面草图

（= proofread 的行级编辑 + subtitleMerge 的输出配置，两个既有范式的合体）

```
┌ 配音工作台 ─────────────────────────────────────────────────┐
│ 文件条: [字幕文件] [可选视频] [从最近任务导入▾]      [开始配音] │
├───────────────────┬─────────────────────────────────────────┤
│ 左栏(配置,可折叠)   │ 右栏: 字幕行列表(虚拟滚动)                 │
│ ├ 引擎: 本地/云端▾ │  #   时间轴      文本         声音   状态  │
│ ├ 声音: voice▾ ▶试听│  1  00:01~00:03 你好世界      旁白   ✓ ▶  │
│ ├ 整体语速 ────○── │  2  00:04~00:06 ...(过长 1.8x⚠) 角色A  ↻  │
│ ├ 对齐策略(预设▾)  │  3  00:07~00:09 ...           旁白   … ▶  │
│ ├ 背景音: 静音/压低│ ├─────────────────────────────────────┤ │
│ │                 │ │ 播放器(media://): 视频或波形+当前行高亮 │ │
│ └ 输出: 仅音频/替换 │ │            ◀ ▶ ⏯  00:04 / 12:30       │ │
│        音轨/混音   │ └─────────────────────────────────────┘ │
└───────────────────┴─────────────────────────────────────────┘
```

**主链路**：翻译任务完成 → 横幅「去配音」→ 选声音试听一条 → 开始合成（行级进度）→ 过长行黄标 → 点开改文案 / 单行重生成 / 接受变速 → 整体预览 → 导出。

关键交互点：

- 行级试听（合成前单条预听 voice 效果；合成后播放该行结果）；
- 行级状态：待合成 / 合成中 / 完成 / 过长警告 / 失败重试；
- 过长行的三个修复动作：改文案（重合成该行）、单行重生成、接受变速；
- 输出形态四选：仅音频 / 替换音轨 / ducking 混音 / 新增音轨（mkv 多音轨）。

### 7.3 导航与登记（按 D7）

- 新导航项「配音」→ 配音工作台（`dubbing.tsx`）；
- 「引擎与模型」页新增「配音」区块：本地 TTS 模型下载管理 + 云端配音服务商配置（形制同云 ASR 的 `CloudProviderPanel`）；
- 启动台 `CARDS` 加「配音」卡片（可拖放字幕/视频直达）；
- `CommandPalette`、i18n namespace（`dubbing.json`）同步登记。

---

## 8. 模块划分

### main 侧

| 模块                                                                                   | 职责                                                                                                             | 对齐的既有形制                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `main/service/tts/`                                                                    | 云端分发表 `TTS_SYNTHESIZER_MAP` + provider 实现（openaiCompatible / edge / azure / elevenlabs）+ testConnection | `main/service/asr/`                           |
| `main/helpers/sherpaOnnx/ttsRuntime.ts` + `extraResources/sherpa/worker/tts-worker.js` | 独立常驻 TTS worker（load/synthesize/cancel/dispose；与 ASR worker 分进程崩溃隔离）                              | `sherpaFunasrRuntime.ts` + `sherpa-worker.js` |
| `main/helpers/ttsModelCatalog.ts` / `ttsModelDownloader.ts`                            | 模型目录 + 下载（进度 key `tts:<id>`；`userData/models/tts`；源 `ghproxy → github`）                             | `qwenModelCatalog/Downloader`                 |
| `main/helpers/dubbing/alignment.ts`                                                    | 对齐引擎纯函数：duration 预估 → speed 决策 → 复测决策 → 间隙借用 → 槽位规划（可单测）                            | `subtitleTiming.ts` 纯函数风格                |
| `main/helpers/dubbing/audioPipeline.ts`                                                | ffmpeg 新封装：atempo 变速 / concat 拼接 / amix 混流（ducking）/ 音轨替换与新增                                  | 复用 `runFfmpegSave` + `runningCommands` 模式 |
| `main/helpers/dubbing/dubbingProcessor.ts`                                             | 管线编排：逐条合成（并发闸）→ 对齐 → 拼接 → 输出；行级进度事件                                                   | `fileProcessor.ts` 阶段模式                   |
| `main/helpers/ipcDubbingHandlers.ts`                                                   | `dubbing:` 命名空间 IPC；invoke 统一 `{success,data,error,cancelled}` + 进度事件推送                             | `ipcSubtitleMergeHandlers.ts`                 |
| `main/helpers/ttsProviderManager.ts` + store                                           | `ttsProviders` 键读写；userConfig 记忆配音表单；workItem 新类型 `dubbing`（同步扩 `STAGE_KEYS`）                 | `asrProviderManager.ts`                       |

### renderer 侧

| 模块                         | 职责                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pages/[locale]/dubbing.tsx` | 薄页面壳（PageHeader + Panel；支持 `?subtitle=&video=` query 预填供横幅衔接）                                          |
| `components/dubbing/`        | `DubbingPanel` + 文件条 / 配置栏 / 行列表（虚拟滚动）/ 播放器 / 导出卡                                                 |
| `hooks/useDubbing.ts`        | 单一状态 hook（文件/配置/行状态/进度/输出全收敛，subtitleMerge 范式）                                                  |
| 复用                         | `subtitle/VideoPlayer` + `media://` 协议（行级试听与预览）；`ProviderForm`（服务商配置）；`DownModel` 系列（模型下载） |
| 登记                         | `NAV_ITEMS` / `dubbing.json` i18n / 启动台 `CARDS` / `CommandPalette`                                                  |

### 类型

- `types/ttsProvider.ts`：`TtsProviderType`（fields 驱动表单）+ `TtsProvider` 实例 + presets + `isTtsProviderConfigured`（形制同 `asrProvider.ts`）；
- `types/dubbing.ts`：`DubbingCue`（cue + `voiceId?` + 行状态）+ `DubbingConfig`（引擎/voice/语速/对齐策略/背景音/输出形态）+ `AlignmentPlan`。

---

## 9. 实施路线图

### Phase 0 — 基建 PoC（先证明两件事能跑）

目标：技术风险前置清零，不做 UI。

1. TTS worker：`tts-worker.js` + `ttsRuntime.ts`，kokoro 模型手动放置后单句合成出 wav；验证 speed 参数实际效果曲线（speed=1.2 是否真的缩短 ~17%）。
2. ffmpeg 音频管线：atempo 链式变速、按槽位补静音、concat 拼接、amix ducking、音轨替换——每个封装配最小验证脚本。
3. 对齐引擎纯函数 + 单测（对齐 repo 现有 `test:engines` 模式，新增 `test:dubbing` script）：间隙借用、决策树、槽位规划的边界 case（重叠 cue、零长 cue、末条）。

验收：一个 srt + 一个视频，命令行脚本跑通「合成 → 对齐 → 替换音轨」全链路。

### Phase 1 — v1 MVP：配音工作台

范围（对应 D1–D7 的 v1 侧）：

1. 模型下载：ttsModelCatalog（kokoro-multi-lang、vits-zh）+ 下载器 + 「引擎与模型」页配音区块。
2. 云端引擎：OpenAI 兼容 + Edge TTS（UI 标注不稳定）；`ttsProviders` 配置 + 测试连接。
3. 配音工作台页面：文件条（字幕+可选视频）、全局配置（引擎/voice/整体语速/背景音静音或 ducking/输出形态）、行级列表（虚拟滚动、行级 voice 覆盖、行级试听/重生成/状态）、播放器预览。
4. 对齐：第 1/2/3 层防线 + 过长行黄标清单（第 4 层人工动作：改文案/单行重生成/接受变速）。
5. 输出：仅音频（wav/mp3）/ 替换音轨 / ducking 混音 / mkv 新增音轨；可选导出对齐后字幕（时间轴顺延版 srt）。
6. 衔接与登记：主流程 CompletionBanner「去配音」；workItem 类型 `dubbing`（进「最近任务」）；四处导航登记。
7. 重叠 cue：检测 + 告警 + 按 start 顺延（amix 多轨若工作量允许则纳入，否则 v1.5）。

验收基准（对齐质量可量化）：

- 语音重叠率（配音落在自己槽位内的比例）≥ 95%；
- 加速倍率分布：>1.15x 的行占比 < 20%，>1.5x 的行全部进人工清单（0 漏报）；
- 10 分钟视频（约 150 条字幕）本地 kokoro 全流程 ≤ 5 分钟（M 系 mac 基准）。

### Phase 1.5 — 云端补全

1. Azure Speech（SSML prosody rate；计费含标记字符的 UI 提醒；F0 额度说明）。
2. ElevenLabs（speed 0.7–1.2；字符计费展示）。
3. 云端并发/限速闸（复用 cloudProviderGate 思路）+ 合成字符量预估展示（开跑前告知预计消耗）。
4. 重叠 cue 的 amix 多轨混合（若 v1 未纳入）。

### Phase 2 — 差异化能力

1. 人声/伴奏分离（sherpa-onnx spleeter/UVR）→ 「保留背景音乐」输出选项。
2. zipvoice 本地零样本克隆：按字幕时间轴从原视频自动截取参考音频 + 原字幕做参考文本（差异化卖点）。
3. 第 0 层防线：翻译 prompt 注入长度预算；过长行「LLM 缩写」修复动作（复用现有 AI 翻译链路）。
4. 批量/主流程内嵌形态评估（方案 A 复活与否，取决于工作台数据）。

### 远期（不承诺）

- 自动 diarization 多角色（sherpa-onnx pyannote 分段模型实验）；
- 视频慢放协同（推翻 D6 的条件：用户强需求 + 有人愿意接受全片重编码）；
- 词级 lip-sync 对齐、pause-aware 停顿保留。

---

## 10. 风险与应对

| 风险                                        | 影响                 | 应对                                                                                           |
| ------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| Edge TTS 逆向接口再次断供                   | 免费通道不可用       | 产品定位「试用档」+ 错误信息引导切换本地/OpenAI 兼容；不做任何依赖 Edge 的核心承诺             |
| kokoro/vits 模型下载源单一（仅 GitHub）     | 国内用户下载困难     | ghproxy 前置 + 手动导入模型入口（modelImport 模式已有）                                        |
| 时长预估不准（第 1 层失效）                 | 频繁二次合成，速度慢 | 语种语速基准表 + 按实测持续校准；本地引擎重合成免费，云端走 atempo 不重合成                    |
| 中文多音字/数字读法错误                     | 单行质量差           | 行级重生成 + 改文案回路兜底（v1）；vits `ruleFsts` 规则与词典（v2 评估）                       |
| 长视频（1h+，千条字幕）性能                 | 合成排队时间长       | worker 单实例串行 + 行级进度可视化；云端并发闸；后续评估本地多线程                             |
| `sherpaConfig` 与 worker 内联配置双份一致性 | 维护隐患             | TTS worker 沿用该约定但把配置构建收敛到单一纯函数文件，worker 直接 require（探索期已知改进点） |

---

## 11. 参考资料

- pyVideoTrans 音画对齐原理（SpeedRate 引擎）：https://doc.pyvideotrans.com/blog/Synchronize
- pyVideoTrans 技术架构：https://doc.pyvideotrans.com/yuanli
- Duration-based Translation（EMNLP 2025 demos）：https://aclanthology.org/2025.emnlp-demos.37/
- Pause-Aware Automatic Dubbing（IWSLT 2024）：https://doi.org/10.18653/v1/2024.iwslt-1.2
- sherpa-onnx TTS Node API（kokoro/vits/matcha/zipvoice）：https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_offline_tts.html
- sherpa-onnx 源分离（spleeter/UVR）：https://k2-fsa.github.io/sherpa/onnx/source-separation/index.html
- ZipVoice 零样本克隆：https://github.com/k2-fsa/ZipVoice
- ElevenLabs Dubbing Studio（交互范式参考）：https://elevenlabs.io/docs/eleven-creative/products/dubbing/dubbing-studio
- Edge TTS 可用性风险讨论：https://github.com/rany2/edge-tts / https://news.ycombinator.com/item?id=42800321
- Azure Speech 定价（F0 50 万字符/月）：https://azure.microsoft.com/en-us/pricing/details/speech/
