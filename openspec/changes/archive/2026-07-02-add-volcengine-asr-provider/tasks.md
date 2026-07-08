> 实现顺序：先 spike 实测（固化状态码/体积上限），再纯数据 + 纯函数（可单测），再 service 与引擎接线，最后 i18n / 文档 / 回归。
> 非破坏红线：既有三类型（openaiCompatible / elevenlabs / deepgram）行为、任务页下拉、`store.asrProviders` 结构、成句管线（`cloudAsrShared` / `subtitleSegmentation`）一律不动；`audioLimits` 为纯增量（未声明 = 全局常量，逐字节等价）。

## 1. Spike 实测（一次性，落地后删除）

- [x] 1.1 ~~`scripts/spike/asr-volcengine.mjs` 独立 spike~~ → 由用户以真实 API Key 端到端实测替代验证（2026-07-02）：转写链路与响应解析（`utterances[].words[]` 毫秒、无标点）work as implemented
- [x] 1.2 探测行为已实测校准：空体/缺 audio 的参数校验先于鉴权（曾致假 key「自测通过」），已改 1s 静音 WAV 真实探测（design D6 修订）；`maxUploadBytes` 16MB 初始值随用户实测通过

## 2. 类型与上传约束声明（地基，纯数据/纯函数）

- [x] 2.1 `types/asrProvider.ts`：新增 `ASR_VOLCENGINE = 'volcengine'` 与品牌型类型定义（字段：`apiKey` 必填 password——仅支持新版「豆包语音」控制台 API Key（用户决策裁剪旧版两件套）、`models` 必填默认 `bigmodel`、`apiUrl` 可选默认 `https://openspeech.bytedance.com`、`requestTimeoutSec`/`concurrency`/`requestInterval` 同既有语义；`isBuiltin: true`、`multiInstance` 留空、icon `🌋`、`iconImg` 复用 `/images/providers/volcengine-color.svg`）
- [x] 2.2 `AsrProviderType` 新增可选 `audioLimits?: { maxUploadBytes?: number; maxChunkSeconds?: number }`；`volcengine` 声明 `maxUploadBytes: 16 * 1024 * 1024`（另声明 `maxChunkSeconds: 480`——切片为未压缩 WAV，600s ≈18.4MB 会超 16MB）
- [x] 2.3 新增纯函数 `resolveAudioLimits(type, defaults)`：声明值 ?? 传入默认——默认值由调用方（cloudAsrEngine）注入全局常量，类型模块保持零 electron 依赖、无循环引用

## 3. 火山 service 实现

