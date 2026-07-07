# Design: add-xfyun-asr-provider

## Context

云 ASR 体系现有 6 家服务商全部是「单请求同步返回」形态：service 层 `AsrTranscriber = (provider, input) => Promise<AsrTranscribeResult>`，云引擎适配器（`cloudAsrEngine.ts`）负责压缩/切片/并发/成句，service 只管一次 HTTP。讯飞「录音文件转写大模型」是**异步订单制**：`POST /v2/upload`（octet-stream 直传）拿 `orderId`，再轮询 `POST /v2/getResult` 直到 `status=4`。

已完成的最小连通性实测（2026-07-02，用户已开通服务）确认：

- 凭据映射：控制台 APPID→`appId`、APIKey→`accessKeyId`、APISecret→`accessKeySecret`；
- 签名：参数按名排序 + Java URLEncoder 风格编码拼 baseString → HmacSHA1(APISecret) → Base64，放 `signature` 请求头；
- 21s 中文音频（含英文单词）：upload 预估 28s，实际 5~10s 完成，转写一字不差、标点内联（`wp=p`）；
- 词级时间戳：`ws[].wb/we`（10ms 帧、相对句首 `st.bg`）齐全；`lattice` 与 `lattice2` 均返回；
- `durationCheckDisable=true` 可免传 `duration`（实测通过）；
- 错误码探明：假 orderId → `100037`（凭据有效）；错 APISecret → `100009`；错 APIKey → `000002`。

约束：`getResult` 官方限 ≤100 次/订单；接口频率有限制（`100012`）；已完成订单结果有 `expireTime`；`autominor`（37 语种档）需讯飞人工对接单独开通，个人账号默认仅 `autodialect`（中英+202 方言）。

## Goals / Non-Goals

**Goals:**

- 新增品牌型硬单例服务商「讯飞 录音文件转写大模型」，在既有 `AsrTranscriber` 合同下实现异步「上传→轮询→解析」，云引擎适配器零改动。
- `models` 承载「语种档位」（`autodialect` / `autominor`），语义对齐腾讯的档位模式；档位 × 任务原语言的上传前守卫。
- lattice 结果解析出句级 segments 与词级 words，喂现有词级成句管线。
- 连通性自测（不创建订单、不耗时长）与可行动的错误文案（含 autominor 未开通提示）。
- `test:engines` 覆盖纯函数（签名/参数/解析/守卫/错误分类）。

**Non-Goals:**

- 热词、角色分离（roleType/featureIds）、翻译/质检 resultType、语种识别 analysis；
- callbackUrl 回调（桌面应用无公网地址，只用轮询）；
- 讯飞标准版（raasr.xfyun.cn）与「极速录音转写大模型」（OST）接入；
- 轮询期间的进度插值上报（`AsrTranscriber` 合同无进度通道，本期不动合同）；
- 待恢复订单的 UI 呈现（续查对用户透明，仅日志可见）。

## Decisions

### D1 服务商类型：品牌型硬单例，models=语种档位

`ASR_XFYUN = 'xfyun'`，端点固定 `https://office-api-ist-dx.iflyaisol.com`（单一官方端点，不开放自定义 base URL）。fields：

- `appid`（text，必填）+ `apiKey`（password，必填）+ `apiSecret`（password，必填）——**UI 词汇跟控制台**（用户从「服务接口认证信息」面板复制的就是 APPID/APIKey/APISecret），tips 说明其映射到 API 的 accessKeyId/accessKeySecret；
- `models`（select，必填，默认 `autodialect`）：`['autodialect', 'autominor']`，tips 逐档说明支持语种与开通条件（autominor 需人工对接单独付费开通）；
- `requestTimeoutSec`（默认 **300**）：语义保持「单次 HTTP 超时」，上传大文件（几十 MB mp3）+ upload 接口处理耗时比同步各家更久，默认放宽；
- `concurrency`（默认 4）/ `requestInterval`（默认 0）：沿用通用字段（切片场景才生效）。

