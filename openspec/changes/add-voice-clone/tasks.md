# Tasks: add-voice-clone

## 1. Phase 0 PoC 与质检管线（风险前置）

- [x] 1.1 zipvoice 真机 PoC：`scripts/voice-clone/zipvoice-poc.mjs`（经 tts-worker 消息协议）——1.13.2 native 加载 zipvoice（encoder/decoder/vocoder）成功、generationConfig 克隆合成出 24kHz wav、RTF 实测（zh 0.31–0.34 / en 0.45 / 短文本 1.56，numSteps=8 → 0.56）、speed 曲线实测（严重非线性 → 对齐按 'none' 处理）；`npm run poc:zipvoice`
- [x] 1.2 `extraResources/sherpa/worker/tts-config.js`：`modelType:'zipvoice'` 分支（encoder/decoder/vocoder/tokens/dataDir/lexicon）+ cacheKey 并入三工件路径；`tts-worker.js`：synthesize 消息 `generationConfig{refWavPath, refText, numSteps}` 透传（readWave 按路径缓存、封顶 8 项、dispose 清空；`extra.min_char_in_sentence=10` 防短行吞音）
- [x] 1.3 `main/helpers/voiceClone/referenceAudio.ts` 质检纯函数：帧分析/切片、能量包络、语音段裁剪与最长静音、SNR 估算、语音电平、质检报告分级（error/warning/info + verdict）、滑窗自动选段（充足度打分 + 超长单段截断）、静音压缩区间规划、自动增益（峰值保护）
- [x] 1.4 `types/voiceClone.ts`：`ClonedVoice`/`VoiceQualityReport`/`VoiceQualityIssue(Code)`/`CloneSegmentSuggestion`/`CLONE_TARGET_RANGES`/`CLONE_VOICE_PREFIX` 工具/IPC 视图类型
- [x] 1.5 `main/helpers/voiceClone/cloneAudioPipeline.ts` 编排层：analyze（ffmpeg 16k 副本 → silero VAD/能量法回退 → 帧分析 → 选段建议 → 会话驻留）、inspectRange（帧切片零 IO）、prepare（源媒体 filter_complex：atrim 拼接 + volume 增益 + 24k mono 落盘 → 定稿复测报告）、会话释放
- [x] 1.6 `scripts/voice-clone/test-voice-clone-units.ts` + `npm run test:voice-clone`：55 项全过（帧分析/切片/语音段工具/SNR/报告分级/选段/静音规划/增益）

## 2. 数据层与 IPC

- [x] 2.1 `main/helpers/voiceClone/voiceCloneManager.ts`：`clonedVoices` store 键读写（list/get/save/rename/remove），`userData/voiceClones/<id>/` 目录管理（ref.wav/sample.wav 落位与删除清理）；`main/helpers/store/types.ts` 增键
- [x] 2.2 `main/helpers/voiceClone/referenceTranscriber.ts`：选区参考文本转写——切选区临时 wav（16k mono）→ 本地 sense-voice（已装优先）→ 已配置云 ASR（`ASR_TRANSCRIBER_MAP` 首个就绪实例）→ 均不可用返回 `{available:false}`（UI 走手动输入）；segments 文本拼接（zh 顿号/en 逗号）
- [x] 2.3 `main/helpers/ipcVoiceCloneHandlers.ts`（`voiceClone:` 命名空间，统一 `{success,data?,error?}`）：pickSource / analyze / inspectRange / transcribeRange / create / list / rename / remove / regenerateSample / disposeAnalysis / subtitleTextForRange；`background.ts` 注册
- [x] 2.4 试听样本合成：create 内调 `dubbingProcessor.previewVoice` 同款链路（zipvoice 引擎 + 新音色参考对），产物归档 `sample.wav`；失败不阻断创建（样本置空、面板 regenerateSample 可重试）

## 3. zipvoice 模型条目与引擎接入

- [x] 3.1 `ttsModelCatalog.ts`：`TtsModelId` 增 `'zipvoice-distill-zh-en'`；spec 增可选 `extraFiles` 与 `cloneOnly`；zipvoice 条目（整包 + vocos vocoder@vocoder-models 双工件、requiredFiles 含 vocoder、`buildModelRequest` 产出 zipvoice 形态、voices 空数组）；新增 `getTtsExtraFileUrl`（ghproxy→github 同源语义）
- [x] 3.2 `ttsModelDownloader.ts`：extraFiles 逐文件下载（复用 downloadArchive 并行/单连接回退 + `.part` 临时名原子落位），进度并入同一 `tts:<id>` key——按既有「分阶段重起」形制（下载→解包→附加件各自 0→99%），不做百分比加权；手动导入校验同 requiredFiles 口径（零改动自动生效）
- [x] 3.3 `sherpaOnnx/ttsRuntime.ts`：`TtsModelRequest` 增 zipvoice 形态（encoder/decoder/vocoder 可选字段、model 转可选）；synthesize 请求透传 `generationConfig{refWavPath, refText, numSteps}`
- [x] 3.4 `dubbing/dubbingProcessor.ts`：`buildEngineAdapter` 按 `spec.cloneOnly` 分支——voiceId（`cv_…`）查 `clonedVoices` → 校验存在/参考音频在盘 → synthesize 携 generationConfig；`speedControl:'none'`（PoC 实测 speed 非线性）、canResynthesize=false（复测走 atempo）、globalSpeed 经 speed 透传；previewVoice 同路由；本地分支合成收敛 `runSynthesize` 免重复
- [x] 3.5 `systemInfoManager.ts`：`getTtsModelStatus` 条目附 `cloneOnly` 标记（渲染层据此把 voice 池切到「我的音色」）
- [x] 3.6 冒烟脚本 `scripts/voice-clone/pipeline-smoke.ts`（`npm run smoke:voice-clone`）：analyze → inspectRange → prepare（真实 ffmpeg filter_complex，24k mono 校验）→ 产物 ref.wav 经 tts-worker 真实克隆合成——管线产物 ↔ 引擎合同端到端打通