- [x] 3.1 `main/service/asr/volcengineUtils.ts`（纯函数，无网络/fs）：`normalizeVolcBaseURL`（空/非法回落官方端点、去误粘路径）、`buildVolcHeaders(apiKey, requestId)`（单 `X-Api-Key`；`X-Api-Resource-Id: volc.bigasr.auc_turbo`、`X-Api-Sequence: -1`）、`buildVolcRequestBody(base64, model)`（`show_utterances/enable_punc/enable_itn=true`、`enable_ddc=false`、固定 uid）、`buildSilentWavBase64`（连接自测最小合法音频）、`extractVolcResult(json)`（utterances→segments 秒级、words 拍平→AsrWord 秒级、text 整段）、`classifyVolcStatus(httpStatus, apiStatusCode)`（success / empty(20000003) / auth(HTTP 401/403) / retriable(55000031、550xxxxx、429/5xx) / fatal(45xxxxxx、其余)——以官方错误码表固化，spike 样本待 6.3 校验）
- [x] 3.2 `main/service/asr/volcengine.ts`：`transcribeWithVolcengine(provider, input)`——读文件→base64→POST `{base}/api/v3/auc/bigmodel/recognize/flash`（`X-Api-Request-Id` 每次 uuid）；显式超时合并外部 signal（结构对齐 `deepgram.ts` 的 `postListenOnce`）；按 `classifyVolcStatus` 分派：静音→空结果成功、fatal 不重试携 `X-Api-Message`、retriable 指数退避有限重试；返回 `{ text, segments, words, hasWordTimestamps }`
- [x] 3.3 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[ASR_VOLCENGINE] = transcribeWithVolcengine`
- [x] 3.4 `main/service/asr/testConnection.ts`：新增 volcengine 分支（最小探测：1s 静音 WAV base64 POST——实测参数校验先于鉴权，空体探测对假 key 也「通过」，故按 design 预案回退真实音频探测；成功/静音空结果判 ok，鉴权失败→`detail` 取 `X-Api-Message`；凭据走标准 `apiKey` 字段，复用通用 needsConfig 守卫）

## 4. 云引擎接线（audioLimits 生效）

- [x] 4.1 `main/helpers/engines/cloudAsrEngine.ts`：按所选实例类型 `resolveAudioLimits` 取生效值，替换硬引用——`prepareCloudAudio({ maxBytes })`、单请求判定阈值、切片路径 `chunkSeconds`（`COARSE_DEGRADE_CHUNK_SECONDS` 降级路径不变）
- [x] 4.2 确认 `audioProcessor.ts` 零改动（`prepareCloudAudio` 已接受 `opts.maxBytes`、`splitBySilence` 已接受 `chunkSeconds`，本次未触碰该文件）

## 5. i18n 与呈现

- [x] 5.1 `renderer/public/locales/{zh,en}/resources.json`：volcengine 字段 tips/placeholder（API Key——含「方舟 Key 不通用、需先开通极速版」提示 / 模型 / Base url）；`engines.cloud.subtitle` 与 `tags` 增补「豆包」（对齐 grouping 口径：`OpenAI 兼容 · ElevenLabs · Deepgram · 豆包`）；`cloudAsr.intro` 点名
- [x] 5.2 确认 `CloudAsrPanel` / `EngineIcon` / 任务页下拉零代码改动（`groupInstancesByType` 数据驱动自动出分区；分区图标走 `type.icon` 🌋；任务页下拉源自已配置实例列表；EngineIcon 只有合并组 `cloud` 图标，无需新映射）
- [x] 5.3 `npm run check:i18n` 通过（zh/en 键对齐）

## 6. 测试与回归

- [x] 6.1 `scripts/test-engine-units.ts` 新增断言：`groupInstancesByType` 含 volcengine 空分区；`isAsrProviderConfigured`（缺 apiKey 未就绪、有 apiKey 就绪）；`resolveAudioLimits`（声明值生效 / 未声明回落）；`volcengineUtils`（extract 样本毫秒→秒、words 拍平、`buildVolcHeaders` 单 Key 形态、`buildSilentWavBase64` WAV 结构、`classifyVolcStatus` 各档、baseURL 归一）
- [x] 6.2 `npm run test:engines` 通过（322 passed, 0 failed）；`ReadLints` 改动文件零告警
- [x] 6.3 手测通过（用户实测确认，2026-07-02）：真实 API Key 连接自测通过、转写出字幕；假 key/方舟 key 被 401 拦截（曾暴露自测误通过与选择状态被覆盖两问题，均已修复）
- [x] 6.4 删除一次性 spike 脚本 `scripts/spike/asr-volcengine.mjs`（未创建——1.1/1.2 因缺凭据顺延，无残留）

## 6.5 模型录入结构化（用户反馈追加，见 design D7）

- [x] 6.5.1 `types/asrProvider.ts`：品牌型 models 字段改枚举 `options`（elevenlabs `['scribe_v2','scribe_v1']` 默认 v2（v1 官方 2026-07 废弃）、deepgram `['nova-2','nova-3']`、volcengine `['bigmodel']`）；`parseAsrModels` 分隔符放宽（全角逗号/顿号/分号）
- [x] 6.5.2 `CloudAsrPanel` models 字段三形态渲染：单 option 只读、多 options 点选标签、无 options 标签式录入（回车/分隔符成标签、退格删末项、失焦提交）
- [x] 6.5.3 `testConnection` elevenlabs 探测默认模型 `scribe_v1`→`scribe_v2`；i18n（zh/en）models tips 与 `cloudAsr.modelsAddHint` 更新、删除废弃 placeholder 键
- [x] 6.5.4 单测：`parseAsrModels` 宽容分隔断言 + 三类型 options 形态断言（328 passed）

## 7. 文档

- [x] 7.1 README（zh/en）「云端听写」小节增补火山引擎豆包（凭据获取入口：火山控制台语音技术-应用管理；注明按时长计费与隐私上云提示）
