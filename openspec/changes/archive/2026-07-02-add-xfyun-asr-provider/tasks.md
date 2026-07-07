# Tasks: add-xfyun-asr-provider

## 1. 类型与常量注册

- [x] 1.1 `types/asrProvider.ts`：新增 `ASR_XFYUN` 常量、`XFYUN_MAX_UPLOAD_BYTES = 48MB`（含 5h 钳制理由注释）、`XFYUN_LANGUAGE_TIERS = ['autodialect', 'autominor']`
- [x] 1.2 `types/asrProvider.ts`：在 `ASR_PROVIDER_TYPES` 追加讯飞类型定义（品牌型硬单例；fields：appid/apiKey/apiSecret/models(select)/requestTimeoutSec(默认300)/concurrency/requestInterval；audioLimits 仅声明 maxUploadBytes；iconImg 复用 `spark-color.svg`）

## 2. service 纯工具（xfyunUtils）

- [x] 2.1 新建 `main/service/asr/xfyunUtils.ts`：`XFYUN_API_HOST` 常量、`buildXfyunDateTime()`（本地时区 ±HHmm 格式）、`buildXfyunRandom()`（16 位字母数字）、`javaUrlEncode()`（空格→+，转义 !'()~）
- [x] 2.2 `buildXfyunQuery(params)`（过滤空值 + ASCII 排序 + javaUrlEncode，排序串即最终查询串）与 `signXfyunRequest(apiSecret, query)`（HmacSHA1 → Base64）
- [x] 2.3 `resolveXfyunLanguageSupport(model, language)` 语种守卫纯函数（autodialect: auto/zh/zh-hant/yue/en；autominor: auto + 37 语种 ISO-639-1 映射表），返回 `ok | switch-tier | unsupported` 三态供差异化报错（实现为双向 switch-tier：ja 在 autodialect 提示切 autominor，yue 在 autominor 提示切回 autodialect）
- [x] 2.4 `classifyXfyunCode(httpStatus, code)`（success/auth/retriable/fatal）与 `mapXfyunFailType(failType)` 可行动文案映射（6=静音 → 空结果语义）
- [x] 2.5 `extractXfyunResult(orderResult)`：lattice 解析（json_1best 字符串/对象双态兼容、wp=n 词级换算 `(bg+wb×10)/1000`、wp=p 标点内联前词、wp=s/g 跳过、逐元素防御），返回 `{ text, words, segments }`（拉丁词间自动补空格）

## 3. service 转写实现（xfyun）

- [x] 3.1 新建 `main/service/asr/xfyun.ts`：`transcribeWithXfyun` 骨架——凭据守卫、语种守卫（2.3，差异化报错）、文件存在校验；沿用现有 `sleep(ms, signal)` / 单请求超时合并取消的模式
- [x] 3.2 upload 实现：octet-stream 直传、`durationCheckDisable=true` 免 duration、fileName 用 `audio.<ext>` 净化名、每次尝试重取 dateTime 重签、指数退避有限重试（复用 DEFAULT_MAX_RETRIES 模式）
- [x] 3.3 轮询实现：首查延迟 `min(taskEstimateTime/2, 30s)`（缺省 5s）、梯度间隔（5s×6 → 10s×12 → 45s×…）、双重上限（≤96 次且 ≤62min）、单次失败连续 5 次判死、每次查询重签且复用 upload 的 signatureRandom、AbortSignal 全程透传
- [x] 3.4 结果组装：status=4 → extractXfyunResult → `AsrTranscribeResult`（hasWordTimestamps 按 words 非空）；failType=6 静音 → 空结果成功；status=-1/其他 failType → mapXfyunFailType 报错
- [x] 3.5 跨会话订单续查（design D10）：`xfyunPendingOrders` 持久化读写（storeManager）——入口算压缩音频 sha1 查表（键 = hash+实例id+档位，72h 有效，读表惰性清理过期），命中跳过 upload 直接轮询并复用持久化 signatureRandom；upload 成功落表；订单确定性完结（失败态/业务性失败）删记录；取消/轮询超时/网络连败/鉴权失败保留记录；续查遇 100001/100037/100039 清记录回落新 upload
- [x] 3.6 `main/service/asr/index.ts`：注册 `[ASR_XFYUN]: transcribeWithXfyun` 分发

## 4. 连通性自测

- [x] 4.1 `main/service/asr/testConnection.ts`：新增 `testXfyunConnection`（假 orderId + 完整签名 getResult 探针；100037→ok；100009/000002/100008/100007 → XFYUN_CODE_HINTS 可行动提示），在 `testAsrConnection` 顶部按类型分派（多字段凭据，不走通用 apiKey 守卫）

## 5. i18n 文案

- [x] 5.1 `renderer/public/locales/zh/resources.json`：新增 asrXfyunAppidTips / asrXfyunApiKeyTips / asrXfyunApiSecretTips（含控制台获取路径与 accessKeyId/Secret 映射说明）、asrModelsXfyunTips（两档语种覆盖 + autominor 人工对接开通提示 + 异步订单/断点续查说明）、placeholder 三则
- [x] 5.2 `renderer/public/locales/en/resources.json`：对应英文文案
- [x] 5.3 运行 `npm run check:i18n` 确认无缺失 ✓

## 6. 单测与验证

- [x] 6.1 `scripts/test-engine-units.ts`：xfyunUtils 单测——buildXfyunQuery 排序/编码（含空格、中文、保留字符）、signXfyunRequest 已知向量、resolveXfyunLanguageSupport 三态（zh/en/yue 放行、ja 在 autodialect 报 switch-tier、autominor 放行 ja、未知语种 unsupported）、classifyXfyunCode 分类、extractXfyunResult（字符串/对象双态、标点内联、顺滑词跳过、词级时间换算、异常元素跳过）
- [x] 6.2 `scripts/test-engine-units.ts`：类型注册单测——xfyun 单例/字段/默认档位/audioLimits 48MB/isAsrProviderConfigured 三凭据判定（对齐 tencent 用例形态）
- [x] 6.3 运行 `npm run test:engines` 全绿（516 passed, 0 failed）
- [x] 6.4 真机验证（API 层，2026-07-02）：用编译产物 xfyunUtils 直连真实接口——假 orderId 探针返回 100037（判定 ok ✓）；21s 中文音频 upload→poll→extract 全链路成功，48 词词级时间戳 + 标点内联 ✓；autodialect×ja 上传前报错文案由单测覆盖。用户 App 内真机验证通过（2026-07-02）
- [x] 6.5 真机验证续查：用户真机验证通过（2026-07-02）
