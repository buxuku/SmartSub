## Context

内置引擎 `builtinEngine.ts` 调用 N-API addon（`whisperAsync`），返回 `result.transcription`，形如 `[startStr, endStr, text][]`，时间 `HH:MM:SS.mmm`。原本 `max_len:0` 走 whisper 原生分段 → CJK 经常只回一条。

关键事实（`whisper.cpp@c8ae48ab` 的 `examples/addon.node/addon.cpp`）：

- `wparams.token_timestamps = params.output_wts || params.max_len > 0;`
- `wparams.max_len = params.output_wts && params.max_len == 0 ? 60 : params.max_len;`

即 **`max_len=1` 自动开启 token 时间戳并「每 token 一段」**，无需改 C++。

VAD 的限制：开 VAD 时段边界（真实停顿）只存在于 addon 内部映射，不暴露给 TS；token 时间戳映射回绝对时间后是「填满」的（段间静音并进静音后首个 token 的时长）。因此仅靠 token 间隔无法还原停顿，需要一个**外部语音边界来源**。

PR #341（已合入 `main`）提供：`analyzePcm16WavEnergy` / `AudioEnergy`、`trimSubtitleTrailingSilence`、`subtitleCueFromSegment`、`fileUtils` 时间工具，以及「全引擎尾部裁尾」。

sherpa 现状（已核实于 `main`）：

- `electron-builder.yml` 打包整个 `extraResources/sherpa/`（含 `vendor/vad.js`、`worker/sherpa-worker.js`、`vad/silero_vad.onnx`）到所有平台；原生库 `sherpa-onnx.node` 构建期由 `scripts/fetch-sherpa-native.mjs` 落地（运行时下载已退役）。
- `silero_vad.onnx`（1.8MB）**已 git 提交**，funasr/qwen/fireRed 共用；`getXxxVadModelPath()` 解析到 `extraResources/sherpa/vad/silero_vad.onnx`。
- `sherpa-worker.js` 已做「读 wav → silero VAD 分段 → 逐段 decode」，但 **VAD 与 ASR 耦合**（`ensureLoaded` 同时建 recognizer + vad，需 ASR 模型）。
- 开发机的 `extraResources/sherpa/native/` 默认只有 `.DS_Store`，需 `yarn sherpa:fetch` 才有 `.node`；`isSherpaLibInstalled()` 在打包产物恒真、dev 下取决于是否 fetch。

临时音频由 `audioProcessor.ts` / `ffmpeg.ts` 统一抽成 16kHz / 单声道 / `pcm_s16le` WAV。

## Goals / Non-Goals

**Goals:**

- 内置引擎 CJK 也能稳定切成多条（普通 + 量化模型）。
- 时间轴带真实停顿空隙（faster-whisper 式），不再首尾相接。
- 全程 0-fork（不改 whisper.cpp，仅保留 AbortSignal 补丁），可平滑跟随上游。
- 以**默认内置的 Silero VAD 为主**的语音边界来源，能量法为兜底，二者统一抽象。
- 复用 PR #341 的能量分析与裁尾。

**Non-Goals:**

- 不改 whisper.cpp 源码。
- 不改其它引擎（faster-whisper / funasr / qwen / fireRed）的既有行为（裁尾已在 `main`）。
- 不在本变更内把分段/ VAD 阈值做成设置项 UI（列为后续）。

## Decisions

### D1：数据源用 `max_len=1`（per-token + token 时间戳）

`builtinEngine` 传 `max_len:1`，addon 自动开 token 时间戳并每 token 一段。实测（Metal/CoreML × base/tiny-q5_1）稳定得到 180+ token 段，量化模型同样可靠。

### D2：可插拔「语音边界源」，统一返回 `Segment[]`

定义统一接口：输入 16k 单声道 PCM16 WAV，输出语音段 `Array<{ start: number; end: number }>`（秒），或在不可用时返回空。两个实现按优先级：

1. **Silero（主）**：经 sherpa「只跑 VAD」入口（见 D3）。
2. **能量（兜底）**：复用 PR #341 `analyzePcm16WavEnergy`，把连续「有声帧」合并成段。

> 关键：retiming / grouping 都只消费 `Segment[]`，与「边界从哪来」解耦。把之前直接在 retime/trim 里用「能量帧」的耦合，改为「边界源 → Segment[] → 下游」，从结构上让 Silero 可替换能量、也便于单测（喂假 `Segment[]`）。

**Alternatives：** 直接在 retime 里读能量帧（旧方案）——与能量法强绑定、无法接 Silero，否决。

### D3：sherpa「只跑 VAD」入口（不加载 ASR、零下载）

