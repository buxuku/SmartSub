# Proposal: add-tts-dubbing

> 依据:`Design/tts-dubbing-exploration.md`(探索定稿 2026-07,决策 D1–D7)。本变更覆盖其路线图的 **Phase 0(基建 PoC)+ Phase 1(v1 MVP 配音工作台)**;Phase 1.5(Azure/ElevenLabs)、Phase 2(声音克隆、人声分离、翻译期压长)不在本变更范围。

## Why

SmartSub 已具备「视频 → 字幕 → 翻译字幕」的完整链路,TTS 配音是链路的自然延伸:用户拿到翻译字幕后,下一步诉求就是生成翻译配音(换声、翻译配音、纯字幕转音频、外部字幕配音四类场景)。目前应用内没有任何 TTS 能力,用户只能导出字幕后借助 pyVideoTrans 等外部工具完成,链路断裂。

核心技术挑战是时间轴对齐(isochrony):译文与原文时长天然不等,需避免语速过快/过慢、重叠字幕撞车等问题——这决定了产品形态必须带「试听-调整-重生成」的人工修正回路,而非批量 one-shot。

## What Changes

- **新增独立「配音工作台」页面**(D1):输入 = 一份字幕 + 可选视频,统一覆盖四类场景;含全局配置(引擎/voice/整体语速/背景音/输出形态)、行级列表(行级 voice 覆盖、试听、重生成、状态)、播放器预览、导出。
- **新增本地 TTS 引擎**:独立常驻 TTS worker(复用现有 sherpa-onnx v1.13.2 已含的 TTS C API,与 ASR worker 分进程);v1 模型 = kokoro(多语 103 音色)+ vits-zh(D4);模型目录 + 下载器(源 `ghproxy → github`)。
- **新增云端 TTS 服务商**:OpenAI 兼容 + Edge TTS(UI 显式标注「免费试用档,不承诺可用性」)(D4);`ttsProviders` 配置 + 测试连接(真实合成一句验证)。
- **新增时间轴对齐引擎**(纯函数 + 单测):合成期 speed 预控制 → 复测(本地重合成/云端 atempo)→ 间隙借用(end_time 扩展到下条 start)→ 过长行(>1.5x)人工兜底清单;重叠 cue 检测 + 告警 + 按 start 顺延。
- **新增 ffmpeg 音频管线封装**:atempo 链式变速、按槽位补静音、concat 拼接、amix ducking 混流、音轨替换/新增——现有封装完全没有这些能力,全部新写(复用 `runFfmpegSave` + `runningCommands` 取消模式)。
- **新增输出形态**:仅音频(wav/mp3)/ 替换音轨 / ducking 混音 / mkv 新增音轨;可选导出时间轴顺延版 srt。背景音 v1 = 静音原轨或压低原轨(D3)。
- **登记与衔接**:独立「配音服务」导航页统一管理本地模型 + 在线服务商(逐条外显 OpenAI/硅基流动/Edge,可添加自定义;原 D7 的「引擎与模型」区块方案实施后按用户反馈修订);新导航项「配音」工作台;启动台卡片、CommandPalette、i18n(`dubbing.json`);主流程 CompletionBanner「去配音」;workItem 新类型 `dubbing`。
- **明确不做**(v1):自动说话人分离(D2)、视频慢放 setpts(D6)、声音克隆(D5 → v2)、人声/伴奏分离(D3 → v2)、主任务流内嵌一条龙配音(D1 → v2+)。

## Capabilities

### New Capabilities

- `tts-local-engine`:本地 sherpa-onnx TTS——常驻 worker 生命周期(load/synthesize/cancel/dispose)、kokoro/vits-zh 模型目录与下载管理(进度事件、模型目录、手动导入)、单段合成(text/voice/speed → 16-bit PCM wav)。
- `tts-cloud-providers`:云端 TTS 服务商——OpenAI 兼容与 Edge TTS 类型注册、schema 驱动配置表单、测试连接、单段合成、能力声明(`speedControl`/并发/单请求字符上限)、Edge 不稳定性的产品级标注。
- `dubbing-alignment`:时间轴对齐引擎——可用槽位计算(间隙借用)、ratio 决策树(原速/预控制/复测微调/过长兜底)、时长预估与校准、重叠 cue 检测与顺延、槽位规划(补静音/截断/顺延),纯函数可单测。
- `dubbing-pipeline`:配音管线编排——逐条合成(并发闸)→ 对齐 → 按槽位拼接完整音轨 → 背景音处理(静音/ducking)→ 输出形态(仅音频/替换音轨/混音/新增音轨/顺延字幕导出);行级进度事件、AbortSignal 取消、半成品清理。
- `dubbing-workbench`:配音工作台 UI 与集成——文件输入(字幕+可选视频+最近任务导入)、全局配置、行级列表(虚拟滚动、行级 voice/试听/重生成/状态/过长黄标)、播放器预览(`media://`)、导出;「引擎与模型」页配音区块、四处导航登记、CompletionBanner 衔接、workItem `dubbing` 类型。

### Modified Capabilities

(无——现有唯一 spec `xfyun-cloud-asr` 的需求不受影响;主流程仅在完成横幅处新增入口,归入 `dubbing-workbench` 的衔接需求。)

## Impact

- **main 侧新增**:`main/service/tts/`(分发表 + provider 实现)、`main/helpers/sherpaOnnx/ttsRuntime.ts` + `extraResources/sherpa/worker/tts-worker.js`、`main/helpers/ttsModelCatalog.ts`/`ttsModelDownloader.ts`、`main/helpers/dubbing/`(alignment/audioPipeline/dubbingProcessor)、`main/helpers/ipcDubbingHandlers.ts`、`main/helpers/ttsProviderManager.ts`。
- **main 侧修改**:`workItemStore.ts`(`STAGE_KEYS` 扩展 + workItem 类型 `dubbing`)、settings(`ttsModelsPath`、`ttsProviders` 键)、IPC 注册入口。
- **renderer 侧新增**:`pages/[locale]/dubbing.tsx`、`components/dubbing/`、`hooks/useDubbing.ts`、`locales/{zh,en}/dubbing.json`。
- **renderer 侧修改**:`Layout.tsx`(NAV_ITEMS)、启动台 `CARDS`、`CommandPalette`、「引擎与模型」页(新增配音区块)、任务完成横幅(「去配音」)。
- **类型新增**:`types/ttsProvider.ts`、`types/dubbing.ts`。
- **依赖**:不动 native 构建链(现有 `sherpa-onnx.node` 已含 TTS API);新增 Edge TTS 的 Node 客户端依赖(`msedge-tts` 或 `edge-tts-universal`,选型在 design 定);ffmpeg 复用现有捆绑二进制(注意:无 ffprobe,wav 时长读 WAV 头)。
- **测试**:新增 `test:dubbing` script(对齐引擎纯函数单测,对齐现有 `test:engines` 模式)。
- **风险**:Edge TTS 逆向接口随时可能断供(产品定位试用档 + 错误引导切换);kokoro/vits 模型下载源单一(ghproxy 前置 + 手动导入兜底);时长预估不准(实测校准 + 本地重合成免费)。
