# Design: add-tts-dubbing

> 完整探索与调研依据见 `Design/tts-dubbing-exploration.md`(场景建模、业界方案调研、代码基座勘察)。本文收敛为实施所需的技术决策;与探索文档冲突时以本文为准。

## Context

- SmartSub 现有链路:`processFile` 四阶段(`extractAudio → extractSubtitle → translateSubtitle → 收尾`),阶段状态机(`''/loading/done/error` + `${stage}Progress`/`${stage}Error`)镜像进 `workItems` 持久化(`main/helpers/workItemStore.ts` 的 `STAGE_KEYS`);取消体系 `runWithTaskContext` + `AbortSignal` + `TaskCancelledError` 现成。
- 字幕解析现成:`parseSubtitleEntries` + `parseStartEndTime`(`main/helpers/subtitleFormats.ts`)直接给出每条 cue 的 `startMs/endMs/text`,即对齐引擎的输入。
- sherpa-onnx 基座就绪:内置 `sherpa-onnx.node`(v1.13.2)已含 TTS C API,vendor JS 已导出 `OfflineTts`/`GenerationConfig`,**不需要动 native 构建链**;常驻 worker 模式(`sherpaFunasrRuntime.ts` + `sherpa-worker.js`)与模型下载体系(`qwenModelCatalog/Downloader`)可照抄。
- **ffmpeg 能力缺口**:现有封装只有提取/压缩/静音切片/字幕烧录,没有任何 atempo 变速、concat 拼接、amix 混流、音轨替换封装,音频侧需全部新写;可复用 `runFfmpegSave`(AbortSignal 取消 + 半成品清理)与 `runningCommands` 取消注册表(`main/helpers/audioProcessor.ts`)。应用未捆绑 ffprobe。
- UI 范式:工具页(`subtitleMerge` = 薄页面壳 + Panel + 单一状态 hook + 命名空间 IPC)、行级编辑 + 播放器(proofread 的 `components/subtitle/VideoPlayer` + `media://` 协议)、服务商配置(`ProviderForm` schema 驱动 + `CloudProviderPanel`)。
- 核心挑战是时间轴对齐(isochrony)。业界结论:pyVideoTrans 的间隙借用 + atempo 链;学术界共识是翻译期控长(v2);商业产品(ElevenLabs Dubbing Studio)证明全自动一次到位不现实,必须留人工修正回路。

## Goals / Non-Goals

**Goals:**

- 一条统一配音管线:`字幕源(+可选视频) → 声音方案 → 逐条合成 → 时间轴对齐 → 输出形态`,覆盖换声/翻译配音/纯字幕转音频/外部字幕配音四类场景。
- 独立配音工作台(试听-调整-重生成回路)+ 主流程完成横幅衔接。
- 本地(kokoro、vits-zh)+ 云端(OpenAI 兼容、Edge TTS)双轨引擎;引擎差异对对齐层收敛为 `speedControl` 单一能力位。
- 对齐质量可量化:配音落在自己槽位内的比例 ≥95%;>1.15x 加速行占比 <20%;>1.5x 行 100% 进人工清单;10 分钟视频(约 150 条)本地 kokoro 全流程 ≤5 分钟(M 系 mac)。
- Phase 0 先行:TTS worker、ffmpeg 音频管线、对齐纯函数三件套以命令行脚本验收,技术风险前置清零后再做 UI。

**Non-Goals(v1 明确不做):**

- 自动说话人分离 diarization(D2,业界公认不可靠;数据结构以 `cue.voiceId` 预留)。
- 视频慢放 setpts(D6,全片重编码改变观感)。
- 声音克隆 zipvoice(D5 → v2)、人声/伴奏分离(D3 → v2)、翻译期长度预算 prompt(第 0 层防线 → v2)。
- 主任务流内嵌一条龙配音(D1 → 工作台验证后 v2+)。
- Azure Speech / ElevenLabs 云服务商(→ v1.5)。