在 `sherpa-worker.js` 增 `vad`（only）请求类型：仅 `new sherpa.Vad(buildVadConfig(vadModel, params), 60)`（**不建 OfflineRecognizer**），读 WAV、`acceptWaveform` 滑窗、收集 `vad.front()` 段，用 `segmentTiming` 转秒返回。`vadModel` 用内置 `silero_vad.onnx`（`resolveBundledVadPath`）。主进程侧用 `isSherpaLibInstalled()` 把关：未安装（dev 未 fetch / 加载失败）直接判为「Silero 不可用」走能量兜底。

> 复用现有 `buildVadConfig` / `segmentTiming`（`sherpaConfig.ts`，已被 `test:engines` 覆盖）。worker 内联逻辑须与之保持一致（既有约定）。

**Alternatives：** 复用现有 VAD+ASR 入口并丢弃 ASR 结果——需要 ASR 模型、且白跑解码，否决。

### D4：`retimeTokensToSpeech(tokens, segments)`（贴齐还原停顿）

聚合**之前**，对每个 token `[s,e]`：取其与 `segments` 的交集，把 token 收敛到交集的首/末有声边界（静音后的 token 起点前移到发声点、静音前的 token 末点回收到发声结束）。token 完全落在静音（无交集，多为空 token）则原样保留，避免错位。效果：token 间隔（gap）重新出现，供 D5 切分。

### D5：`groupTokenCues` 聚合规则

按并集切分：(1) 相邻 token 间隔 > `maxGapSeconds`（默认 0.5s，主信号）；(2) 命中句末标点 `。！？!?…`；(3) 累计「显示宽度」> `maxWidth`（默认 40，CJK 记 2）或时长 > `maxDurationSeconds`（默认 8s）兜底。**纯标点 token 不因长度/时长被单独切出**。对非 token 级输入安全降级。

### D6：PR #341 尾部裁剪作最终兜底

retiming 已把每个 token 末点贴回发声结束，聚合后 cue 末点已是「真实发声结束」，对 builtin 而言 `trimSubtitleTrailingSilence` 多为兜底（兜住 whisper 把末 token 拖到 VAD chunk 边界的过冲）。能量可用时执行，仅 Silero 可用而未算能量时可跳过（retime 已对齐）。其它引擎仍按 `main` 现状用能量裁尾。

### D7：默认启用 + 三级优雅降级

retime/group/trim 默认启用。边界源链：Silero（sherpa 装好）→ 能量（PCM16 可解析）→ 空（退回连续时间轴的多段字幕，不报错）。

### D8：内容 token 落静音的「前向贴齐 + cue 收敛」（修复 cue 跨停顿）

真机（`ASR ZH Longgap`，base / base-q8_0）暴露：`請記錄以下信息…` 一串**内容 token** 被 whisper VAD 的「前向填充」把起点塞进 21.6–25.3s 静音区；D4 的「无交集 → 原样保留」（本为空 token 设计）令其滞留静音，D5 只见小间隔（< 0.5s）不切 → cue 起点落在 21.5s 跨过该停顿。实测新管道 4 个 gap，参考 faster-whisper 5 个 gap，差的正是这一处。

修法 **A 为主 + B 兜底**：

- **A（治本，改 D4 retime 无交集分支）**：token 与所有语音段无交集时，仅对**非空内容 token** 前向贴齐到「其后最近语音段」`start`（原时长截到段内）；其后无段则回收到前段末点；**空 / 空白 token 仍原样保留**（沿用既有护栏）。依据：whisper 开 VAD 时「段间静音并进静音后首个 token」是前向填充，故内容 token 真实归属是其后语音段。效果：内容 token 归位 → D5 自然在停顿处切分、gap 复现。**（注：此「逐 token 一律前向」已被 D11 的 run-aware 就近段贴齐取代——前向只在 run 离后段更近时发生，避免句尾尾字被抛到下一句。）**
- **B（兜底，新增纯函数后处理）**：`clampCuesToSegments(cues, segments)` 把每条 cue 起止收进它真正重叠的语音段范围（首个重叠段 `start` / 末个重叠段 `end`）；完全不与任何语音段重叠的 cue 原样返回。`builtinEngine` 在 `groupTokenCues` 之后、`trimSubtitleTrailingSilence` 之前接入，对任何「起止渗进静音」全面兜底。
- 二者均仅在 `segments` 非空时生效，边界源缺失时自动降级为当前行为（与 D7 一致）。

**Alternatives：** 仅「就近贴齐」（不分前后向）——本例「請」距前段末点 0.19s、距后段 3.85s，就近会错误回贴到前段、bug 仍在，故否决，改前向贴齐。

