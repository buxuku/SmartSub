# Tasks: add-tts-dubbing

> 1–3 组 = Phase 0(基建 PoC,无 UI,技术风险前置清零);4–9 组 = Phase 1(v1 MVP)。组内按依赖排序。

## 1. 基础类型与本地 TTS worker(PoC)

- [x] 1.1 新增 `types/dubbing.ts`(`DubbingCue`/`DubbingConfig`/`AlignmentPlan`/行状态枚举)与 `types/ttsProvider.ts` 骨架(`TtsProviderType`/`TtsCapabilities`/`TtsSegmentRequest`,`speedControl: 'native'|'ssml'|'none'`)
- [x] 1.2 新增 TTS 模型配置纯函数模块(kokoro/vits-zh 的 sherpa OfflineTts 配置构建,单一来源供 runtime 与 worker require)
- [x] 1.3 新增 `extraResources/sherpa/worker/tts-worker.js`(load/synthesize/cancel/dispose 消息协议,模型实例按参数缓存)与 `main/helpers/sherpaOnnx/ttsRuntime.ts`(常驻子进程管理、崩溃重建,形制 `sherpaFunasrRuntime.ts`;与 ASR worker 分进程)
- [x] 1.4 手动放置 kokoro 模型跑通单句合成出 16-bit PCM wav;编写 speed 效果验证脚本,实测 speed=1.2/1.5 的时长缩短曲线并记录到 design 的语速基准注记(`scripts/dubbing/speed-curve.mjs`;zh≈4.1字/s、en≈17.3字符/s;发现 onProgress TSFN OOM,取消降级句间生效)

## 2. ffmpeg 音频管线封装(PoC)

- [x] 2.1 新增 `main/helpers/dubbing/audioPipeline.ts`:WAV 头时长测量(不依赖 ffprobe)+ atempo 链式变速(超出 [0.5,2.0] 自动串联)
- [x] 2.2 audioPipeline 续:按槽位补静音 + 拼接成完整音轨(实现为 PCM 采样级拼接 `assembleTrack`,避免 ms 取整漂移,优于逐段 concat)
- [x] 2.3 audioPipeline 续:amix ducking 混流(sidechaincompress + amix)、视频音轨替换、mkv 新增音轨(两步:aac 预编码+全流 copy);统一 `runSave`(AbortSignal + 半成品清理,零 electron 依赖版 runFfmpegSave)
- [x] 2.4 PoC 脚本 `scripts/dubbing/audio-poc.ts`(`npm run poc:dubbing-audio`):13 项检查全过(WAV 头/atempo 链/拼接总长/mp3/替换/ducking/双音轨/取消)

## 3. 对齐引擎纯函数与单测(PoC)

- [x] 3.1 新增 `main/helpers/dubbing/alignment.ts`:可用槽位计算(间隙借用、末条上界)、时长预估(CJK/拉丁分开折算 + 运行期校准)、ratio 四档决策树(1.0/1.15/1.5 阈值)
- [x] 3.2 alignment 续:复测决策(本地重合成一次封顶后转 atempo;云端直接 atempo)、重叠 cue 检测(槽位不挤压前条)与按 start 顺延(cursor 走查)、`buildAlignmentPlan` 槽位规划、`shiftedTimeline` 顺延字幕时间轴
- [x] 3.3 单测 `scripts/dubbing/test-dubbing-units.ts`(`npm run test:dubbing`):53 项全过(四档决策/间隙借用/重叠/零长/末条/空文件/校准/复测/规划/atempo 链)
- [x] 3.4 Phase 0 验收脚本 `scripts/dubbing/e2e-poc.ts`(`npm run poc:dubbing-e2e`):6 条演示字幕(含刻意超长行)全链路跑通,落位率 100%、过长行正确进清单,输出 30s 配音视频

## 4. TTS 模型下载与管理

