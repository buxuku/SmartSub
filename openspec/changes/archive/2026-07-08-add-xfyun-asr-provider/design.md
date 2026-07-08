# Design: 讯飞录音文件转写（LFASR raasr v2）接入

## Context

云端听写现有六家均为「单次 HTTP 调用同步返回」：openaiCompatible/elevenlabs/deepgram 为 multipart 上传即答，volcengine 为 base64 JSON 即答，tencent/aliyun 为闪电版/极速版同步接口。讯飞 LFASR 是**异步订单制**：`POST /v2/api/upload`（文件流直传，query 带签名与元数据）建单返回 `orderId` + `taskEstimateTime`，随后 `POST /v2/api/getResult` 轮询至终态（音频时长 X<10min 参考返回 <3min；结果完成后保留 72h；单订单查询上限 100 次、接口有频控）。

凭据与签名是六家中最简的：`appId` + `secretKey`，`signa = base64(HmacSHA1(MD5(appId + ts), secretKey))`，无需临时 token（对比阿里两段取号）、无需 canonical request（对比腾讯 TC3）。

词级时间戳形态独特：`orderResult` 是**双层 JSON 字符串**（`content.orderResult` 需 parse，其内 `lattice[].json_1best` 又是字符串需再 parse），句对象 `st` 含 `bg/ed`（字符串毫秒），词 `ws[].wb/we` 为**相对句首 bg 的 10ms 帧数**，`cw[0].w` 为词文本、`wp` 属性 `n`(词)/`p`(标点)/`s`(顺滑)/`g`(分段)。

上限 500MB / 5 小时远超既有各家（豆包 base64 100MB、腾讯 5MB/2min、阿里 100MB/2h 但引擎侧 24MB），单文件直传可覆盖绝大多数字幕场景。

## Goals / Non-Goals

**Goals:**

- `xfyun` 品牌型硬单例服务商：appId/secretKey 配置、连接自测、任务转写全链路。
- `AsrTranscriber` 内部支持「建单 → 梯度轮询 → 终态」生命周期，取消信号在轮询间隙即时生效；对 `cloudAsrEngine` 保持既有 `transcribe(provider, input)` 契约零改动。
- 词级时间戳换算（bg + wb×10ms）与 `wp` 分流，喂给既有 `wordCuesFromResult` 成句管线。
- 识别语种由任务原语言映射（同腾讯模式），小语种未授权给可行动提示。
- 大文件不切片：声明宽松 `audioLimits`，整文件直传保全局时间戳。

**Non-Goals:**

- 不接讯飞「录音文件转写大模型」（202 方言/37 语种，独立产品与计费）——列为 Open Question，可作后续 `models` 第二档。
- 不做角色分离（roleType）、翻译（transLanguage）、质检等增值参数。
- 不做 callbackUrl 回调（桌面应用无公网可回调地址，轮询即可）。
- 不改动既有六家与本地引擎行为。

## Decisions

### D1：品牌型硬单例，凭据 appId + secretKey，models 固定 `['lfasr']`

同豆包/腾讯/阿里的形态：`multiInstance` 不设，配置入口为「配置」而非「添加实例」。`models` 固定单值 `lfasr`（标准版），UI 只读展示；若后续接大模型版，扩为第二档即可（形态同腾讯 standard/large 双档）。无 `apiUrl` 字段（`raasr.xfyun.cn` 模块内常量；讯飞明确要求域名调用、IP 不固定）。

**Alternatives：** 协议型多实例——讯飞凭据是账号级、无区域/项目维度差异，多实例无意义，否决。

### D2：signa 纯函数 + 每请求即时签名（无 token 缓存）

`buildXfyunSigna(appId, secretKey, ts)`：`MD5(appId + ts)` 十六进制小写 → `HmacSHA1(md5Hex, secretKey)` → base64。`ts` 为秒级 Unix 时间戳，**每次请求现算**（签名与请求一次一签，无过期/缓存问题——对比阿里 token 36h 缓存整个机制都省掉）。upload 与 getResult 共用同一签名函数，仅 query 参数集不同：`buildXfyunUploadQuery({appId, ts, signa, fileName, fileSize, duration, language, languageType?})` 与 `buildXfyunResultQuery({appId, ts, signa, orderId})`，参数值一律 `encodeURIComponent`（signa 含 `+/=` 必须编码）。

**Alternatives：** 无——官方仅此一种鉴权。

### D3：upload 文件流直传（octet-stream body），元数据全在 query