### D9：标点优先软切 + 前导标点归属（§6.2）

D5 只在「句末标点 / 硬宽度·硬时长」处切，连续长语流（如「語音識別、機器翻譯和自然語言處理應用十分廣泛」）只能被 `maxWidth=40` 从词中硬切，粒度比 faster-whisper 粗（真机 14 条 vs FW 20 条）。补两条规则（均在 `groupTokenCues` 内）：

- **软切（标点优先）**：cue 显示宽度达 `softMaxWidth`（默认 10）**或**时长达 `softMaxDuration`（默认 2.5s）后，遇**停顿性标点**即收尾——优先于硬上限，让断句落在自然停顿而非词中。停顿性标点集 `SOFT_PUNCT = /[，,；;]/`，**刻意排除顿号「、」与冒号「：」**：它们常用于号码 / 枚举内部（如「138、0013、800」），软切会把同一逻辑单元切碎。
- **前导标点归属**：开新 cue 时若首 token 为纯标点（`PUNCT_ONLY`），贴回上一条 cue 末尾、不另起——避免出现以「，」开头的字幕条。标点在静音里时间不可信，故**只补字符、不改上一条时间**（不会重新引入跨停顿）。

阈值取 `softMaxWidth=10 / softMaxDuration=2.5`：真机 `ASR ZH Longgap` 由 14 条 → **20 条**（与 FW 20 条对齐），gap 仍 6 个（无新增跨停顿）；「138、0013、800」保持整条、无前导标点条；base / base-q8_0 一致。句末标点仍立即切（与软宽度无关）。剩余两处词中切（`應用時分|廣泛` 为 `maxWidth=40` 硬上限——后由 D16 硬切回溯解决、`祝您工作順|利` 为 Silero 真实 0.55s 停顿）非本决策范围。

**Alternatives：** 把顿号也纳入软切——会切碎电话号 / 枚举，否决；降低 `maxWidth` 替代软切——仍是词中硬切、不在标点处，否决。

### D10：合并单字碎片 cue（弱模型 / VAD 过切兜底）

真机反馈：`base` 等弱模型在自有素材上「切得比较细，有的一句只有一个字（如『廣』『泛』各一条）」。根因不在 §6.2 软切（软切按宽度 ≥10 触发，不会切出单字），而在 **VAD 在词中误插的亚秒级假停顿**：retime 把单字 token 贴到被切碎的相邻语音段、group 见 gap>0.5s 即切 → 单字独立成条。新增纯函数 `mergeShortCues(cues, opts)` 作后处理兜底：

- **判定用「实义字符数」而非显示宽度**：CJK 句号「。」显示宽度也是 2，按宽度会漏判「泛。」这类「字+标点」；故只数字母/数字/表意文字，`≤ minContentChars`（默认 1）即视为碎片。
- **只桥接词内假停顿**：仅当与上一条间隔 ≤ `maxJoinGapSeconds`（默认 1.2s）才并入——真实停顿多为数秒（本素材合法停顿 3–6s），远大于阈值，**不会被并掉**。
- **不produce 超长 cue**：并入后显示宽度 > `maxWidth`（默认 40）则保留碎片不并。
- 连续多个单字会级联并入同一条；首个碎片若其前是真实停顿则原样保留（真·孤立单字）。

`builtinEngine` 管道在 `clampCuesToSegments` 之后、`trimSubtitleTrailingSilence` 之前接入。真机 `ASR ZH Longgap` 无单字碎片 → `merged short=0`、仍 20 条（无回归）；单字过切场景由单测覆盖（「廣」+「泛。」→「廣泛。」）。

**Alternatives：** 调低 VAD 灵敏度（减少假停顿）——属阈值设置化（§6.1）、且会牺牲真实停顿召回，故先做下游碎片兜底；按显示宽度判碎片——漏判「字+全角标点」，否决。

### D11：retime 改「run-aware 就近段贴齐」（取代 D8-A 的逐 token 前向贴齐）

D10 之后，真机 `ASR ZH Longgap`（base / base-q8_0）的 token 日志暴露 D8-A「逐 token 一律前向贴齐」的两个反例：

- **句尾尾字被抛到下一句**：`…應用時分` 的尾字 `廣泛` 落在 49.9–50.4s 静音里（Silero 把该句末点定在 49.92s，尾字溢出边界）。D8-A 把 `泛` 前向贴到**下一句** `本次會議` 的段起点 53.862s → 输出 `泛。` 迟到一条且与下一句**重叠**（用户日志：`13 49,850→49,916 廣` / `14 53,862→54,172 泛。`）。
- **零时长整句塌成零时长条**：`人工智能技術` 整串被 whisper 塞成同一时刻（41.400s）零时长、落在静音里。D8-A 的 `e>s` 守卫只认有时长 token，对零时长不处理 → 输出 `10 41,400→41,400 人工智能技術` 一条**零时长字幕**。

