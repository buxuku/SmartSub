> 实现顺序：先打「类型/存储/服务层」地基（可单测、零 UI），再接引擎与音频，最后做 UI 与护栏。
> spike 结论已固化在 design：优先词级时间戳→复用内置成句管线；无词级→按静音切片降级；显式超时+有限重试。

## 1. 类型与存储（地基，零 UI）

- [x] 1.1 新建 `types/asrProvider.ts`：`AsrProviderType`（`id/name/fields/icon/...`，复用 `types/provider.ts` 的 `ProviderField`）与 `AsrProvider` 实例类型；内置 `ASR_PROVIDER_TYPES`（首个 `openaiCompatible`：必填 `apiUrl`/`apiKey`/`models`，可选 `requestTimeoutSec`/`requestInterval`/`concurrency`）
- [x] 1.2 `types/engine.ts`：`TranscriptionEngine` 增加 `'cloud'`
- [x] 1.3 `main/helpers/store/types.ts`：新增 `asrProviders: AsrProvider[]` 与 `settings.lastUsedTranscription` 兼容 cloud（记 `asrProviderId`）；新增 `settings.cloudUploadConsent`
- [x] 1.4 `main/helpers/asrProviderManager.ts` + `ipcStoreHandlers.ts`：**不写** `asrProviders` 默认值（避免 electron-store 回灌）；提供读取/写入 IPC（`getAsrProviders`/`setAsrProviders`）
- [x] 1.5 `types/types.ts` 的 `IFormData`：新增可选 `transcriptionEngine`/`model`/`asrProviderId`

## 2. 服务层：OpenAI 兼容转写 + 分发表