图标复用 `spark-color.svg`（讯飞星火已有翻译服务商图标，同品牌）。

替代方案：把 autodialect/autominor 做成两个服务商类型——否决，同一套凭据与接口，仅一个参数不同，档位即「模型选择」，与腾讯 standard/large 同构。

### D2 异步轮询：封装在 service 层，梯度间隔 + 双重上限

`transcribeWithXfyun` 内部完成完整生命周期，外部合同不变：

```
upload(octet-stream, 签名重签/重试)
  → orderId + taskEstimateTime
  → 首查延迟 min(taskEstimateTime/2, 30s)（缺失时 5s）
  → 轮询 getResult：间隔梯度 5s×6 → 10s×12 → 45s×…
      status=3 继续；status=4 解析返回；status=-1/failType≠0 报错
  → 双重上限：总查询 ≤96 次 且 总等待 ≤62min，超限报错（文案提示音频过长/服务繁忙可重试）
```

理由：

- 梯度间隔照顾主流场景（5~30min 音频 1~6min 返回，短间隔快出结果），45s 长尾间隔保证 96 次内覆盖约 62min 总等待，稳落官方 ≤100 次硬限之内；
- `taskEstimateTime` 实测偏悲观（28s 预估 vs 10s 实际），只用作首查延迟参考、不作为总超时依据；
- 单次 getResult 网络失败不中止订单：计入连续失败计数（连续 5 次判死），成功一次即清零——轮询循环天然具备重试语义，不复用 upload 的指数退避；
- 取消：`sleep(ms, signal)` 与每次 fetch 都挂 AbortSignal（复用现有各家 service 的取消模式），轮询中取消即抛 `TaskCancelledError`（服务端订单继续跑完但结果被丢弃，无额外成本——按音频时长计费与是否取结果无关）。

替代方案：固定 15s 间隔 ×100 次——短音频平均多等 ~8s，体验差；按 taskEstimateTime 动态推算全程——预估不可靠，实测偏差大。

### D3 签名：排序串 = 最终 URL 查询串，零编码歧义

`buildXfyunQuery(params)`：过滤空值 → 按参数名 ASCII 排序（等价 Java TreeMap 自然序）→ 每个值做 **Java URLEncoder 兼容编码**（空格→`+`，`! ' ( ) ~` 转义，保留 `. - * _`）→ `k=v&` 拼接。该串**既是签名 baseString 又是最终请求查询串**（对齐腾讯 utils 的零歧义做法）。`signature = Base64(HmacSHA1(baseString, apiSecret))` 放请求头。

- `dateTime`：本地时区 `yyyy-MM-dd'T'HH:mm:ss±HHmm`（如 `2026-07-02T22:30:32+0800`）——**每次尝试（含 upload 重试与每次 getResult）重新生成并重签**（服务端有时效校验，`100008`）；
- `signatureRandom`：16 位字母数字随机串，**upload 与其后所有 getResult 复用同一个**（文档要求「与上传接口使用相同的随机串，确保请求关联性」，实测复用可用）；
- `fileName` 用净化后的安全名 `audio.<真实扩展名>`（后缀决定服务端格式识别，必须保真；去掉真实文件名避免中文/特殊字符扩大编码歧义面）。

### D4 upload 参数：durationCheckDisable=true，顺滑保持默认开

- `durationCheckDisable=true`，不传 `duration`（实测可用）：service 层只有 `audioPath`，免去 ffprobe/解析 WAV 头取时长的额外依赖，并消除 `failType=5`（时长校验失败）整类错误；
- `language` 直传档位值（`autodialect`/`autominor`）——注意与腾讯不同：任务原语言**不上行**，仅用于上传前守卫（D5）；
- `eng_smoothproc` 保持默认（true，不传）：顺滑后的 `lattice` 更适合字幕（语气词/重复词已清理）；解析时跳过 `wp=s` 顺滑词（见 D6）。

### D5 语种守卫：档位 × 任务原语言，上传前报错

`resolveXfyunLanguageSupport(model, language) → boolean`（纯函数）：

