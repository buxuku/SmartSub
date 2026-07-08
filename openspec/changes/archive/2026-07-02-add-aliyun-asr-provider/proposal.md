## Why

「云端听写」已有五家服务商（OpenAI 兼容 / ElevenLabs / Deepgram / 火山豆包 / 腾讯极速版）。用户点名评估阿里系接入路径，两条候选（2026-07 官方文档核实）结论明确：

- **阿里百炼（Model Studio）不适配**：其 OpenAI 兼容模式是 `chat/completions` + `input_audio` 消息体（非 `audio/transcriptions`，现有 OpenAI 兼容引擎接不上），且官方明示该方式**不返回时间戳**；带句/字级时间戳的三个异步模型（fun-asr / qwen3-asr-flash-filetrans / paraformer）**只收公网 URL**，踩「不依赖公网 URL 中转」的 Non-Goal 红线。「本地文件」与「时间戳」在百炼不可兼得，暂不接入（已与用户对齐）。
- **阿里云智能语音交互（NLS）「录音文件识别极速版」适配度高**，与已落地的腾讯极速版几乎同构：
  - **同步单请求**（`POST nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/FlashRecognizer`，30 分钟音频约 10 秒出结果），无提交/轮询；
  - **音频原始二进制直进请求体**（`application/octet-stream`），支持 wav/mp3（另有 mp4/aac/opus），上限 **100MB / 2 小时**；
  - **词级时间戳**（`enable_word_level_result=true`）：`sentences[].words[]` 毫秒级起止 + 词条目自带 `punc`（词尾标点独立字段，标点回贴比腾讯路径更省——直接拼接即可）；`sentences[]` 句级兜底；
  - 每句可选 `sentence_max_length` 等字幕向参数（本地成句管线已覆盖，不透出）。

选 NLS 极速版作为第 6 家（阿里系首家）接入，完整复用 volcengine/tencent 铺好的三步扩展 recipe，零架构改动。

**两点与腾讯不同、需在设计中消化**：① 鉴权为**两段式**——AccessKey ID/Secret 先经 POP 签名调 `CreateToken`（`nls-meta.cn-shanghai.aliyuncs.com`）换临时 Token（带 ExpireTime，需缓存复用），再以 `appkey + token` 调识别接口；② **识别语种绑定控制台「项目」（appkey）**，不是请求参数——中文外语种需用户在控制台为项目配置对应模型。形态仍为**品牌型硬单例**（同豆包/腾讯；实施评审时用户裁定无需多实例——默认普通话模型可识别中英混合，换语种在控制台改项目配置即可），语种错配风险以 tips/README 文案缓解。

**计费注意**：极速版**仅商用版、无免费试用**（开通即按时长计费），文案必须显著提示——这与腾讯「每月 5 小时免费」不同，避免用户误解。

## What Changes

- **新增品牌型服务商类型 `aliyun`（阿里云·录音文件识别极速版）**，走既有三步 recipe：
  - ① `ASR_PROVIDER_TYPES` 加一条：**品牌型硬单例**（同豆包/腾讯；识别语种绑定 appkey 对应的 NLS 项目，换语种在控制台改项目配置）；凭据三字段 **AccessKey ID + AccessKey Secret + Appkey**（前两者为阿里云账号/RAM 密钥，后者为 NLS 控制台项目 Appkey，均必填）；`models` 为固定单值 `flash`（该接口无模型参数，UI 只读展示，同 volcengine `bigmodel` 形态）；端点固定 `nls-gateway-cn-shanghai.aliyuncs.com`（不开放自定义）；超时/并发/限速字段同既有语义；声明 `audioLimits`；
  - ② `main/service/asr/aliyun.ts` 实现 `transcribe`：先取 Token（模块级缓存，ExpireTime 前复用、过期或 40000001/403 时强制刷新一次重试）→ 读音频**原始字节**直传 `POST /stream/v1/FlashRecognizer?appkey&token&format&sample_rate=16000&enable_word_level_result=true&first_channel_only=true`；以响应体 `status` 判成败（`20000000` 成功；`40000001/403` 鉴权、`40000005` 限流重试、`40000010` 未开通商用、`40020105/40020106` appkey 错误、`5xxxxxxx` 服务端偶发重试、`40270002` 无有效语音视为空结果成功）；显式超时 + 有限重试 + AbortSignal 取消（结构对齐 `tencent.ts`）；
  - CreateToken 的 POP 签名（参数字典序 + RFC3986 编码 + `GET&%2F&…` 原文 + HMAC-SHA1(Secret+"&")）与查询串构造、结果解析、状态分类抽 `aliyunUtils.ts` 纯函数供单测；
  - ③ `ASR_TRANSCRIBER_MAP` 注册 + `testConnection` 分支（两段探测：CreateToken 验 AccessKey → 1 秒静音 WAV 真实探测验 appkey/开通状态）+ i18n 字段文案。
