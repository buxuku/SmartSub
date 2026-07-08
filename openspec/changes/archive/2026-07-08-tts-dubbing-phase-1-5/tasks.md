# Tasks: tts-dubbing-phase-1-5

## 1. 类型与能力声明

- [x] 1.1 `types/ttsProvider.ts`：新增 `TTS_AZURE_SPEECH`（品牌型单例，字段 region/subscriptionKey/可选 endpoint/voices/requestTimeoutSec/concurrency，`speedControl:'ssml'`、maxCharsPerRequest 3000、concurrency 2，SSML 计费与 F0 免费额度 tips key）与 `TTS_ELEVENLABS`（品牌型单例，字段 apiKey/model 默认 `eleven_multilingual_v2`/voices=voice_id 清单预填 premade/可选 apiUrl/requestTimeoutSec/concurrency，`speedControl:'native'`、maxCharsPerRequest 5000，免费额度与中文计费 tips key）两个类型定义
- [x] 1.2 `types/dubbing.ts`：`DubbingConfig` 增加 `overlapMode?: 'shift' | 'mix'`（缺省 shift）；`AlignmentPlanItem` 增加 `lane: number`

## 2. Azure Speech service

- [x] 2.1 新增 `main/service/tts/azureUtils.ts` 纯工具：`escapeXml`、voice 名推导 `xml:lang`、speed→prosody rate 折算（clamp [0.5,2.0]、≈1 省略 prosody）、`buildAzureSsml(text, voice, speed)`、region/endpoint 拼接端点
- [x] 2.2 新增 `main/service/tts/azure.ts`：POST `cognitiveservices/v1`（`Ocp-Apim-Subscription-Key` + `Content-Type: application/ssml+xml` + `X-Microsoft-OutputFormat: riff-24khz-16bit-mono-pcm`），落盘校验 16-bit PCM 单声道、不合规回落 ffmpeg 转码（形制 openaiCompatible 双保险）；超时/AbortSignal/错误分类（401/403 指向 key 与 region 匹配）
- [x] 2.3 `main/service/tts/index.ts` 分发表注册 `TTS_AZURE_SPEECH`；真机验证测试连接与一次真实合成（F0 账号 @eastus 真实合成通过：HTTP 200，riff-24khz-16bit-mono-pcm 2.9s，prosody rate 生效；类型默认 region 保持 eastasia，用户按资源实际区域填写）。**实测修正**：Azure 门户「终结点」展示的是 `*.api.cognitive.*` 通用域（照抄必 404）——`normalizeAzureHost` 自动改写到 `*.tts.speech.*`（国际云 + 21V 各一条规则），404 错误信息与 endpoint tips 同步补充引导

## 3. ElevenLabs service

- [x] 3.1 新增 `main/service/tts/elevenlabsTtsUtils.ts` 纯工具：base URL 规范化（缺省官方端点）、`clampElevenLabsSpeed`（[0.7,1.2]）、请求 body 构造（model_id + voice_settings.speed）
- [x] 3.2 `main/helpers/dubbing/audioPipeline.ts` 新增 `writePcmAsWav(pcmBuffer, sampleRate, outPath)`（复用 buildWavHeader，裸 PCM 落盘为 16-bit PCM 单声道 wav）
- [x] 3.3 新增 `main/service/tts/elevenlabs.ts`：POST `text-to-speech/{voiceId}?output_format=pcm_24000`（xi-api-key 头），裸 PCM 经 `writePcmAsWav` 零转码落盘；错误分类（401 指向 xi-api-key；fetch failed/timeout 附国内代理引导文案）
- [x] 3.4 `main/service/tts/index.ts` 分发表注册 `TTS_ELEVENLABS`；真机验证测试连接与一次真实合成（用户 key 实测 `eleven_multilingual_v2` + pcm_24000 HTTP 200，当前网络直连可达、未走代理）；premade voice_id 预填集合按免费账号逐个实测定稿：**Sarah/George/Adam/Daniel/Charlotte**（Rachel `21m00Tcm…`/Aria `9BWtsMIN…` 已转 library 音色、免费层 API 402，剔除）。**实测新增两类错误引导**：401 受限权限 Key（缺 text_to_speech scope）→ 指引 dashboard 勾权限；402 library 音色 → 指引移除该 voice_id

## 4. 多轨 amix 混合