`POST https://raasr.xfyun.cn/v2/api/upload?{query}`，header `Content-Type: application/octet-stream`，body 为音频原始字节（`audioMode=fileStream` 默认，不传 `audioUrl`）。`fileName` 带真实后缀（服务端据此转码）；`fileSize` 传真实字节数（服务端校验，不符建单失败）；`duration` 文档注明「当前未验证，可随机传」，仍传引擎已知的真实时长（毫秒转秒）以防后续启用校验。成功取 `content.orderId` 与 `content.taskEstimateTime`（毫秒）。

**Alternatives：** urlLink 模式——需公网 URL，违反本项目硬性标准，否决；旧版 `/api/prepare+upload` 分片协议——v2 已合并为单次流式上传，否决。

### D4：getResult 梯度轮询——首查延迟按 taskEstimateTime，退避防频控

轮询策略（`transcribeWithXfyun` 内实现，纯参数化便于测试）：

- **首查延迟** = `clamp(taskEstimateTime × 0.5, 3s, 30s)`（短音频快出结果，长音频不空转）；
- **后续间隔**梯度递增：5s → 8s → 13s → 21s，封顶 30s（单订单查询上限 100 次、接口有频控 26603，密轮询会伤及同 appId 其它订单）；
- `status: 3`（处理中）与错误码 `26605`（处理中，请稍后）→ 继续轮询；`26603`（频率受限）→ 当次视为轮询未命中、间隔额外 ×2 退避；
- **终态**：`status: 4` → 解析 orderResult；`status: -1` → 按 `failType` 分流（见 D7）；
- **整单等待上限** = `max(taskEstimateTime × 5, 10min)` 封顶 30min（SLA 承诺最大 5h 属极端排队，桌面任务等 5h 不现实；超限报「转写排队超时，请稍后重试或改用其它服务商」）；
- **取消**：外部 `AbortSignal` 在每次 sleep/fetch 处生效（sleep 用 abortable timer），取消后不再发请求（订单在服务端继续跑但本地任务即时中止——无取消订单 API）。

**Alternatives：** callbackUrl 回调——桌面应用无公网地址，否决；固定 5s 密轮询——触发 26603/26604 且伤并发订单，否决。

### D5：orderResult 双层解析 + wp 分流 + 10ms 帧换算（`extractXfyunResult`）

- `JSON.parse(content.orderResult)` → 取 `lattice`（顺滑结果；`lattice2` 仅开顺滑+口语规整才有，不依赖）；逐条 `JSON.parse(lattice[i].json_1best)`（字符串）——**宽容混合形态**：若已是对象（lattice2 形态）直接用，解析失败跳过该句（不失败整单）。
- 句级：`st.bg/ed`（字符串毫秒）→ `Number()` → 秒，作 `AsrSegment.start/end`；句文本 = 该句词文本按序拼接。
- 词级：遍历 `rt[].ws[]`，词文本取 `cw[0].w`；`wp` 分流——`'g'`（分段标记，w 常为空）跳过；`'p'`（标点）**并入前一词文本**（标点 wb==we 零时长、时间不可信，同阿里 punc 处理路径）；`'n'`/`'s'` 及未知属性按正常词收（顺滑词已是结果文本一部分）。
- 时间换算：词绝对毫秒 = `st.bg + wb × 10`（wb/we 相对句首、一帧 10ms，文档明示仅中英支持词级——其它语种 ws 缺失时词数组为空，引擎自动走段级降级）。
- 输出 `{ text, segments, words, hasWordTimestamps: words.length > 0 }`，喂 `wordCuesFromResult`；多声道音频多 lattice 条目按 bg 排序后拼接。

**Alternatives：** 依赖 lattice2（未顺滑原始结果）——需开通口语规整权限才返回，默认不可用，否决。

### D6：语种映射 `mapXfyunLanguage(sourceLanguage)`（同腾讯模式）

任务原语言 → `language` + 可选 `languageType`：`zh→cn`（`languageType=1` 自动中英）、`en→en`、`ja→ja`、`ko→ko`、`ru→ru`、`fr→fr`、`es→es`、`vi→vi`、`ar→ar`、`de→de`、`it→it`、`yue→cn_cantonese`（附 `eng_rlang=0` 输出简体，与全应用简体输出一致）；`auto` 与未匹配 → `cn + languageType=1`（讯飞无自动多语种检测，中英混合模式为最大公约数；README/tips 注明多语种请显式选择原语言）。小语种需控制台开通，未授权服务端报 `26607` → fatal 并提示「到讯飞控制台-语音转写-方言/语种处开通」。