根因：单看一个落静音的内容 token，「整句前向填充的首字」与「句尾溢出边界的尾字」**完全同形**（都紧贴前段末点），逐 token 无法区分，一律前向必然把尾字误抛。改为 **run 级就近段贴齐**：

- **浮动 run**：把「连续的、与任何语音段无交集的内容 token」聚成一个 run（零时长内容 token 也纳入；空 / 空白 / 纯标点 token 不纳入，仍原样保留）。
- **零时长按「点是否在段内」判 anchored**：零时长 token 用 `pointInSeg(t)` 判定——落在某语音段内即视为 anchored 原样保留（不会被误判浮动抛走），否则计入浮动 run。
- **就近段整体平移**：run 离后段更近（`gapNext ≤ gapPrev`）→ 整 run 平移到后段 `start`（前向填充的反向修正，夹到段内）；离前段更近 → 整 run 平移到前段 `end` 紧接上一句（保留 run 内相对偏移与时长；由 `prevSeg.end ≤ runStart` 且 `runEnd ≤ nextSeg.start` 可证平移后仍落在两段之间，不与前后 anchored token 反序 / 越界）。
- 零时长 run 前向贴到后段 `start` 后，与后段首 token gap=0 → 在 `groupTokenCues` 中自然合并，零时长孤条消失。

效果（真机 `ASR ZH Longgap`，base / base-q8_0 一致）：`人工智能技術正在快速發展。` 合并为**一条非零时长** cue（`41,926→44,732`）；`廣泛。` 紧接 `…應用時分` 收在 `49,400→49,916`、**不再抛到 53.862**、与下一句无重叠；19 条、6 个 gap、`merged short=0`（无回归、无新增跨停顿、无单字碎片）。两处反例均由单测覆盖（`廣泛` 回贴、零时长整句前向合并、零时长 token 段内保留、多 token run 保序）。

**Alternatives：** 后向贴齐时让 run「末点对齐前段 end、向前回填」——会越过前一 anchored token 造成反序 / 与真实语音重叠，否决，改「起点对齐前段 end、向后顺延」；保留 D8-A 仅给零时长 token 补最小时长——治标，无法解决尾字被抛，否决。

### D12：按 whisper 内部 VAD 是否开启**分两条管道**（retime/clamp 只用于 VAD-on）

D11 把 VAD-on 调稳后，用户反馈 `medium` **开 VAD 12 条、关 VAD 20 条**，且来回调参数已多轮，质疑方向。遂在 harness 上做 VAD on/off A/B（`medium` / `base-q8_0`，外部 Silero 24 段、speech≈45.6s、silence≈29.8s）：

| 模型      | 路径                    | cues   | gaps(>0.4s) | inSilence |
| --------- | ----------------------- | ------ | ----------- | --------- |
| medium    | VAD-on：group-only      | 12     | 0           | 0         |
| medium    | VAD-on：retime+group    | 12     | 3           | 0         |
| medium    | **VAD-off：group-only** | **19** | 0           | 0         |
| medium    | VAD-off：retime+group   | 26     | 8           | **2**     |
| base-q8_0 | VAD-on：retime+group    | 19     | 5           | 0         |
| base-q8_0 | VAD-off：group-only     | 19     | 3           | 2         |
| base-q8_0 | VAD-off：retime+group   | 20     | 5           | 1         |

**关键结论：**

1. **VAD-on 的 token 时间轴被「静音填充」**（停顿被抹平 / 段间静音并进首字），`group-only` 必然少 gap、易把多句并成长条（`medium` 12 条）；**必须** `retimeTokensToSpeech` + `clampCuesToSegments` 用外部语音边界还原停顿。这是 D4/D8/D11 一直在做的事，方向正确。
2. **VAD-off 的 token 文本 / 切分点更细更准**（`medium` `group-only` 即 19 条、`inSilence=0`、文本更准——细粒度来自更多句末 / 软切标点，**不是**来自停顿）。此时再跑 `retime`（整体平移）反而把「本就对的」token 抛进别的段 → `medium` 19→26、**新增 2 条落静音幻觉**。即 **retime 在 VAD-off 下是负优化**。
3. **但 VAD-off 的 token 时间轴本身仍连续**（harness diag 实测相邻 token gap>0.4s **= 0**），停顿不在 token 里——所以「无声不显字幕」**仍需**借外部段还原（见 D13 的安全 `clampDom`，区别于 retime 的整体平移）。