## 4. 创建向导 UI

- [x] 4.1 `components/voiceClone/CloneVoiceWizard.tsx`：受控 Dialog + 四步 stepper + 步间状态机（可回退、关闭即释放 disposeAnalysis + 全量重置、分析响应晚于关闭时立即释放）
- [x] 4.2 Step1 选素材：拖放/浏览（`voiceClone:pickSource`）/ 从最近任务（getWorkItems 的 pipelineFiles，携字幕路径）；素材要求指引卡常驻（安静/单人/时长/语气四条）；zipvoice 模型未装警示条
- [x] 4.3 Step2 选段质检：`SegmentPicker`（canvas 能量包络 + 语音段底色高亮 + 选区拖柄/整体平移，自绘零依赖）+ 选区试听（media:// 分析副本 currentTime 区间播放）+ 恢复推荐选区；质检评分卡（verdict 三色边框 + issues 分级配色逐条文案），inspectRange 300ms 防抖；error 级禁用下一步
- [x] 4.4 Step3 参考文本：来源含字幕 → `subtitleTextForRange` 预填；否则 transcribeRange（loading 态 + 来源引擎名展示）；语言切换（zh/en）+ Textarea 校对 + 「逐字核对」提示 + 选区重听 + 重新识别；无 ASR 降级手动输入警示
- [x] 4.5 Step4 命名保存：名称 Input + 授权 Checkbox（必勾、不持久化）→ create → 原声（ref.wav）/克隆样本 A/B 对比按钮 + 样本失败警示 + 「换一段重试」（删除刚建音色回 Step2）/ 完成
- [x] 4.6 `renderer/public/locales/{zh,en}/voiceClone.json` 新 namespace（向导/质检问题码/管理面板全部文案）；`check:i18n` 通过；`ttsServices.tsx` 与 `dubbing.tsx` 注册 namespace

## 5. 管理面板与工作台集成

- [x] 5.1 `TtsServicesTab.tsx`：左栏第三组「我的音色」（`clone:<id>` viewId、名称 + 状态点、组尾「创建克隆音色」虚线入口）；`isTtsServicesViewId` 与选中态回落逻辑兼容 clone: 前缀；创建完成自动选中新条目
- [x] 5.2 `components/tts/ClonedVoicePanel.tsx`：试听样本播放/重新生成、参考音频回放、参考文本、质检报告卡（verdict + SNR + issues）、内联重命名、删除（AlertDialog，main 侧目录清理）、来源/创建时间元信息；`TtsModelPanel` 克隆模型专属文案（cloneModelIntro/clonePool）
- [x] 5.3 `hooks/useDubbing.ts`：`refreshEngines` 按 `cloneOnly` 把 voice 池切为 `voiceClone:list`（按 engine 过滤，label = 音色名）；`DubbingConfigPanel.tsx` 克隆引擎常驻「创建克隆音色」按钮（空态即入口，完成后 refreshEngines + 自动选中新音色）
- [ ] 5.4 工作台既有交互真机回归：行级 voice 覆盖/试听/单行重生成在克隆音色下可用（previewVoice/resynthesizeCue 路由 3.4 已通）；克隆音色被删除后合成报可行动错误（「音色不存在或已删除」实现已落，待真机确认文案链路）

## 6. 测试与验收

