> 实现顺序：先纯数据 + 纯函数（类型/签名/解析，可单测），再 service 与探测接线，最后 i18n / 文档 / 回归；spike 实测随用户凭据与手测合并执行（豆包同款流程）。
> 非破坏红线：既有四类型（openaiCompatible / elevenlabs / deepgram / volcengine）行为、任务页下拉、`store.asrProviders` 结构、成句管线与 `cloudAsrEngine` 一律不动（audioLimits 走既有 `resolveAudioLimits` 声明，零引擎代码）。

## 1. Spike 实测（随用户凭据执行，可与 6.3 手测合并）

- [x] 1.1 以真实凭据 POST `flash/v1`（中/英样本、word_info=1）：确认 `word_list[]` 词条目形态（英文分词/空格前缀）、`sentence_list` 时间戳、整段 text 标点——校准 `extractTencentResult` 与回贴效果 ✅ 用户以真实凭据验证转写 OK（2026-07-02）
- [x] 1.2 实测静音 1s WAV 的返回（预期 `code 0` 空文本；若有静音专属码并入 `classifyTencentCode`）与假 SecretKey 的 4002 形态（testConnection 文案依据）✅ 随用户手测通过

## 2. 类型定义（纯数据）

- [x] 2.1 `types/asrProvider.ts`：新增 `ASR_TENCENT = 'tencent'` 与品牌型类型定义——字段 `appid`（text 必填）、`secretId`（password 必填）、`secretKey`（password 必填）、`models`（`type:'select'`，options 为计费档位 `['standard','large']`、默认 `'standard'`；识别语言跟随任务原语言映射 engine_type——实施中按用户反馈由 20 个 engine_type 全枚举修订为档位化，design D3 修订版）、`requestTimeoutSec`/`concurrency`/`requestInterval` 同既有语义；**无 `apiUrl` 字段**（签名绑定 Host，design D1）；`isBuiltin: true`、`multiInstance` 留空、icon `🐧`、`iconImg: '/images/providers/tencentcloud-color.svg'`
- [x] 2.2 声明 `audioLimits: { maxUploadBytes: 24 * 1024 * 1024 }`（不声明 maxChunkSeconds，回落全局 600s）——常量注释写明「100MB/2h 双上限，引擎仅按字节判定，32kbps mp3 下 24MB≈100min<2h 间接钳住时长」（design D5）

## 3. 腾讯 service 实现