- `autodialect` 允许：`auto` / `zh` / `zh-hant` / `yue` / `en`（中英+202 方言免切，粤语在方言列表内，繁体输出由服务端粤语字体转换逻辑处理）；
- `autominor` 允许：`auto` + 37 语种映射的 ISO-639-1 集合（zh,en,ja,ko,ru,fr,es,ar,de,th,vi,hi,pt,it,ms,id,fil/tl,tr,el,cs,ur,bn,ta,uk,kk,uz,pl,mn,sw,ha,fa,nl,sv,ro,bg,ug,bo）；
- 不支持 → 上传前抛错（语义对齐腾讯守卫：继续上传只会产出乱码还照常计费），错误文案区分两种情况：「autodialect 档不支持该语言，若已开通多语种可切 autominor 档」/「讯飞不支持该语言」。

`auto` 对两档都合法：两档本身就是「免切自动识别」，这是讯飞相对腾讯（无全语种自动引擎）的差异化优势。

### D6 lattice 解析：顺滑结果 + 标点内联 + 词级换算

`extractXfyunResult(orderResultJson) → { text, words, segments }`（纯函数）：

- `orderResult` 是 JSON 字符串 → parse 得 `{ lattice, lattice2 }`；**用 `lattice`**（顺滑后结果，恒存在；`lattice2` 需开权限才返回，不依赖）；
- 每元素 `json_1best` 兼容「字符串（需二次 parse，实测形态）/ 对象（文档示例形态）」两种；
- 句级：`st.bg/ed`（毫秒字符串）→ `AsrSegment`（秒）；句文本 = 按序拼接 `wp∈{n,p}` 的 token（`s` 顺滑词跳过、`g` 分段标记忽略）;
- 词级：`wp=n` 的 token → `AsrWord`，时间 = `(st.bg + wb×10)/1000` 秒（`wb/we` 是相对句首的 10ms 帧）；`wp=p` 标点**内联并入前一词尾**（讯飞标点自带位置信息，比 `realignPunctuation` 从整段回贴更准；无前词的孤立标点丢弃）；
- `text` = segments 文本拼接；`hasWordTimestamps = words.length > 0`；
- 防御：任何一层结构不符 → 跳过该元素（不误贴、不中断），全部失败时退化为空结果由上层按静音语义处理。

### D7 错误分类与静音语义

`classifyXfyunCode(httpStatus, code)`（纯函数，对齐 `classifyTencentCode` 形态）：

- success：`000000`；
- auth（不重试，可行动文案）：`000002`（APIKey 不存在/被禁）、`100009`（签名错误→检查 APISecret）、`100008`（时间偏差→检查系统时间）、`100007`（权限错误→服务未开通/未授权）；
- retriable：`100012`（频率超限）、`999999`（未知异常）、HTTP 429/5xx、网络/超时；
- 订单态（getResult 专用）：`status=3`/`100013` 订单未完成 → 继续轮询；`status=-1` → 按 `failType` 映射文案；
- **静音：`failType=6`（静音文件）→ 按空结果成功返回**（对齐火山 `20000003`、腾讯 code 0 空文本的「无人声→空字幕」语义）；
- `failType` 其余值映射可行动文案（1 上传失败/2 转码失败/3 识别失败/4 超 5h/99 其他）。

### D8 audioLimits：48MB 字节上限间接钳制 5h 时长

官方双上限「500MB 且 ≤5h」，引擎切片判定只看字节。压缩产物 32kbps mp3 ≈0.24MB/min：若按 500MB 声明可装 34h 音频、必撞 5h 时长上限。取 `maxUploadBytes = 48MB` ≈ 3.3h mp3——字幕场景 99% 视频在此之内**整文件单订单转写**（讯飞官方也建议转写 5 分钟以上长音频，与切片策略相性差），且 3.3h 音频的转写等待（线性外推约 33~66min）与 D2 的 62min 总等待上限基本匹配。`maxChunkSeconds` 不声明，回落全局 600s（触发切片的超长音频走 WAV 切片 ≈18.4MB，达标）。

