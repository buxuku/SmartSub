> 实现顺序：先纯数据 + 纯函数（类型/POP 签名/解析，可单测），再 service（Token 缓存 + 转写）与探测接线，最后 i18n / 文档 / 回归；spike 实测随用户凭据与手测合并执行（豆包/腾讯同款流程）。
> 非破坏红线：既有五类型（openaiCompatible / elevenlabs / deepgram / volcengine / tencent）行为、任务页下拉、`store.asrProviders` 结构、成句管线与 `cloudAsrEngine` 一律不动（audioLimits 走既有 `resolveAudioLimits` 声明，零引擎代码）。

## 1. Spike 实测（2026-07-02 已全部完成，详见 design「Spike 实测记录」）

> 首轮（未开通商用）：CreateToken POP 签名 ✅（Token 32 位 hex、ExpireTime ≈36h）；FlashRecognizer 报 `40000010 FREE_TRIAL_EXPIRED`（先于 appkey 校验）；nls-meta POP 无项目管理 API，appkey 仅控制台创建。
> 商用版开通 + 真实 appkey（用户控制台创建）后：全链路通。

- [x] 1.1 以真实凭据走通两段链路：CreateToken → FlashRecognizer ✅ 中文样本（20000000，句级数字毫秒/词级**字符串**毫秒，中文 punc 全角无空格）+ 英文样本（词 text 与 punc **均可能带尾空格**，需 trim——已回写 D4）——`extractAliyunResult` 解析口径定案
- [x] 1.2 边界形态实测 ✅ 静音 1s WAV → `40270002 "vad silent"`（HTTP 400，探测判通过/任务判空成功）；假 appkey（已开通账号）→ `40020105 APPKEY_NOT_EXIST`；未开通商用 → `40000010`（先于 appkey 校验）——testConnection 文案依据齐备

## 2. 类型定义（纯数据）

- [x] 2.1 `types/asrProvider.ts`：新增 `ASR_ALIYUN = 'aliyun'` 与类型定义——**品牌型硬单例**（不设 multiInstance，同豆包/腾讯；语种绑定 appkey 项目、控制台切换，design D1 实施评审定案）；字段 `accessKeyId`（password 必填）、`accessKeySecret`（password 必填）、`appkey`（text 必填）、`models`（`type:'select'`，options 固定 `['flash']`、默认 `'flash'`，UI 只读展示同 volcengine bigmodel 形态）、`requestTimeoutSec`/`concurrency`/`requestInterval` 同既有语义；**无 `apiUrl` 字段**（识别与取号端点为模块内常量）；`isBuiltin: true`、icon `☁️`、`iconImg: '/images/providers/alibabacloud.svg'`
- [x] 2.2 声明 `audioLimits: { maxUploadBytes: 24 * 1024 * 1024 }`（不声明 maxChunkSeconds，回落全局 600s）——常量注释写明「100MB/2h 双上限，引擎仅按字节判定，32kbps mp3 下 24MB≈100min<2h 间接钳住时长」并与腾讯常量注释互引（design D5）

## 3. 阿里 service 实现