## Decisions

### 1. 产品形态:独立工作台 + 横幅衔接(方案 C)

配音品质不确定性远高于转写/翻译(时长、断句、多音字、语气),必须有行级预览-修正回路;主任务流是批量 one-shot 形态,两者气质不合。故:工作台像 `subtitleMerge` 一样独立成页(输入 = 一份字幕 + 可选视频,支持 `?subtitle=&video=` query 预填),主流程 `CompletionBanner` 加「去配音」(复用「去校对/去合成」跳转模式)。
_备选_:A 主流程内嵌(配置爆炸、失败重试粒度差,弃);B 纯独立无衔接(链路断,弃)。

### 2. 引擎抽象:统一 wav 合同 + `speedControl` 能力位

对齐 `main/service/asr` 分发表形制:

```ts
interface TtsSegmentRequest {
  text: string;
  voice: string;
  speed?: number; // 1.0 = 原速
  outWavPath: string; // 统一落 16-bit PCM wav,供对齐管线读取
  signal?: AbortSignal;
}
interface TtsCapabilities {
  speedControl: 'native' | 'ssml' | 'none'; // 对齐引擎分支的唯一耦合点
  clone?: boolean;
  maxCharsPerRequest?: number;
  concurrency?: number;
}
```

- 云端:`main/service/tts/index.ts` 分发表 `TTS_SYNTHESIZER_MAP` + provider 实现;`testConnection` 用真实合成一句 "Hello" 验证(TTS 无廉价探针),返回结构同 ASR。
- 本地:独立常驻 TTS worker(`ttsRuntime.ts` + `tts-worker.js`),消息协议 `load / synthesize / cancel / dispose`,模型实例按参数 cache;**与 ASR worker 分进程**(崩溃隔离,互不抢占)。
- v1 provider 集合:本地 kokoro(多语 103 音色)+ vits-zh;云端 OpenAI 兼容(一个类型吃下 OpenAI/Groq/硅基流动等聚合端点)+ Edge TTS(免费无 key,UI 标注「免费试用档,不承诺可用性」)。
- 本地引擎战略优势:合成免费 → 对齐可「迭代重合成」;云端超长走 atempo 后处理不重合成(省钱)。

### 3. 对齐引擎:纯函数五层防线,v1 落第 1–4 层

```
可用槽位 = next.start - cur.start(末条到媒体结尾;间隙借用即第 3 层,pyVideoTrans 实测把 1.75x 需求降到 1.4x)
ratio = 预估时长 / 可用槽位
 ├ ratio ≤ 1.0        → 原速合成,尾部补静音
 ├ 1.0 < ratio ≤ 1.15 → 合成期 speed 预控制,一次到位(人耳基本无感)
 ├ 1.15 < ratio ≤ 1.5 → speed 预控制 + 复测微调(本地重合成 / 云端 atempo)
 └ ratio > 1.5        → 过长行:进人工兜底清单(改文案 / 单行重生成 / 接受变速)
```

- 时长预估 = 字符数 × 语种语速基准,以实测 wav 时长持续校准(校准数据存内存级即可,v1 不做持久化学习)。
- 实现为 `main/helpers/dubbing/alignment.ts` 纯函数(输入 cue[] + 实测时长表 → 输出 `AlignmentPlan`),对齐 `subtitleTiming.ts` 风格,可单测(新增 `test:dubbing` script,对齐 `test:engines` 模式);边界 case:重叠 cue、零长 cue、末条。
- 拼接槽位制:短补静音、长(兜底后仍超)截断或顺延(用户选项);可选输出时间轴顺延版 srt(纯音频场景有用)。
- wav 时长测量:读 WAV 头(不依赖 ffprobe,应用未捆绑)。

### 4. 重叠 cue:v1 = 检测 + 告警 + 按 start 顺延