### D9 连通性自测：假 orderId 探针（零成本）

`getResult` + 伪造 orderId（如 `SMARTSUB_PROBE_<ts>`）完整签名探测（实测行为）：

- `100037`（orderId is illegal）→ 签名通过、进入业务校验 → **凭据有效**；
- `100009` → APISecret 错误；`000002` → APIKey 错误/被禁；`100008` → 系统时间偏差；
- 不上传音频、不创建订单、不消耗转写时长（优于火山/腾讯的静音音频探针）。

局限（写入 tips/错误提示而非探针）：无法验证「录音文件转写大模型」服务开通状态与余量——这类问题首次真实转写时由 upload 错误码（`100007` 等）给出可行动文案。

### D10 跨会话订单续查：orderId 持久化 + 内容 hash 指纹

三种「离开」场景分层处理：

- 切页面 / 关闭窗口：任务跑在主进程（关窗为「转后台继续运行」，见 `windowClose.ts`），轮询不受影响——**无需机制，现状即支持**；
- 彻底退出应用：进程死、轮询断，但服务端订单继续跑且结果保留约 5 天（实测 `expireTime` ≈ 创建 +5 天）——**持久化 orderId 即可续查**。

机制（封装在 service 层，引擎/合同零改动）：

- upload 成功即写入 electron-store `xfyunPendingOrders`：键 = `sha1(压缩音频内容) + 服务商实例 id + 档位`，值 = `{ orderId, signatureRandom, createdAt }`。`signatureRandom` 必须持久化——getResult 要求与 upload 复用同一随机串（文档要求，实测确认）；
- `transcribeWithXfyun` 入口先算音频内容 hash 查表：命中且未过期（createdAt < 72h，保守于服务端 5 天）→ 跳过 upload 直接进入轮询（日志标注 resuming order）；续查若报订单不存在/非法（`100001`/`100037`/`100039`）→ 清记录、回落新 upload；
- 订单完结（成功/失败/静音）→ 删除记录；**轮询超时退出 → 保留记录**（重跑任务即续查，化解「超时白等」风险）；读表时惰性清理过期记录。

指纹取「压缩产物内容 hash」而非文件路径：临时文件路径每次重跑都变，而同一视频经确定性的 ffmpeg 抽取/压缩参数产出字节一致；即使 ffmpeg 升级导致产物漂移，也只是错过复用、新建订单，无害降级。hash 48MB 以内 ≈ 百毫秒级，可接受。

替代方案：持久化到任务/文件对象（改 `AsrTranscribeInput` 合同传稳定 key）——否决，跨层污染合同，且任务对象生命周期由渲染层管理、不可靠。

## Risks / Trade-offs

- [异步等待超时后重跑成本] 轮询达上限退出时订单记录**保留**（D10），重跑任务直接续查而非新建订单（不重复计费）；超时文案明示「音频过长或服务繁忙，重跑任务将继续查询该订单」。
- [autominor 误选] 未开通用户选 autominor 上传 → 服务端报错（语言验证/权限）→ tips 预先声明「需联系讯飞人工对接开通」，upload 错误码映射文案兜底。
- [iflyaisol.com 域与讯飞主站分离] 产品线调整可能换域 → 端点集中为模块内常量，一处可改。
- [lattice 形态漂移]（`json_1best` 字符串/对象两态、`lattice2` 权限依赖）→ 解析器双态兼容 + 逐元素防御性跳过 + 段级/整段双层降级。
- [轮询期间进度条停滞] 与现有大文件单请求路径行为一致；进度插值需改 `AsrTranscriber` 合同，留作后续优化。
- [requestTimeoutSec 默认 300s 偏大] 对 getResult 单次查询显得冗余（查询响应 <2s）→ 可接受：超时是防挂死护栏而非节奏控制，轮询节奏由 D2 间隔表驱动。

## Open Questions

- 无阻塞项。autominor 档的真实可用性依赖用户账号开通状态，实现与文案已按「未开通为常态」设计。