- [x] 4.1 `main/helpers/dubbing/alignment.ts`：`buildAlignmentPlan` 增加 `overlapMode` 入参——mix 模式贪心轨道分配（按**原字幕区间**排序放入末端不晚于本行 start 的最小编号轨道，放不下开新轨；`CueSlot` 补 `endMs`）+ 每轨独立 cursor 走查（轨内保留顺延/截断语义），所有 item 携 `lane`（shift 恒 0）；无重叠输入两模式产出等价
- [x] 4.2 `main/helpers/dubbing/audioPipeline.ts` 新增 `amixWavs(inputs[], outPath, signal?)`：`amix=inputs=N:duration=longest:normalize=0` + `alimiter` 防削波，输出 16-bit PCM wav，走 runSave 取消模式（真实 ffmpeg 冒烟验证：混流产物/取消语义通过）
- [x] 4.3 `main/helpers/dubbing/dubbingProcessor.ts`：`buildSessionPlan`/`exportDubbing` 接入 `config.overlapMode`——plan items 按 lane 分组逐轨 `assembleTrack`（统一 totalDurationMs）→ 多轨时 `amixWavs` 合轨、单轨跳过 → 进既有背景音/输出路径；顺延字幕导出沿用 `shiftedTimeline` 无特判

## 5. 工作台 UI 与就绪判定

- [x] 5.1 `renderer/hooks/useDubbing.ts`：云端引擎就绪判定收敛为 `isTtsProviderConfigured`（types 纯函数直接 import，unstable 标注同步改为类型定义驱动）；`charEstimate` useMemo（待合成行/全量两种口径的行数与字符量，跳过纯空白行）；persisted 配置增加 `overlapMode` 并接入 `buildConfig`；引擎候选项新增 `providerType`（计费提示分流用）
- [x] 5.2 `DubbingFileBar`：开始/继续/全部重跑按钮旁展示「N 行 · M 字符」（口径随入口切换）；云端引擎选中时叠加计费口径提示（Azure 含 SSML 附加 / ElevenLabs 字节膨胀 / 试听与重生成额外消耗），本地引擎不带计费文案
- [x] 5.3 `DubbingConfigPanel`：新增重叠处理模式选项（顺延/多轨混合，默认顺延），仅 `summary.overlap > 0` 时展示
- [x] 5.4 i18n：`resources.json`（Azure/ElevenLabs 字段 tips ×8、）、`dubbing.json`（字符量 ×4、重叠模式 ×4 文案）zh/en 齐备，`check:i18n` 通过；「配音服务」页两个新条目经 `buildTtsViews` 数据驱动自动外显（测试连接走通用 `testTtsConnection`，实测归入 2.3/3.4 真机验证）
- [x] 5.5 （验收期用户新增诉求）音色在线拉取与名称映射：类型能力位 `voiceListMode: 'replace' | 'label'` + IPC `listTtsVoices`——ElevenLabs（replace：GET /v1/voices 清单替换为账号可用集，缺 voices_read 权限定向引导）与 Azure（label：GET voices/list 区域全量 715 个，仅回填名称映射不动清单，实测「晓晓 (zh-CN)」）；实例新增 `voiceLabels`（id→名称 JSON）+ `parseTtsVoiceLabels`/`resolveTtsVoiceLabel`（实例映射 → 内置 premade 映射 → 原 id 三级回落）；「配音服务」面板「拉取音色」按钮，音色标签与工作台 voice 下拉均按名称展示（title 悬浮露原 id）。调研结论：OpenAI 官方无音色列表 API（文档固定枚举）；硅基 `/v1/audio/voice/list` 仅返回用户自定义音色且属专有端点（非 OpenAI 兼容协议面），不纳入协议型类型
- [x] 5.6 （验收期用户新增诉求）录入效率三件套：Azure region 字段改固定枚举（30 个 Speech 可用区域按字母序，渲染为**可搜索 combobox**（Popover+Command，打字过滤），主权云走 endpoint 覆盖）；音色录入自动补全（已拉取 `voiceLabels` 后按名称/ID 包含匹配下拉，↑↓ 选择、回车/点击录入、Esc 关闭，单候选回车直录）；类型级 `docsUrl` 官方语音库外链（Azure/Edge → 微软 language-support 文档，ElevenLabs → Voice Library，面板「音色文档」按钮 openUrl 打开）

## 6. 测试与验收

- [x] 6.1 `scripts/dubbing/test-dubbing-units.ts` 扩展：`buildAzureSsml`（转义/lang 推导/rate 折算/≈1 省略 prosody 固定向量）、`clampElevenLabsSpeed`、`writePcmAsWav` 包头往返（readWavInfo 校验）、mix 轨道分配（两两重叠/三行互叠/无重叠等价回归）与 shift 既有用例回归，`npm run test:dubbing` 90 项全过
- [ ] 6.2 端到端验收：含重叠 cue 的字幕分别以 shift/mix 导出对比（mix 重叠时段双声、锚定原 start）；Azure 与 ElevenLabs 各跑一次批量合成（速控生效、字符量展示与消耗对得上量级）；`tsc --noEmit` 与 `check:i18n` 通过——**类型检查（改动文件零新增错误）与 check:i18n 已过、amixWavs 冒烟已过；工作台内 shift/mix 对比导出与两家云商真实合成待用户凭据后验收**（注：原任务写的 `npm run lint` 项目中不存在，以 tsc --noEmit 替代）