- [x] 3.1 `main/service/asr/tencentUtils.ts`（纯函数，无网络/fs）：`TENCENT_ASR_HOST`/`TENCENT_FLASH_PATH` 常量、`buildTencentQuery(params)`（字典序排序拼接；参数集固定 URL 安全值：secretid/engine*type/voice_format/timestamp/word_info=1/filter_punc=0/convert_num_mode=1/first_channel_only=1/speaker_diarization=0，另抽 `buildTencentParams` 单一来源供 transcriber 与 testConnection 共用）、`resolveTencentEngineType(model, language)`（档位 + 原语言 → engine_type 映射：standard 单语种 1:1、large 中英粤→16k_zh_en 其余→16k_multi_lang、auto→16k_zh-PY/16k_zh_en、原始 `16k*_`/`8k\__` 透传、不支持语言返回 null）、`signTencentRequest(secretKey, appid, sortedQuery)`（`POST`+host+path+appid+`?`+query → HMAC-SHA1 → base64）、`voiceFormatFromPath(path)`（.wav→wav、.mp3→mp3）、`extractTencentResult(json)`（取 flash_result[0]：text 整段、sentence_list→AsrSegment 秒、word_list 拍平→AsrWord 秒）、`classifyTencentCode(httpStatus, code)`（success(0) / auth(4002) / retriable(4006、4008、4009、5001-5003、HTTP 429/5xx) / fatal(4001、4003-4005、4007、4010-4012、未知码)）
- [x] 3.2 `main/service/asr/tencent.ts`：`transcribeWithTencent(provider, input)`——读文件 Buffer 直传 `POST https://asr.cloud.tencent.com/asr/flash/v1/{appid}?{query}`（`Content-Type: application/octet-stream`、`Authorization` 裸签名）；**每次尝试重取 timestamp 重签**（design D2）；`engine_type` = `resolveTencentEngineType(input.model, input.language)`（映射为 null 时上传前明确报错——继续上传只会产出乱码还照常计费）；显式超时合并外部 signal（结构对齐 `volcengine.ts` 的 `postFlashOnce`）；按 `classifyTencentCode` 分派：空文本→空结果成功、fatal 携 `message` 不重试、retriable 指数退避有限重试；返回 `{ text, segments, words, hasWordTimestamps }`
- [x] 3.3 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[ASR_TENCENT] = transcribeWithTencent`
- [x] 3.4 `main/service/asr/testConnection.ts`：新增 tencent 分支——**自身三字段守卫**（appid/secretId/secretKey 任缺 → needsConfig，不走通用 apiKey 守卫，design D1 注意项）；1s 静音 WAV 原始字节（`Buffer.from(buildSilentWavBase64(), 'base64')`）+ 首个已启用档位按 zh 映射 engine_type 真实探测（standard→16k_zh、large→16k_zh_en）；`code 0`→ok、`4002`→鉴权失败、`4003/4004/4005`→开通/额度/欠费可行动提示、其余→透出 code+message（design D6）

## 4. 引擎接线确认（零代码预期）

- [x] 4.1 确认 `cloudAsrEngine` 零改动：`resolveAudioLimits` 自动取 tencent 声明（24MB/600s）；`prepareCloudAudio` 产物（wav/mp3）经 `voiceFormatFromPath` 映射 `voice_format`
- [x] 4.2 确认 `audioProcessor.ts` / 成句管线（`realignPunctuation`、`wordCuesFromResult`、段级降级）零改动——腾讯词无标点 + 整段带标点与豆包路径同构

## 5. i18n 与呈现

- [x] 5.1 `renderer/public/locales/{zh,en}/resources.json`：tencent 字段 label/tips/placeholder（appid/secretId/secretKey——注明语音识别控制台「API 密钥管理」获取、需先开通服务、每月 5 小时免费；models tips——识别语言跟随任务原语言、standard/large 档位语义与计费并发差异、auto 按中英粤混合处理；时间偏差 >3 分钟报签名失败的校时提示进 secretKey tips）；`engines.cloud.subtitle` 与 `tags` 增补「腾讯」（`OpenAI 兼容 · ElevenLabs · Deepgram · 豆包 · 腾讯云`）；`cloudAsr.intro` 点名
- [x] 5.2 确认 `CloudAsrPanel` / `EngineIcon` / 任务页下拉零代码改动（分区、models 枚举点选、实例分组均数据驱动）
- [x] 5.3 `npm run check:i18n` 通过（zh/en 键对齐）

## 6. 测试与回归

- [x] 6.1 `scripts/test-engine-units.ts` 新增断言：`groupInstancesByType` 含 tencent 空分区；`isAsrProviderConfigured`（三字段任缺未就绪、齐备就绪）；`buildTencentQuery`（字典序、无编码歧义）；`resolveTencentEngineType`（standard/large × zh/en/ja/yue/zh-Hant、auto 回落、空档位回落 standard、原始 engine_type 透传、不支持语言返回 null）；`signTencentRequest`（固定输入的 HMAC-SHA1-base64 向量，实现时独立预计算）；`voiceFormatFromPath`；`extractTencentResult`（文档样例：毫秒→秒、words 拍平、text 带标点）；`classifyTencentCode` 各档（0/4002/4003/4006/5001/未知码/HTTP 5xx）；tencent models options 为 `['standard','large']` 且默认 `standard`
- [x] 6.2 `npm run test:engines` 全过（384 passed）；`ReadLints` 改动文件零告警；renderer/main tsc 零新错误（asr 相关文件无错误；仓库既有 parameterProcessor/proxyManager/docs 错误与本变更无关）
- [x] 6.3 手测：配置真实凭据→连接自测通过（假 SecretKey 报 4002、未开通报 4003 可行动提示）→中文视频（原语言 zh + standard 档）转写出带标点多条字幕（engine_type=16k_zh）→超 24MB 长视频走压缩/切片回拼→取消任务即时中止→未配置 tencent 时既有四家与本地引擎行为不变 ✅ 用户确认「腾讯验证OK」（2026-07-02）

## 7. 文档

- [x] 7.1 README（zh/en）「云端听写」小节增补腾讯云录音识别极速版（凭据获取入口：语音识别控制台 API 密钥管理；注明每月 5 小时免费额度、大模型版引擎计费差异、按时长计费与隐私上云提示）；Changelog（v3.2.0 release note 云端听写条目）增补豆包与腾讯云