- **词级路径复用**：`words[].text` + `punc` 拼接为带标点词条目（毫秒→秒）直喂 `wordCuesFromResult`；`sentences[]` 映射段级兜底。成句管线零改动。
- **`audioLimits` 声明**：`maxUploadBytes: 24MB`（与腾讯同理：官方 100MB/2h 双上限、引擎只按字节判定，32kbps mp3 下 24MB≈100min<2h 间接钳住时长；切片回落全局 600s）。
- **呈现增补**：引擎副标题/标签/`cloudAsr.intro` 增补「阿里云」；配置面板数据驱动自动出现阿里分区（图标复用 `alibabacloud.svg`，品牌型单例「配置」入口同豆包/腾讯形态）。
- **非破坏**：既有五类型行为、任务页下拉、`store.asrProviders` 结构、成句管线零改动；未配置阿里实例时应用行为不变。

## Capabilities

### New Capabilities

（无——扩展既有 `cloud-asr-transcription` 能力，不新增能力域。）

### Modified Capabilities

- `cloud-asr-transcription`: 新增一组要求——阿里云录音文件识别极速版服务商类型：品牌型硬单例、三字段凭据、CreateToken 两段式鉴权（Token 缓存复用 + 失效自动刷新重试）、原始二进制直传、固定模型 `flash`（语种绑定控制台项目而非请求参数）、词级时间戳（词条目含独立标点字段直接拼接）、以响应体 `status` 判定成败与重试分类、极速版无免费额度的计费提示。不改变既有转写 / 分发 / 并发 / 超时重试 / 隐私护栏要求。

## Impact

- **类型与常量**：`types/asrProvider.ts`（`ASR_ALIYUN` 常量、类型定义含三凭据字段 + 固定 models + `audioLimits`，品牌型硬单例）。
- **服务实现**：`main/service/asr/aliyun.ts`（新）、`main/service/asr/aliyunUtils.ts`（新，纯函数：POP 签名/CreateToken 参数/识别查询串/状态分类/结果解析/Token 缓存判定）、`main/service/asr/index.ts`（MAP 注册）、`main/service/asr/testConnection.ts`（探测分支——阿里同样无通用 `apiKey` 字段，按自身三字段守卫）。
- **引擎**：零改动——`resolveAudioLimits` 自动取声明；`prepareCloudAudio` 产物（wav/mp3）映射 `format` 参数。
- **UI/i18n**：`renderer/public/locales/{zh,en}/resources.json`（字段 label/tips/placeholder、`engines.cloud.subtitle/tags`、`cloudAsr.intro` 增补阿里云）；`CloudAsrPanel` 零代码改动（单例「配置」入口、固定模型 UI 均数据驱动）。
- **测试**：`scripts/test-engine-units.ts` 增 `aliyunUtils` 断言（POP 签名向量、RFC3986 编码边界、Token 缓存过期判定、状态分类、毫秒→秒与 punc 拼接解析）；`check:i18n` 守卫。
- **依赖**：零新增——POP 签名用 node:crypto（HMAC-SHA1）+ `crypto.randomUUID`，HTTP 用全局 `fetch`；**不用**阿里云 SDK。
- **文档**：README(zh/en)「云端听写」小节增补阿里云（凭据获取入口：RAM AccessKey + NLS 控制台项目 Appkey；显著注明**无免费额度、开通即商用计费**；语种绑定项目、换语种在控制台改项目配置）。
- **待实测风险**：静音 1s WAV 的实际返回（预期 `20000000` 空结果或 `40270002`，均判探测通过）；`words[]` 时间戳在响应样例中为字符串（`"begin_time":"1010"`），解析需 `Number()` 宽容；多声道/采样率自动重采样行为按文档固化、随用户凭据手测校准。