- [x] 6.1 单测：质检纯函数全量（帧分析/切片/语音段/SNR/报告分级/选段/静音规划/增益）+ worker tts-config zipvoice 分支（三工件映射/cacheKey/未知类型抛错），`test:voice-clone` 61 项全过（voiceCloneManager/catalog 依赖 electron app 路径，不납入纯 node 单测——由 smoke 与真机覆盖）
- [ ] 6.2 真机端到端（Electron 应用内）：视频文件 → 向导四步 → 创建成功 → 工作台选克隆音色批量合成 10 行 → 导出可播放；黄牌素材（嘈杂/过短）走完全程验证分级文案；删除音色后目录与下拉同步。命令行侧等价链路已由 `smoke:voice-clone` 覆盖（analyze→inspect→prepare→克隆合成）
- [x] 6.3 回归：`test:dubbing` 137 项全过（含 kokoro speed 曲线 PoC 复跑）、`check:i18n` 通过、`tsc --noEmit` 改动文件零新增错误（proxyManager/docs/**tests** 为既有环境问题）；prettier 全部新文件格式化

## 7. 真机反馈修正（2026-07-09，用户 demo.mp4 实测）

- [x] 7.1 **跨语言克隆不可辨修复（字符速率闭环矫正）**：英文视频克隆音色 → 中文配音「听不清且内容不完整」。根因（`crosslingual-test.mjs` 复现）：ZipVoice 按参考音频先验预测目标时长，参考/文本语言错配时预测严重不足——中文被压到 8–12 字/秒（自然 3.5–5.5，实测 43 字仅 3.70s vs 中文参考基准 8.82s）；英文合成正常（同语言）恰印证。**修复方案迭代**：固定 speed 补偿（0.6）在不同参考时长下漂移；模型 speed 参数实测悬崖式过冲（12.5s 参考下 speed 0.53 → 0.9 字/秒，慢 5 倍）不可控——最终落**确定性闭环**：原速合成 → 实测 CJK 字符速率 > `CLONE_ZH_RATE_MAX_CPS`(6.5) 判压缩 → ffmpeg atempo 慢放到 `CLONE_ZH_RATE_TARGET_CPS`(4.5)（线性精确，`closed-loop-test.mjs` 验证 5/5 行全部命中 4.5 字/秒）；慢放后超槽位走既有过长兜底
- [x] 7.2 试听同语言化：`previewVoice` 克隆音色默认试听文本按音色语言（en 音色英文样例）——原先英文音色配中文默认试听文本即触发 7.1 的压缩，「试听听不清」直接来源
- [x] 7.3 音色语言以实际素材为准（防「英文视频 + 默认中文」错标）：本地 sense-voice 转写改 `language:'auto'`；向导转写/字幕预填后按 `dominantTextLanguage` 自动回填语言选择；create 落库时 zipvoice 语言从 refText 推导
- [x] 7.5 **批量合成 SIGTRAP 崩溃修复**：真实合成时 Electron 主进程崩溃（`BFCArena::Extend → operator new → PartitionAlloc CHECK`，worker_threads 同进程带崩应用）。根因：flow-matching 内存随（参考+目标）序列平方级增长——用户参考 12.5s（旧上限 15s 内）+ 跨语言压缩矫正拉长目标帧，onnxruntime arena 大块分配触 Electron PartitionAlloc 单块上限（node 复现峰值 RSS 1.47GB，Electron 更早触顶）。修复三件套：①`splitCloneText` 克隆文本切块（20 CJK/块 ≈ 8s 音频，标点优先 + 硬上限兜底 + 碎块合并，9 项单测）+ worker 逐块生成拼接（块间 100ms 静音、块间取消即时生效）；②存量超长参考（>10s）切块上限减半（`cloneChunkLimit`）；③新建音色参考上限收紧 `CLONE_TARGET_RANGES.zipvoice = {ideal 5–8s, max 10s}`（官方本就建议短参考）。`crash-repro.mjs` 以用户真实选区（demo.mp4 0–12.5s）全字幕行回归通过
- [ ] 7.4 跨语言克隆的固有音质预期（英文参考读中文带口音/韵律偏英）：矫正后可辨但不及同语言参考；后续评估工作台「音色语言 ≠ 字幕语言」提示条 + TTS worker 迁往 utilityProcess（native 崩溃不带崩主进程）
- [x] 7.6 **长课录选段落在微弱区修复（能量感知选段）**：2.4h 讲课 wav（用户实测）自动选段落在 -55dB 的气声/远场区 → 波形细、质检黄牌、ASR 幻听（"Yeah. 嗯。 The."）。根因：silero VAD 对微弱人声也判语音，纯「语音占比」打分把安静区的高占比窗口排到最前。修复：`suggestCloneSegment` 增能量项——窗口语音电平相对全文件 90 分位（`speechLevelReferenceDb`）衰减 4dB 内满分、16dB 归零；`vad-suggest-repro.mjs` 用真实 silero 段复现（旧选段 229s 处 -55.2dB → 新选段 1790s 处 -21.3dB，参照 -17.4dB）。顺带：①`sliceFrameAnalysis` 的 `Math.max(...arr)` 在小时级帧数下栈溢出 → 循环替代；②包络增加全片峰值归一（轻音量录音波形条过细不可辨）
- [x] 7.7 **中文数字读成英文修复（克隆文本前端归一化）**：用户实测「今天是2020年6月25日」的 "2020" 被读成英文——zipvoice 模型包不带 kokoro 的 number/date ruleFsts，阿拉伯数字走 espeak 英文读法（模型限制，豆包云端无此问题）。修复：worker 内 `normalizeChineseCloneText`（CJK 主导文本才处理）——年份逐位（二零二零年）、百分比（百分之三点五）、小数（三点一四）、千位补零（一千零五）、10–19 口语十X、≥9 位长串逐位（电话/编号）；参考文本同步归一（ASR ITN 产出的数字与中文参考发音对齐）；纯外文行不动。9 项单测 + 真机合成试听（num-date.wav / num-percent.wav）