- [x] 2.1 新建 `main/service/asr/types.ts`：`AsrTranscribeInput { audioPath, model, language?, signal }` 与 `AsrTranscribeResult { text, segments?, words?, hasWordTimestamps }`（words: `{word,start,end}` 秒）
- [x] 2.2 新建 `main/service/asr/openaiCompatible.ts`（纯工具抽到 `openaiCompatUtils.ts`）：用 `openai` SDK 调 `audio.transcriptions.create`，优先 `verbose_json`+`timestamp_granularities:['segment','word']`；**显式超时 + 有限重试**；`verbose_json` 不兼容（如 gpt-4o-transcribe）时降级 plain json 并标记「无词级」
- [x] 2.3 新建 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[type]`（首版仅 `openaiCompatible`），供云引擎按实例 `type` 分发
- [x] 2.4 单测（`test:engines`）：normalizeBaseURL / normalizeLanguage / mapWords / isVerboseUnsupportedError（含 400/422 降级判定）

## 3. 音频准备（云用，本地路径不动）

- [x] 3.1 `main/helpers/audioProcessor.ts`：新增 `prepareCloudAudio(tempAudioFile, limits)`：默认原样返回 WAV；超大小 → ffmpeg 压缩（mp3 单声道 16k）
- [x] 3.2 新增 `splitBySilence(audioFile, maxChunk)`：复用 `energySpeechSegments` 找静音边界切片，返回 `[{path,startOffsetSec,endOffsetSec}]`；边界计算抽到纯模块 `cloudAudioChunking.ts`
- [x] 3.3 单测：`computeChunkBoundaries` 切片边界与偏移正确（无段/超限/静音中点切分）；本地 WAV 始终保留（cleanup 跳过原始路径）

## 4. 时间轴归一与降级

- [x] 4.1 新建 `main/helpers/engines/cloudAsrShared.ts`：`wordsToNativeTokens`（秒→毫秒 `{text,t0,t1}`）；`realignPunctuation`（把整段文本标点 best-effort 贴回字级，解决中文 words 无标点）
- [x] 4.2 复用 `subtitleSegmentation` 管线（`tokensToTriples→groupTokenCues→mergeShortCues→enforceMinDisplayDuration`）+ 引擎侧 `trimSubtitleTrailingSilence` 成句
- [x] 4.3 无词级降级：按 §3.2 切片、每片 transcribe、加偏移拼段级/整段 cue
- [x] 4.4 单测：中文单段+字级 words → 多条 cue；英文子词拼接不加错空格；段级降级带偏移与过滤

## 5. 云引擎适配器 + 注册 + 并发

- [x] 5.1 新建 `main/helpers/engines/cloudAsrEngine.ts`：`isAvailable`、`transcribe`（准备音频→分发→归一/降级→写 SRT→进度/取消）、`cancelActive`（经 AbortSignal）
- [x] 5.2 `main/helpers/engines/registry.ts`：注册 `cloudAsrEngineAdapter`
- [x] 5.3 `main/helpers/taskProcessor.ts`：`isRestrictiveEngine` **不含** `'cloud'`（云可高并发）
- [x] 5.4 取消回归：`ctx.signal` 透传 openai/ffmpeg；切片模式 abort 全部子请求并清理半成品

## 6. 就绪判定与实例解析

- [x] 6.1 泛化「必填字段齐全 = 已配置」判定（`isAsrProviderConfigured`）
- [x] 6.2 云 `isAvailable`：存在至少一个字段齐全实例→ready；否则 not_installed + 引导信息
- [x] 6.3 转写前按 `formData.asrProviderId` 解析实例；缺失/字段不全 → 明确报错（不静默失败）

## 7. UI：云端听写配置页

- [x] 7.1 新增 `CloudAsrPanel`（实例表单 + 新建/编辑/删除 + 「测试连接」按钮）
- [x] 7.2 已配置/未配置状态徽标
- [x] 7.3 入口接线：接入「引擎与模型」页作为一个引擎视图（`cloud`）

## 8. UI：引擎 ▸ 模型下拉承载云实例

- [x] 8.1 `renderer/lib/engineModels.ts`：`getEngineModelGroups` 纳入已配置云实例（每实例一分组）
- [x] 8.2 `renderer/components/Models.tsx`：选中云项回传 `(engine='cloud', model, asrProviderId)`；扩展 `encode/decodeEngineModel` 承载 providerId + `isEngineModelSelected` 统一选中判定
- [x] 8.3 `InlineConfigBar.tsx` + task page：透传 asrProviders；无任何模型/实例时保留「去下载模型」入口
- [x] 8.4 `EngineIcon` 增加 cloud 图标；`engineBadge.cloud` 文案
- [x] 8.5 修复：任务页「默认引擎校正」须待 systemInfo / asrProviders / settings 首载全部完成后再执行——早跑时云实例分组尚未就位，会把仍有效的云选择误判失配、回填本地默认并随表单持久化（表现：用过云引擎后新任务又默认回本地引擎）

## 9. 隐私与成本护栏

- [x] 9.1 首次云转写前一次性「音频离机」确认弹窗（记住选择存 `settings.cloudUploadConsent`）；拒绝则不上传/不转写
- [ ] 9.2 提交云任务前按音频总时长给用量/成本预估提示（未做：各服务商定价差异大，暂以确认弹窗内的费用提醒替代；后续可补精确预估）

## 10. i18n

- [x] 10.1 `renderer/public/locales/{zh,en}/*.json`：服务商字段/tips、引擎徽标、隐私提示、错误文案
- [x] 10.2 `npm run check:i18n` 通过

## 11. 测试与回归

- [ ] 11.1 端到端手测：OpenAI 兼容（whisper-1）中/英视频 → SRT 时间轴自然；`gpt-4o-transcribe` 走降级切片（需真实 key，人工冒烟）
- [ ] 11.2 并发回归：纯云队列按 `maxConcurrentTasks` 并发；云+本地混合队列本地仍被正确钳制（人工冒烟）
- [ ] 11.3 取消/超时回归：进行中取消即停、无半成品；超时不挂起（人工冒烟）
- [x] 11.4 非破坏回归：未配置云服务商时引擎下拉与转写行为与现状一致（`test:engines` 覆盖纯逻辑；未配置实例不进分组）

## 12. 清理

- [x] 12.1 删除一次性验证脚本 `scripts/spike/asr-openai-compat.mjs`
- [x] 12.2 更新 README（zh/en）/ Changelog（新增「云端听写」能力与隐私说明）

## 13. 第二家服务商：ElevenLabs Scribe（验证 ASR_TRANSCRIBER_MAP 可扩展）

- [x] 13.1 `types/asrProvider.ts`：新增 `ASR_ELEVENLABS` 类型（apiKey/models 必填，apiUrl 选填回落官方端点，超时/并发/间隔）
- [x] 13.2 `main/service/asr/elevenlabsUtils.ts`（纯工具）：base url 归一 + `/speech-to-text` 拼接 + words 映射（过滤 spacing/audio_event）+ 重试状态判定
- [x] 13.3 `main/service/asr/elevenlabs.ts`：`/v1/speech-to-text` multipart（fetch+FormData+Blob），词级时间戳直喂管线；显式超时 + 有限重试（429/5xx/超时/网络）；取消区分「取消 vs 超时」
- [x] 13.4 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[elevenlabs]` 注册（云引擎适配器零改动，验证扩展点）
- [x] 13.5 `CloudAsrPanel`：「添加实例」改为按服务商类型下拉；按类型切换测试鉴权（`xi-api-key` vs `Bearer`）；表单头显示服务商类型名
- [x] 13.6 i18n（zh/en）：ElevenLabs 专属字段 tips/placeholder（复用通用 asr 字段）
- [x] 13.7 单测：elevenlabsUtils 全量（base url / 端点 / 词映射 / 重试判定）；`test:engines` 267 过

## 14. 第三家服务商：Deepgram（nova-2/3）

- [x] 14.1 `types/asrProvider.ts`：新增 `ASR_DEEPGRAM` 类型（apiKey/models 必填，apiUrl 选填回落官方端点）
- [x] 14.2 `main/service/asr/deepgramUtils.ts`（纯工具）：base url 归一 + `/listen` query 拼接（smart_format/punctuate + language|detect_language）+ 词映射（punctuated_word 优先）+ 嵌套结果提取
- [x] 14.3 `main/service/asr/deepgram.ts`：`/v1/listen` 二进制体（fetch+Buffer，按扩展名定 Content-Type），nova 原生词级时间戳；显式超时 + 有限重试；取消区分「取消 vs 超时」
- [x] 14.4 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[deepgram]` 注册
- [x] 14.5 单测：deepgramUtils 全量（base url / listen query / 词映射 / 结果提取）；`test:engines` 276 过

## 15. 连通性自测统一走主进程（修 CORS）

- [x] 15.1 新建 `main/service/asr/testConnection.ts`：按类型选轻量鉴权端点（OpenAI/ElevenLabs → GET /models；Deepgram → GET /projects），返回 `{ok,status?,needsConfig?}`
- [x] 15.2 `ipcStoreHandlers.ts`：新增 `testAsrProvider` IPC（对齐 `testTranslation`，规避渲染进程 `webSecurity:true` 下的 CORS）
- [x] 15.3 `CloudAsrPanel`：「测试连接」改走 `ipc.invoke('testAsrProvider')`，移除渲染端 axios/normalizeBaseUrl（同时修好 OpenAI/ElevenLabs 测试按钮）
