> 实现顺序：先 spike 实测定案（探针可行性、orderResult 真实形态），再纯函数（签名/解析/分类/映射，可单测），然后 service（建单+轮询）与探测接线，最后 i18n / 文档 / 回归。
> 非破坏红线：既有六类型行为、任务页下拉、`store.asrProviders` 结构、成句管线与 `cloudAsrEngine` 一律不动（audioLimits 走既有 `resolveAudioLimits` 声明，引擎零代码预期）。

## 1. Spike 实测（需用户提供讯飞 appId + secretKey）

- [ ] 1.1 零消耗探针验证：getResult 携假 orderId——确认签名有效时报 26602、签名错误时报 26600/26601（校验顺序决定 D8 主/备方案）
- [ ] 1.2 真实音频全链路：中文样本 upload（fileStream 直传）→ 轮询 getResult → 拿到 orderResult，确认 lattice/json_1best 双层字符串形态、bg/ed 字符串毫秒、wb/we 帧值、wp 的 n/p/s/g 实际分布，回填 design「Spike 实测记录」
- [ ] 1.3 边界形态：1s 静音 WAV（预期 failType 6 或 26606）；英文样本（词级 wb/we 是否齐备）；观察 taskEstimateTime 量级与实际完成时间的比值（校准 D4 轮询参数）

## 2. 类型定义（纯数据）

- [ ] 2.1 `types/asrProvider.ts`：新增 `ASR_XFYUN = 'xfyun'` 与类型定义——品牌型硬单例（不设 multiInstance）；字段 `appId`（text 必填）、`secretKey`（password 必填）、`models`（select 固定 `['lfasr']` 默认 `lfasr` 只读展示）、`requestTimeoutSec`/`concurrency`（默认 2，异步订单+频控保守）/`requestInterval` 同既有语义；无 `apiUrl`；`isBuiltin: true`、`iconImg: '/images/providers/xfyun.svg'`（补图标资源）
- [ ] 2.2 声明 `audioLimits: { maxUploadBytes: 400MB, maxChunkSeconds: 16200 }`——注释写明「500MB/5h 官方上限留余量；异步订单制切片会放大排队轮询，故宽松声明让绝大多数音频整文件直传（时间戳全局零拼接）」

## 3. 讯飞 service 实现

- [ ] 3.1 `main/service/asr/xfyunUtils.ts`（纯函数，无网络/fs）：`XFYUN_RAASR_HOST` 常量、`buildXfyunSigna(appId, secretKey, ts)`（MD5 hex → HmacSHA1 → base64）、`buildXfyunUploadQuery(...)`/`buildXfyunResultQuery(...)`（值一律 encodeURIComponent，signa 含 +/= 必须编码）、`mapXfyunLanguage(sourceLanguage)`（D6 映射表：zh→cn+languageType=1、yue→cn_cantonese+eng_rlang=0、auto/未匹配→cn+1）、`pollDelaysForEstimate(estimateMs)`（D4 梯度序列纯函数）、`extractXfyunResult(orderResultStr)`（双层 parse 宽容对象形态、坏句跳过；wp 分流 p 并前词/g 跳过/n·s 收词；词绝对毫秒=bg+wb×10→秒；句级 AsrSegment；多 lattice 按 bg 排序）、`classifyXfyunStatus(code, failType?, httpStatus?)`（D7 全档：success/empty/processing/retriable/fatal 细分凭据·配额·语种·素材）
- [ ] 3.2 `main/service/asr/xfyun.ts`：`transcribeWithXfyun(provider, input)`——读文件 Buffer + 真实 fileSize/fileName/duration → upload 建单（octet-stream）→ 按 `pollDelaysForEstimate` 梯度轮询（abortable sleep，signal 贯穿 fetch；26603 双倍退避；整单上限 `max(estimate×5, 10min)` 封顶 30min）→ 终态分派（4 解析 / -1 按 failType / 空成功返回空结果）→ `{ text, segments, words, hasWordTimestamps }`
- [ ] 3.3 `main/service/asr/index.ts`：`ASR_TRANSCRIBER_MAP[ASR_XFYUN] = transcribeWithXfyun`
- [ ] 3.4 `main/service/asr/testConnection.ts`：xfyun 分支——appId/secretKey 守卫；按 spike 定案走假 orderId 零消耗探针（26602→ok、26600/26601→凭据错误可行动提示）或静音建单回退；26625/26633 透出时长不足购买指引

## 4. 引擎接线确认（零代码预期）

- [ ] 4.1 确认 `cloudAsrEngine` 零改动：`resolveAudioLimits` 取宽松声明后整文件直传；`sourceLanguage` 已随 input 传入（腾讯同路径）
- [ ] 4.2 确认成句管线零改动：词级走 `wordCuesFromResult`（标点已并入词文本，realign 幂等）；小语种无词级自动段级降级

## 5. i18n 与呈现

- [ ] 5.1 `renderer/public/locales/{zh,en}/resources.json`：xfyun 字段 label/tips/placeholder（appId/secretKey 控制台获取入口；语种由任务原语言自动映射、多语种建议显式选择、小语种需控制台开通；新用户最多 50h 免费时长；异步转写忙时需排队等待的预期管理）；`engines.cloud.subtitle`/`tags`/`cloudAsr.intro` 增补讯飞
- [ ] 5.2 `npm run check:i18n` 通过（zh/en 键对齐）

## 6. 测试与回归

- [ ] 6.1 `scripts/test-engine-units.ts` 新增断言：xfyun 类型为品牌单例且 models 固定 `['lfasr']`、无 apiUrl；`resolveAudioLimits` 取 400MB/16200s；`buildXfyunSigna` 固定向量（官方文档样例 appid=595f23df ts=1512041814 secretkey=d9f4… → IrrzsJeOFk1NGfJHW6SkHUoN9CU=）；upload/result query 构造（signa URL 编码）；`mapXfyunLanguage` 全表 + auto 回落；`pollDelaysForEstimate` 梯度；`extractXfyunResult`（官方样例双层字符串、对象宽容、wp 分流、帧换算 bg+wb×10、坏句跳过）；`classifyXfyunStatus` 各档（000000+4、failType6、26605/26603/26601/26607/26625/26633/未知码/HTTP 5xx）
- [ ] 6.2 `npm run test:engines` 全过；ReadLints 改动文件零告警
- [ ] 6.3 手测（应用内，真实凭据）：连接自测通过（错 secretKey 报凭据错误）→ 中文视频转写出带标点多条字幕（对比轮询日志确认梯度间隔）→ 原语言选英文/日语映射生效 → 长视频整文件直传不切片 → 转写中取消即时中止 → 未配置 xfyun 时既有六家与本地引擎行为不变

## 7. 文档

- [ ] 7.1 README（zh/en）「云端听写」小节增补讯飞录音文件转写（凭据获取入口、50h 免费礼包、异步排队说明、语种映射与小语种开通）；Changelog 增补