单轨拼接遇时间交叠的 cue 会撞车。完整方案是拆多轨分别合成再 `amix`,工程量大;v1 先落「检测 + 行级告警 + 按 start 顺延」,amix 多轨同版本内视工作量决定,否则 v1.5。数据结构与告警语义按「顺延是默认、多轨是升级」设计,避免返工。

### 5. 背景音:静音 / ducking 二选一(一条 ffmpeg filter)

「静音原轨」= 直接丢弃原音轨;「压低原轨」= 原轨 ducking + 配音 `amix` 叠加。人声/伴奏分离(sherpa-onnx spleeter/UVR)留 v2,模型下载体系届时现成。

### 6. ffmpeg 音频管线:全部新写,复用取消模式

`main/helpers/dubbing/audioPipeline.ts` 新封装:atempo 链式变速(单级限 [0.5,2.0],超出串联如 `atempo=2.0,atempo=1.5`)、按槽位补静音、concat 拼接、amix ducking、音轨替换/新增(mkv 多音轨)。全部走 `runFfmpegSave` + `runningCommands` 模式(AbortSignal + 半成品清理 + 按 fileUuid kill)。
_备选_:rubberband 保音高变速(pyVideoTrans 优先项)——应用未捆绑 rubberband,v1 用 atempo 兜底即可,音质红线由 1.5x 阈值保证。

### 7. 模型下载:照抄 qwen 模板,源只配 `ghproxy → github`

`ttsModelCatalog.ts` / `ttsModelDownloader.ts` 照抄 `qwenModelCatalog/Downloader`(release 整包 + 并行下载 + 解包进度 + `downloadProgress`/`modelDownloadDetail` 事件);进度 key `tts:<id>`,模型目录 `userData/models/tts`(`settings.ttsModelsPath` 可覆盖)。旧探索分支实测:kokoro/vits ModelScope 无镜像、HF 镜像 401,故下载源只配 `ghproxy → github`,并提供手动导入入口(modelImport 模式已有)兜底。

### 8. 管线编排与状态:`dubbing:` IPC + workItem `dubbing` 类型

- `dubbingProcessor.ts` 编排:逐条合成(并发闸,本地串行、云端按 provider `concurrency`)→ 对齐 → 拼接 → 背景音 → 输出;行级进度事件。
- IPC:`main/helpers/ipcDubbingHandlers.ts`,`dubbing:` 命名空间,invoke 统一 `{success, data?, error?, cancelled?}`(形制 `ipcSubtitleMergeHandlers.ts`)。
- 持久化:`ttsProviders` 键(`ttsProviderManager.ts`,形制 `asrProviderManager.ts`);userConfig 记忆工作台表单;workItem 新类型 `dubbing` 进「最近任务」,`STAGE_KEYS` 同步扩展。
- 配置双份一致性教训:TTS worker 的模型配置构建收敛到单一纯函数文件,worker 直接 require,不搞双份内联。

### 9. UI:三个既有范式合体

- 页面 `pages/[locale]/dubbing.tsx` = 薄壳;`components/dubbing/` = `DubbingPanel` + 文件条/配置栏/行列表(虚拟滚动)/播放器/导出卡;`hooks/useDubbing.ts` 单一状态 hook(形制 `useSubtitleMerge`)。
- 行级交互:行级 voice 覆盖(`cue.voiceId`,默认全局 voice)、合成前试听/合成后回放、行状态(待合成/合成中/完成/过长警告⚠/失败重试)、过长行三修复动作(改文案重合成/单行重生成/接受变速)。
- 播放器复用 `components/subtitle/VideoPlayer` + `media://` 协议。
- ~~服务商配置进「引擎与模型」页新增「配音」区块(D7)~~ **修订(2026-07-07,用户反馈)**:配音配置独立成「配音服务」导航页(`ttsServices.tsx` + `TtsServicesTab`,形制「引擎与模型」主从双栏)——左栏「本地模型」逐模型条目 + 「在线服务」逐服务商条目(OpenAI/硅基流动/Edge 外显,`buildTtsViews` 数据驱动,添加自定义可扩展);右栏 `TtsModelPanel` / `TtsProviderPanel`。
- 登记:`Layout.tsx` `NAV_ITEMS`(「配音」工作台 + 「配音服务」配置页两项)、`locales/{zh,en}/dubbing.json`、启动台 `CARDS`(工作台)、`CommandPalette`(两项)。
- 类型:`types/ttsProvider.ts`(`TtsProviderType` fields 驱动 + presets + `isTtsProviderConfigured`,形制 `asrProvider.ts`)、`types/dubbing.ts`(`DubbingCue`/`DubbingConfig`/`AlignmentPlan`)。