**Alternatives：** 语种做成用户可配字段——任务已有原语言选择，二处配置必然漂移，否决（腾讯评审同结论）。

### D7：状态/错误分类 `classifyXfyunStatus(code, failType?)`

- **成功**：`code '000000'` 且 `status 4` 且 `failType 0`；
- **空成功**：`failType 6`（静音文件）、getResult `26606`（空音频）→ 返回空结果（探针与静音切片友好）；
- **处理中**：`status 0/3`、`26605` → 继续轮询；
- **retriable**：`26603`（频控，双倍退避）、`26640`（上传失败）、`26689`（引擎网络异常）、HTTP 429/5xx、网络错误 → 有限重试/退避；
- **fatal（凭据）**：`26600`（通用错误，多为签名/参数）、`26601`（非法应用信息）→ 提示核对 appId/secretKey；
- **fatal（配额）**：`26625/26633`（服务时长不足）→ 提示到产品页购买或领取免费时长；
- **fatal（语种）**：`26607` → 提示控制台开通对应语种；
- **fatal（素材）**：`26621/26631`（>500MB）、`26622/26632`（>5h）、`26643/26650`（音频损坏/加密）、`failType 2/3/4/5` → 携文档语义报错不重试；
- 未知码 → fatal 透传 code+descInfo。

### D8：连接自测——零消耗探针优先（spike 定案）

首选**假 orderId 探针**：`getResult` 携 `orderId=probe-<uuid>`——签名有效 → 服务端进入业务逻辑报 `26602`（任务 ID 不存在）即凭据 OK、零时长消耗；签名/appId 错 → `26600/26601` 报凭据错误。若 spike 实测发现 26602 之前不校验签名（顺序相反），回退**静音建单探针**：1s 静音 WAV 直传 upload，`000000` 建单成功即通过（消耗 1s 级时长，可接受），随后不轮询结果。两方案均复用 `buildSilentWavBase64` 与 D7 分类。

### D9：audioLimits 宽松声明——整文件直传不切片

声明 `maxUploadBytes: 400MB`（500M 上限留 20% 余量防转码膨胀）与 `maxChunkSeconds: 16200`（4.5h，5h 上限留余量）。效果：`prepareCloudAudio` 对绝大多数视频提取的音频**不再切片**——异步订单制下切片会线性放大「建单+排队+轮询」延迟与订单数，且整文件直传的词级时间戳天然全局、零拼接误差。留切片能力兜底超长素材（>4.5h 自动分段，回拼沿用既有 offset 机制）。

**Alternatives：** 沿用全局 600s 切片——一个 1h 视频拆 6 单、每单独立排队轮询，总时长与失败面双差，否决。

## Risks / Trade-offs

- **[异步排队高峰期等待不可控（SLA 最大 5h）]** → 整单等待上限 30min + 明确报错引导换服务商；`taskEstimateTime` 驱动首查延迟，忙时梯度退避不空转。
- **[72h 结果过期 / 查询上限 100 次]** → 转写完成即取结果、不留存 orderId；轮询预算（30min ÷ 最大间隔 30s ≈ 60 次）低于 100 次上限。
- **[双层 JSON 字符串解析脆弱]** → `extractXfyunResult` 逐句 try-parse、坏句跳过不失败整单；单测覆盖官方样例与畸形输入。
- **[词级仅中英支持]** → `ws` 缺失时词数组为空，`hasWordTimestamps=false` 自动走段级降级（既有引擎逻辑，零改动）；README 注明小语种为句级时间戳。
- **[取消无法撤销服务端订单]** → 本地即时中止、订单自然过期，无计费外损失（按音频时长计费在建单时已定）；文档不承诺服务端取消。
- **[同 appId 20 req/s 频控与多任务并发轮询叠加]** → 轮询间隔 ≥5s + 26603 双倍退避；provider `concurrency` 默认保守（2）。

## Open Questions

- 「录音文件转写大模型」（202 方言/37 语种）端点与参数与标准版差异——待有账号后 spike，若共用 raasr 协议可作 `models` 第二档（同腾讯 standard/large）。
- 假 orderId 探针的服务端校验顺序（签名先于订单存在性？）——spike 首项验证。
- `eng_rlang=0`（粤语简体输出）实际效果——spike 粤语样本验证。

## Spike 实测记录

（待实测后回填：探针可行性、真实 orderResult 形态、taskEstimateTime 量级、频控行为、语种参数生效性。）