故按 `vad.useVAD` 分两条管道（已落地 `builtinEngine`）：

```
VAD-on  : retime → group → clamp        → merge → trim   （还原被填充的停顿）
VAD-off : group  → clampDom(D13) → merge → dropCuesInDeepSilence(D12) → trim
```

**`dropCuesInDeepSilence`（VAD-off 幻觉护栏）：** VAD-off 偶发把真实文本整条放到与所有语音段零重叠的位置（如 `base-q8_0` 的 `請記錄`@22s、`廣泛`@50s）。该函数**只丢「离任意语音段 > `minSilenceDistanceSeconds`（默认 1.5s）的深静音」cue**，保留与语音段重叠或贴边界（≤1.5s）的真实尾字；边界源为空时原样返回（优雅降级）。实测 `base-q8_0` 两条贴边界真实文本（dist 0.69s / ~0s）均被正确保留、未误删。

**为何 VAD-off 不能直接套 `clampCuesToSegments`（D8-B）：** 试过 `VAD-off：clamp+drop` 想补回停顿 gap，但 `clampCuesToSegments`（按「首个重叠段 start ~ 末个重叠段 end」收敛）对与外部段漂移的 cue 会误夹：`medium` `请记录以下信息` `[21.0,24.36]` 仅与**上一句**段尾 `19.65–21.31` 重叠 → 被夹成 `[21.0,21.31]`（0.3s 不可读）；`测试内容到此结束` 与一个段尾 + 一个正段双重叠 → `lo` 锚到段尾 `62.0`、**仍跨 62–68 静音**。**解决见 D13** 的「按段覆盖率」安全收敛（只夹「实质覆盖」的段、跳过弱重叠），既复现 gap 又不夹碎漂移 cue。harness `VAD ON/OFF A/B` 保留 `drop-only` / `clamp+drop(old)` / `clampDom+drop` 三列做对照与回归证据。

### D13：VAD-off 用 `clampCuesToDominantSegments`「按段覆盖率」安全还原句间停顿

D12 把 VAD-off 暂定 `drop-only`（不复现句间 gap）。但用户复测仍是「开 12 / 关 18」并追问——VAD-off 18 条文本细且准、唯独缺停顿（字幕在静音处续显到下一条，违背 #55「无声不显字幕」）。D12 的 diag 已证 VAD-off token 时间轴**连续**（相邻 token gap>0.4s = 0），停顿只能借外部段还原；而 `retime`（整体平移）、`clampCuesToSegments`（锚任意重叠段）都因「token 与外部段漂移」误伤。

新增纯函数 `clampCuesToDominantSegments(cues, segments, { minSegmentCoverage=0.5, minDurationSeconds=0.3 })`：

- **只夹「实质覆盖」的段**：仅当 `overlap / segLen ≥ minSegmentCoverage`（cue 真正「装下」该段）才用它当边界；只擦到前句段尾 / 段头的**弱重叠段一律忽略**。收敛到 `[首个强覆盖段 start, 末个强覆盖段 end]`。
- **只会变窄、绝不平移**：起点只后移、终点只前移 → 只会**制造 / 扩大**相邻 cue 的停顿 gap，绝不与前后 cue 反序 / 重叠，也绝不把文本搬到别处（本质区别于 retime）。
- **降级守卫**：无强覆盖段（漂移 cue / 落静音 cue）→ 原样返回，交给 `dropCuesInDeepSilence` 判幻觉；收敛后 < `minDurationSeconds` → 放弃、保留可读原 cue；`segments` 为空 → 原样（优雅降级）。

VAD-off 管道更新为 `group → clampCuesToDominantSegments → merge → dropCuesInDeepSilence → trim`。

效果（harness `VAD ON/OFF A/B`，gap 数对照）：

| 模型      | drop-only             | clamp+drop(old D8-B) | **clampDom+drop(D13)** |
| --------- | --------------------- | -------------------- | ---------------------- |
| medium    | 19 / **gap 0** / 幻 0 | 19 / gap 4 / 幻 0    | 19 / **gap 9** / 幻 0  |
| base-q8_0 | 19 / gap 3 / 幻 2     | 19 / gap 5 / 幻 2    | 19 / **gap 12** / 幻 2 |

`medium` clampDom+drop 真机 SRT 三处关键 cue 均正确：`人工智能技术正在快速发展,` `37→45` 收成 `41,926→44,732`（剪 5s 前导静音）；`测试内容到此结束,` `62→70` 收成 `01:08,070→01:09,884`（剪 6s 内部静音）；而漂移的 `请记录以下信息,` `[21.0,24.36]` **保持可读 3.4s 不被夹碎**（弱重叠跳过）。19 条 / 9 gap / 0 幻觉 / 无单字碎片——**细粒度 + 文本准 + 停顿复现**，VAD-off 也满足 #55。