- [x] 4.1 新增 `main/helpers/ttsModelCatalog.ts`(kokoro v1.1 int8 多语 103 音色 + vits-zh-aishell3 174 说话人;布局经旧探索缓存实测确认;`buildModelRequest` 为布局单一来源;voiceId→sid 查表)
- [x] 4.2 新增 `main/helpers/ttsModelDownloader.ts`(同构 qwen 下载器,源仅 `ghproxy → github`,进度 key `tts:<id>`);`settings.ttsModelsPath` 类型扩展;systemInfoManager 接入 downloadTtsModel/getTtsModelStatus/deleteTtsModel/cancelModelDownload/resolveModelDownloadUrl(scope 'tts')
- [x] 4.3 手动导入接入:`importModel` 支持 engine='tts'(布局校验 + 覆盖前 dispose TTS worker);`openModelsFolder` 支持 pathType='tts'

## 5. 云端 TTS 服务商

- [x] 5.1 完成 `types/ttsProvider.ts`:OpenAI 兼容与 Edge TTS 的 fields schema、presets(OpenAI/硅基流动)、`isTtsProviderConfigured`/`parseTtsVoices`/`getTtsCapabilities`;新增 `ttsProviderManager.ts` + `ttsProviders` store 键
- [x] 5.2 新增 `main/service/tts/`:分发表 + `openaiCompatible.ts`(请求 wav 直出,非 wav 按字节头嗅探转码 16-bit PCM 单声道;`transcodeToPcm16Wav` 落 audioPipeline)
- [x] 5.3 Edge 客户端选型定 `msedge-tts` v2.0.6(2026-06 发版/周下载 32K/41KB,真实合成实测通过;edge-tts-universal 更新较慢)并实现 `edge.ts`(speed→rate 折算、超时、断供引导文案);service 层真实合成落 wav 验证通过
- [x] 5.4 `testConnection.ts` 真实合成 "Hello"(返回结构同 ASR:ok/needsConfig/detail);`maxCharsPerRequest` 发起前守卫在 `synthesizeSegment`;AbortSignal 全链路透传;并发闸复用 `cloudProviderGate`(接线在 6.1 dubbingProcessor)

## 6. 配音管线编排与 IPC

- [x] 6.1 新增 `dubbingProcessor.ts`:会话模型(session + SessionCue)+ 引擎适配器(本地 worker 串行/云端 cloudProviderGate 并发)+ 批量合成(预估→预控制→复测环:重合成一次→atempo→过长)+ 导出(拼接→静音/ducking/替换/新增→可选顺延字幕);行级进度、单行失败不中断、AbortSignal 取消;`probeMediaDurationMs` 走 ffmpeg -i(无 ffprobe)
- [x] 6.2 单行重合成 `resynthesizeCue`(新文本/voice,仅该行重跑)+ 过长行 `acceptOverlongCue`(atempo 对齐进槽位转 accepted)
- [x] 6.3 新增 `ipcDubbingHandlers.ts`(dubbing: 命名空间 9 个 invoke + `dubbing:progress` 事件,统一 `{success,data,error,cancelled}`,powerSave 保活)挂载到 background.ts;`ttsProviders` 读写与 `testTtsProvider` 接入 ipcStoreHandlers
- [x] 6.4 workItem 新类型 `dubbing`(会话级,无 pipelineFiles;中断标记单独分支,不走 STAGE_KEYS——该假设澄清:dubbing 不含 IFiles 阶段字段);首跑创建、导出补 artifacts;表单记忆由 renderer userConfig 承担(7.3)

## 7. 配音工作台 UI