## Risks / Trade-offs

- [Edge TTS 逆向接口再断供(2025-12 曾大规模断)] → 产品定位「试用档」+ UI 显式标注 + 错误信息引导切换本地/OpenAI 兼容;不做任何依赖 Edge 的核心承诺。
- [kokoro/vits 下载源单一(仅 GitHub)] → ghproxy 前置 + 手动导入模型入口兜底。
- [时长预估不准 → 频繁二次合成] → 语种语速基准表 + 实测校准;本地重合成免费,云端只走 atempo 不重合成。
- [中文多音字/数字读法错误] → v1 靠行级重生成 + 改文案回路兜底;vits `ruleFsts` 规则词典 v2 评估。
- [长视频(1h+,千条字幕)合成排队久] → worker 单实例串行 + 行级进度可视化 + 云端并发闸;多线程后续评估。
- [atempo 变速音质损失(不保音高)] → 1.15x 内人耳无感、1.5x 红线强制人工介入;rubberband 不引入,接受此 trade-off。
- [amix 多轨 v1 可能不落地] → 重叠 cue 至少保证「检测 + 告警 + 顺延」,语义按可升级设计。

## Migration Plan

纯新增功能,无数据迁移、无破坏性变更。分阶段交付:

1. **Phase 0(基建 PoC,无 UI)**:TTS worker 单句合成出 wav(验证 speed 实际效果曲线)→ ffmpeg 五件套封装 + 最小验证脚本 → 对齐纯函数 + 单测。验收:命令行脚本跑通「srt + 视频 → 合成 → 对齐 → 替换音轨」。
2. **Phase 1(v1 MVP)**:模型下载 + 云端 provider + 工作台页面 + 对齐 1–4 层 + 四种输出 + 衔接登记。
3. 回滚:功能整体独立(新页面/新 IPC 命名空间/新 store 键),移除导航入口即可下线,不影响既有链路。

## Open Questions

- **Edge TTS Node 客户端选型**:`msedge-tts` vs `edge-tts-universal`(两者都修复了 2025-12 断供)。实现期各跑一次真实合成后择优,选型标准:维护活跃度、是否支持 rate 参数、包体积。
- **kokoro 模型包的 espeak-ng-data 等资源布局**:下载解包后的目录结构以 sherpa-onnx 官方 release 包为准,catalog 定义时实测确认。
- ~~**语种语速基准表初始值**(字符/秒)~~ **已实测定稿**(Phase 0,kokoro v1.1 int8 @ darwin-arm64):zh ≈ **4.1 字/秒**(sid=10),en ≈ **17.3 字符/秒**(sid=0)。speed 参数生效但实际缩短量小于理论 1/speed(zh:speed=1.15 实际 0.895 vs 理论 0.870,偏差 ~3%;en:speed=1.3 实际 0.847 vs 理论 0.769,偏差 ~10%)——证实第 2 层复测防线必要,预控制 speed 不可假设线性到位。另:worker 内 `generateAsync` 不可传 `onProgress` 回调(TSFN 逐 chunk 分配 external ArrayBuffer,实测 v8 OOM 崩溃),取消语义为句间生效。
- **amix 多轨混合是否进 v1**:Phase 1 中期按剩余工作量拍板,默认 v1.5。