**Alternatives：** 给 `retime` 加「VAD-off 不平移、只就地夹」开关——等价于本函数但耦合进 retime 复杂分支，否决，独立纯函数更清晰可测；按「dominant 单段」夹（取覆盖最大的一段）——跨「一句含两段」时会丢另一半显示时长，改「所有强覆盖段的并集」更稳。

### D14：VAD 默认值不翻转，改为「就地 UI 引导」（架构 review 的落地）

架构 review 指出「默认 `useVAD !== false` = 开 VAD = 内置引擎更粗（12 vs 18）」是 UX 错配。但 `useVAD` 是**全局设置**，被 builtin / **faster-whisper** / funasr / qwen / fireRed 共用——faster-whisper 的内置 Silero VAD 通常是利好，**翻转全局默认会回归这些引擎**（更易幻觉）。故否决「改默认值」，改为**零行为变更的就地引导**：

- 设置页 VAD 开关下新增常显 muted 提示 `vadBuiltinHint`：「内置 whisper 引擎：关 VAD 分段更细、文本更准（短/中文件推荐）；开 VAD 更适合长音频与严格『无声不显字幕』；其他引擎建议保持开启」。
- 任务高级面板（`AdvancedSheet`）已有 `vad.on/off/hint`，在 on/off 文案各补一句内置引擎分段粒度差异（保留对 faster-whisper 仍成立的幻觉警告）。
- 仅文案（i18n zh/en 同步，`check:i18n` 通过），不改任何引擎行为 / 默认值 / 管道。

**为何不做「按文件长度自动切默认」：** 设置时拿不到文件时长；且全局开关无法逐文件覆写。真正的「内置引擎专属默认」需引入独立设置项或逐引擎默认，属更大改动，列入 Open Questions。

### D15：`enforceMinDisplayDuration` 兜「文本正常但时长极短」的 cue（多语种回归发现）

多语种回归（D14 Open Question，用 `say` 合成英/日长静音素材）暴露一个**与语言无关**的新缺口：`maxWidth=40` 硬切分点可能正好落在「whisper 把句首词压缩到语音段边界前」的位置，切出**文本正常、显示时长却 < 0.6s** 的 cue，一闪而过看不清：

- EN：`Artificial intelligence technology is` = **0.28s**（`40.000→40.280`）；
- JA：`効果を確認するために使います今日は2026年`（19 字）= **0.53s**（`15.142→15.676`）。

这类 cue **三道既有工序都兜不住**：`mergeShortCues` 只收单字碎片（非「正常文本」）、`clampCuesToDominantSegments` 需 ≥50% 段覆盖（这里无 / 弱覆盖）、`dropCuesInDeepSilence` 因是贴边界真实词而保留。

新增纯函数 `enforceMinDisplayDuration(cues, { minDurationSeconds=0.8, perCharSeconds=0.06, maxDurationSeconds=2.5, guardGapSeconds=0.1 })`：

- **只延末点、只吃身后空隙**：把过短 cue 的终点后延到 `期望可读时长 = clamp(实义字符数 × perCharSeconds, minDurationSeconds, maxDurationSeconds)`，并封顶在 `下一条起点 − guardGapSeconds`。**绝不改起点 / 文本、绝不缩短、绝不与下一条重叠**——故只会缩短「身后空隙」，绝不动真实长停顿（4–7s 远大于期望时长，延后仍剩数秒 gap）。
- **末条不延**：纯函数无音频总长，末条（其后无可解析起点）原样返回，越界裁尾交 `trimSubtitleTrailingSilence`。
- **下一条过近 → 部分改善**：无空隙可延时原样返回（EN 那条因下一条仅 0.33s 后，只能 0.28→0.51s；JA 那条有 1.57s 空隙，0.53→1.32s 完全修复）。

两条管道（VAD-on / VAD-off）末尾共用，置于 `trimSubtitleTrailingSilence` 之前。

效果（harness，`short cues<0.8s` = 文本≥2 字但 <0.8s 的条数）：

| 语言 / 模型 / 路径  | minDisp 前 | minDisp 后                  | 长停顿(gap)                                        |
| ------------------- | ---------- | --------------------------- | -------------------------------------------------- |
| JA medium VAD-off   | 1          | **0**                       | 11 → 11（无损）                                    |
| JA base-q8_0 VAD-on | 3          | **1**                       | 7 → 6                                              |
| EN base-q8_0 VAD-on | 2          | **1**                       | 5 → 5                                              |
| EN medium VAD-off   | 1          | 1（0.28→0.51s，下一条过近） | 9 → 8（消的是句内 1.1s 小 gap，4–7s 长静音全保留） |