- [x] 7.1 新增 `pages/[locale]/dubbing.tsx` 薄壳 + `hooks/useDubbing.ts` 单一状态 hook + `components/dubbing/`(Panel/FileBar/ConfigPanel/CueList/Player)
- [x] 7.2 文件条:字幕 + 可选视频选择(dubbing:pickFile)、拖放(字幕扩展名分流)、query 预填、「从最近任务导入」(getWorkItems 取译文字幕+源视频)
- [x] 7.3 配置栏:引擎下拉(本地模型💻/云实例☁️,未就绪禁用,Edge 标注试用档)、voice + 试听、整体语速滑杆、背景音、输出四选(无视频锁 audioOnly)、超长处置、顺延字幕开关;localStorage 记忆恢复(失效回落首个就绪引擎)
- [x] 7.4 行级列表:@tanstack/react-virtual 虚拟滚动 + measureElement 动态行高;六种行状态图标、重叠标记、行级 voice 覆盖(已合成即重合成/pending 仅记录)、行级回放、单行重生成、点击行展开文本编辑
- [x] 7.5 过长行兜底:黄底 + requiredFactor 标注 + 过长/失败筛选;三修复动作(改文案重合成/重新合成/接受变速→accepted);导出前未处理提醒
- [x] 7.6 播放器预览:DubbingPlayer(media:// + ReactPlayer)行↔播放双向联动(点行跳转/播放行高亮);行级音频经 Audio 元素回放(无视频场景可用)
- [x] 7.7 导出卡(并入配置栏):执行导出、产物路径 + 打开目录、跳过行提示、可选顺延字幕产物展示

## 8. 引擎与模型页区块 + 登记衔接

- [x] 8.1 「引擎与模型」页新增「配音」左栏组(两条目):`DubbingModelsPanel`(下载/进度/取消/删除/导入/打开目录,key tts:_)+ `DubbingProvidersPanel`(OpenAI/硅基流动预设槽位 + Edge 单例,动笔物化 + 防抖持久化 + 测试连接 + 已配置 Badge);`useTtsProviders` hook;engineViews 扩展 dubbing:_ 视图
- [x] 8.2 四处登记:NAV_ITEMS「配音」(AudioLines)、`dubbing.json` zh/en、启动台 CARDS(DubbingIcon 手绘图标)、CommandPalette;workItemUtils/recent-tasks 支持 dubbing 类型(路由/标签/状态/过滤);`check:i18n` 通过
- [x] 8.3 CompletionBanner 新增「去配音」(优先译文字幕,媒体任务带视频路径;多文件下拉,形制「去合成」)

## 9. 验收与收尾

- [x] 9.1 质量基准验证(M4 mac,150 条 / 10 分钟视频,80/15/5 真实长度分布):全流程 **4 分 11 秒 ≤5 分钟**;槽位内落位率 **100% ≥95%**;>1.5x 行 **7/7 全部进人工清单(0 漏报)**;>1.15x 行占比由字幕分布决定(本基准 ≤20% 构造)。另跑极端分布(50% 过长行)5:28,重合成环生效、指标语义正确
- [x] 9.2 云端通道:Edge TTS 经 service 层真实合成落 wav 验证通过(msedge-tts,3.1s 音频);OpenAI 兼容以 wav 直出 + 字节头嗅探转码实现,无真实凭据未端到端跑(留待用户配置后经「测试连接」验证);取消语义在 PoC(预 abort 清理半成品)与单测覆盖,UI 全链路取消待手测
- [x] 9.3 全量回归:`test:dubbing` 53 过、`test:engines` 644 过、`test:translate-parser` 14 过、`test:structured-output` 16 过、`check:i18n` 过、`npm run build`(renderer + main webpack)成功、prettier 全部格式化;README 新增「TTS 配音」功能特性段

## 10. 修订:配音配置独立成页(用户反馈 2026-07-07)

- [x] 10.1 新建「配音服务」导航页 `ttsServices.tsx` + `TtsServicesTab`(主从双栏,形制「引擎与模型」):左栏「本地模型」逐模型条目 + 「在线服务」逐服务商条目(OpenAI/硅基流动/Edge 外显,选中即表单);`buildTtsViews` 条目体系(brand/preset/custom/orphan,形制 buildCloudViews)+「添加自定义」多实例扩展
- [x] 10.2 右栏面板:`TtsModelPanel`(单模型下载/进度/取消/删除/导入/打开目录)+ `TtsProviderPanel`(表单/测试连接/清除配置/自定义改名删除/孤儿兜底)
- [x] 10.3 移除「引擎与模型」页配音区块(EngineModelTab/engineViews 还原,删除 DubbingModelsPanel/DubbingProvidersPanel);导航与 CommandPalette 登记「配音服务」;工作台 noEngineHint 指向新页;spec/design/proposal 同步修订记录