- [x] 3.1 `main/service/asr/aliyunUtils.ts`（纯函数，无网络/fs）：`ALIYUN_NLS_GATEWAY_HOST`/`ALIYUN_FLASH_PATH`/`ALIYUN_META_HOST` 常量、`percentEncodeRfc3986(s)`（encodeURIComponent 补转 `!'()*`）、`buildCreateTokenQuery(accessKeyId, nonce, timestampIso)`（9 公共参数字典序 + 逐 k/v percentEncode 拼接）、`signCreateToken(accessKeySecret, sortedQuery)`（`GET&%2F&`+percentEncode(query) → HMAC-SHA1(Secret+`&`) → base64）、`isTokenExpired(expireTimeSec, nowMs, marginSec=300)`（ExpireTime 秒级绝对时间戳、提前 5 分钟过期）、`buildFlashQuery({appkey, token, format})`（固定 `sample_rate=16000&enable_word_level_result=true&enable_inverse_text_normalization=false&first_channel_only=true`）、`extractAliyunResult(json)`（sentences→AsrSegment 秒；words 拍平→AsrWord：`word: text.trim() + punc.trim()` 拼接——实测英文 text/punc 均可能带尾空格、中文无，trim 幂等，`Number()` 宽容字符串毫秒→秒；text 按 `needsSpaceBefore` 句间拼接）、`classifyAliyunStatus(httpStatus, status)`（success(20000000) / empty-success(40270002) / auth(40000001、403) / retriable(40000004、40000005、50000000、50000001、52010001、HTTP 429/5xx) / fatal(40000003、40000009、40000010、40010001、40020105、40020106、40270001、40270003、未知码)）（design D2/D3/D4/D7）
- [x] 3.2 `main/service/asr/aliyun.ts`：模块级 Token 缓存 `Map<accessKeyId, {token, expireTime}>` + `getAliyunToken(provider)`（缓存命中直取；miss/过期 → HTTPS GET CreateToken（`crypto.randomUUID()` nonce、ISO8601 UTC timestamp）→ 解析 `Token.Id/ExpireTime` 入缓存；失败携 `Code/Message` 报错）；`transcribeWithAliyun(provider, input)`——取 Token → 读文件 Buffer 直传 `POST https://nls-gateway…/stream/v1/FlashRecognizer?{query}`（`Content-Type: application/octet-stream`）；按 `classifyAliyunStatus` 分派：empty-success→空结果成功、auth→清缓存强刷 Token 原地重试一次（不计入退避次数）仍失败终态、retriable→指数退避有限重试、fatal→携 message 不重试；显式超时合并外部 signal（结构对齐 `tencent.ts` 的 postFlashOnce）；返回 `{ text, segments, words, hasWordTimestamps }`（design D2/D7）
- [x] 3.3 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[ASR_ALIYUN] = transcribeWithAliyun`
- [x] 3.4 `main/service/asr/testConnection.ts`：新增 aliyun 分支——**自身三字段守卫**（accessKeyId/accessKeySecret/appkey 任缺 → needsConfig，不走通用 apiKey 守卫）；两段探测：CreateToken 失败→「AccessKey 无效/签名错误」透出 Code/Message；1s 静音 WAV 原始字节（`Buffer.from(buildSilentWavBase64(), 'base64')`）POST FlashRecognizer：`20000000` 与 `40270002` 均→ok、`40020105/40020106`→appkey 不存在/不匹配可行动提示、`40000010`→需开通商用版（无免费试用）/欠费提示、`403/40000001`→强刷一次仍失败才报 Token 异常、其余→透出 status+message（design D6）

## 4. 引擎接线确认（零代码预期）

- [x] 4.1 确认 `cloudAsrEngine` 零改动：`resolveAudioLimits` 自动取 aliyun 声明（24MB/600s）；`prepareCloudAudio` 产物（wav/mp3）经 format 参数映射
- [x] 4.2 确认 `audioProcessor.ts` / 成句管线（`wordCuesFromResult`、段级降级）零改动——阿里词条目 punc 拼接后 `realignPunctuation` 幂等无害（design D4）

## 5. i18n 与呈现

- [x] 5.1 `renderer/public/locales/{zh,en}/resources.json`：aliyun 字段 label/tips/placeholder（accessKeyId/accessKeySecret——RAM 密钥获取入口与授权提示；appkey——NLS 控制台项目 Appkey、**识别语种在项目功能配置中设定、默认普通话模型可识别中英混合、其它语种去控制台改项目模型**；models tips——固定 flash、语种由 appkey 项目决定、任务原语言不影响该服务商；**显著注明极速版仅商用版无免费试用、开通即按时长计费**）；`engines.cloud.subtitle` 与 `tags` 增补「阿里云」（`OpenAI 兼容 · ElevenLabs · Deepgram · 豆包 · 腾讯云 · 阿里云`）；`cloudAsr.intro` 点名
- [x] 5.2 确认 `CloudAsrPanel` / `EngineIcon` / 任务页下拉零代码改动（品牌型单例「配置」入口、固定模型只读、实例分组均数据驱动）
- [x] 5.3 `npm run check:i18n` 通过（zh/en 键对齐）

## 6. 测试与回归

- [x] 6.1 `scripts/test-engine-units.ts` 新增断言：`groupInstancesByType` 含 aliyun 空分区且为品牌型单例（`multiInstance` falsy）；`isAsrProviderConfigured`（三字段任缺未就绪、齐备就绪）；`percentEncodeRfc3986`（空格→%20、`*`→%2A、`~` 不转、`!'()` 转）；`buildCreateTokenQuery`（字典序、9 参数齐备）；`signCreateToken`（固定输入的 HMAC-SHA1-base64 向量，实现时独立预计算）；`isTokenExpired`（未过期/余量内/已过期）；`buildFlashQuery`（固定参数集）；`extractAliyunResult`（官方样例：字符串毫秒→秒、punc 拼接进词文本、sentences→segments、多句 text 拼接）；`classifyAliyunStatus` 各档（20000000/40270002/40000001/403/40000005/50000000/40000010/40020106/未知码/HTTP 5xx）；aliyun models options 为 `['flash']` 且默认 `flash`
- [x] 6.2 `npm run test:engines` 全过；`ReadLints` 改动文件零告警；renderer/main tsc 零新错误
- [x] 6.3 手测（应用内，用户 2026-07-02 确认 OK）：真实凭据连接自测通过；中文音频（`ASR ZH Longgap.wav`）应用内转写出 20 条带标点字幕，与直调 API 词级结果对比**文字逐字一致**（应用仅重做断句/时间轴，词级时间戳来自真实 API 值）；长静音（2.5~5.6s×5 处）两侧 cue 均贴真实语音边界
  > 预验证（2026-07-02，生产代码路径 + 真实凭据直跑）：`buildCreateTokenQuery/signCreateToken` → CreateToken 200 ✅；`buildFlashQuery` + 中文样本 → `extractAliyunResult` 出「北京的天气。」词级 3 条（punc 已拼接）✅；英文样本 17 词、尾空格已 trim、多句以空格拼接 ✅；静音 1s → `40270002` 分类 empty ✅
  > 衍生改进：直调对比发现的「孤立句尾词」硬切残例已在 `builtin-subtitle-timeline-0fork` D16（硬切回溯到最近可断标点）解决，云端六家与本地引擎共同受益

## 7. 文档

- [x] 7.1 README（zh/en）「云端听写」小节增补阿里云录音识别极速版（凭据获取入口：RAM AccessKey + NLS 控制台创建项目取 Appkey；**显著注明仅商用版、无免费试用、开通即按时长计费**；语种绑定项目、换语种在控制台改项目模型）；Changelog（v3.2.0 release note 云端听写条目）增补阿里云