**Alternatives：** 把过短 cue 与下一条**合并**——会破坏 `maxWidth` 且改文本归属，否决；按语言切 `perCharSeconds`——纯函数拿不到语言，且统一 0.06 + 上限 2.5 已对中英日够用，保持语言无关。

### D16：硬切回溯到最近可断标点（消除孤立句尾词，云端 ASR 对比发现）

云端阿里云词级结果对比（`ASR ZH Longgap`，raw API 18 句 vs 管线 20 条）复现了 D9 遗留的已知残例：`語音識別、機器翻譯和自然語言處理應用十分廣泛。` 整句 23 全角字（宽 46 > 40），句内仅有顿号（不参与软切），一路攒到 `maxWidth=40` 硬上限、在句尾词前一刀 → 孤立尾词条「廣泛。」（0.51s，还要靠 D15 拉到 0.8s）。

改进 `groupTokenCues` 的硬切**位置**（阈值不动，40 经 32/36/40/48 四档实测仍是中英双文字甜点）：

- **当前 cue 改用逐 token 缓冲**（保留每词真实时间戳）。硬上限（宽度/时长）触发时，从缓冲区尾部**回溯到最后一个可断标点**（`HARD_BREAK_PUNCT = /[，,；;、：:]/`）后分割：标点前半段成条，**余部以真实词级时间作新 cue 开头**（不估算、不拉伸）。
- **顿号/冒号收录进回溯集但仍排除在软切外**：软切是「主动提前断句」，顿号参与会切碎号码/枚举（D9 结论不变）；硬切回溯则发生在「必须切一刀」时，切在顿号后严格优于切在词中。
- **不超宽不变式**：余部并入本 token 后仍超限 → 余部单独成条（产生的单字余部由 D10 `mergeShortCues` 回收）；句内无任何可断标点 → 行为与回溯前逐字节一致（诚实降级）。
- 时间戳缺失 token 依旧并入缓冲区尾 token 文本（不丢字、不参与切分）。

效果（真实阿里云词级结果，20→20 条，其余 18 条逐毫秒不变）：`大家好，欢迎…测试|音频。` → `大家好，|欢迎…测试音频。`（恰好恢复 API 原句边界）；`…應用十分|廣泛。` → `語音識別、|機器翻譯和自然語言處理應用十分廣泛。`。句内无标点的 `…第二|會議室召開，` 保持原样。云端六家词级路径与本地 whisper 引擎共用此函数、同时受益。单测新增 6 例（逗号/顿号回溯、无标点降级、余部超限单独成条、拉丁词真实时间、真实语料回归），`test:engines` 440 全过。

**Alternatives：** 降低 `maxWidth` 到 Netflix 中文标准 16 字——实测词中切从 1 处增到 6 处（中文 ASR 句内标点密度不足），否决；放宽到 24 字——超出中文字幕通行单行上限、小屏折行，否决；余部时间按比例插值——词级时间本就真实可用，无需估算，否决。

- **[builtin 用户从不使用 py 引擎，却为 VAD 拉起 sherpa worker / dlopen ~大原生库]** → 仅在「内置引擎 + 本功能 + `isSherpaLibInstalled()`」三者成立时才拉起；能量兜底成本低；worker 复用、按需懒加载。后续可加「边界源=自动/能量/Silero」设置项。
- **[Silero 阈值 / 窗口在强背景音乐、噪声下仍可能误判]** → 比能量法鲁棒；保留能量兜底；阈值后续可设置化。
- **[`max_len=1` 的 DTW 让超长音频略慢]** → 可接受；属既定取舍。
- **[新增 VAD-only 路径回归既有 VAD+ASR 路径]** → 复用同一份 `buildVadConfig`/`segmentTiming`；worker 改动以「新增请求类型」方式，不动既有 transcribe 分支；`test:engines` 守护纯逻辑。
- **[开发机未 `yarn sherpa:fetch` → Silero 不可用]** → 自动回退能量法，行为正确（仅鲁棒性稍降）；文档注明 dev 需 fetch。
- **[连续无停顿长语流被 `maxWidth/maxDuration` 从句中硬切]** → 已由 D9 标点优先软切缓解（在停顿性标点处先切）；被迫硬切时再由 D16 回溯到最近可断标点（含顿号/冒号）分割；仅「整段无任何可断标点」才真正切在词边界。可后续设置化。
- **[D8-A 前向贴齐依赖「whisper 静音前向填充」假设；若某模型后向填充则会偏]** → 已由 D11 升级为 run-aware 就近段贴齐（按 run 离前 / 后段的距离决定前向或后向，不再一律前向）；再以 D8-B 的 `clampCuesToSegments` 后处理纠偏（按真实重叠段收敛，与填充方向无关），组合最稳。
- **[retime 依赖「token 与外部段对齐」整体平移；VAD-off 下会负优化]** → 已由 D12 按 `vad.useVAD` 分管道：`retime` + `clampCuesToSegments` 只在 VAD-on（token 被填充、必须还原）跑；VAD-off 不跑 retime。
- **[VAD-off 句间停顿如何复现而不误夹漂移 cue]** → D13 用 `clampCuesToDominantSegments`「按段覆盖率」安全收敛（只夹实质覆盖的段、只变窄不平移），实测 `medium` gap 0→9、漂移 cue 不被夹碎、无新增幻觉。VAD-off 也满足 #55。
- **[`dropCuesInDeepSilence` 阈值过松漏删幻觉 / 过紧误删贴边界真实尾字]** → 默认 1.5s 偏保守（宁保留也不误删），实测贴边界真实文本（dist 0.69s / ~0s）均保留；阈值后续可设置化。深静音幻觉是 VAD-off 固有现象，护栏只兜「远离任何语音段」的极端条。
- **[`clampCuesToDominantSegments` 覆盖率阈值过高漏夹 / 过低误夹]** → 默认 0.5（cue 须「装下」段过半才用作边界），实测既剪掉前导 / 内部静音、又跳过只擦段尾的漂移 cue（`请记录` 保持 3.4s 可读）；阈值可配置。极端漂移 cue（整条落在两段之间）保持原位、交 `dropCuesInDeepSilence` 判，不会被误删（dist < 1.5s 时保留）。
- **[`enforceMinDisplayDuration` 延末点吃掉真实停顿]** → 只延到「期望可读时长」（≤2.5s）且封顶「下一条起点 −0.1s」，真实句间停顿（4–7s）远大于期望时长，延后仍剩数秒 gap（JA 实测 gap 11→11 无损）；被消的只是句内亚秒~1s 小 gap（EN 句内 1.1s clause gap → 0.35s，可接受）。`perCharSeconds`/`maxDurationSeconds`/`guardGap` 均可配置。
- **[D15 多语种泛化]** → 英/日 `say` 长静音真机回归：clampDom 句间停顿在 zh/en/ja 均还原、无深静音幻觉；短时长 cue 经 D15 消除或显著改善（JA 0.53→1.32s、EN 0.28→0.51s）。注：VAD-off token 连续性**与语言相关**（zh/ja 相邻 token gap=0、en=5），clampDom 两种情形都适用。

## Migration Plan

- 分支：`feature/builtin-subtitle-timeline-0fork`（基于已合入 PR #341 的 `main`）。
- 实施顺序：边界源抽象 + 能量兜底 → sherpa VAD-only 入口 → `retimeTokensToSpeech`/`groupTokenCues` → `builtinEngine` `max_len=1` 管道接线 → 真机回归。
- 其它引擎不动（裁尾已在 `main`）。
- 上游 whisper.cpp：保持 `feature/addon-cancel` = stock + AbortSignal（0-fork）；当前分发的 addon 已支持 `max_len=1`。
- 回滚：本变更集中在内置引擎与新增文件，禁用即把 `builtinEngine` 退回 `max_len:0` 并跳过管道；不影响其它引擎。

## Open Questions

- 边界源是否暴露为设置项（来源选择 + VAD 阈值 / gap / 时长 / 宽度）？倾向后续单独变更。
- builtin 是否对「无停顿超长语流」改为按标点优先软切？已实现（D9，§6.2）。
- 是否需要为 `silero_vad.onnx` 增加完整性校验（损坏时回退能量）？倾向加轻量校验。
- 是否给内置引擎引入**专属 VAD 默认**（独立于全局 `useVAD`，使短/中文件默认走更细的关-VAD 路径）？需新增设置项或逐引擎默认（D14 暂以 UI 引导替代）。
- 管道的 8+ 个硬编码阈值仅在单一中文 clip 上调过，是否做多语种（英/日）、带音乐、超长静音的真机回归并设置化？（tasks §6.4，泛化风险最高）→ **已部分完成**：英/日 `say` 长静音真机回归（D15），暴露并修复「短时长 cue」；带背景音乐 / 真实长素材仍待测，阈值设置化仍 open。
- 是否评估「**永远关内部 VAD + 外部 Silero + clampDom 单管道**」以删除最脆弱的 `retime`？仅长文件因内部 VAD 省内存/抗幻觉而保留开-VAD 分支（架构 review 建议 C）。
