## Why

「云端听写」已有四家服务商（OpenAI 兼容 / ElevenLabs / Deepgram / 火山引擎豆包），国内侧仅豆包一家。按既定路线继续补国内厂商，逐家核实（2026-07 复查最新文档）后**腾讯云「录音文件识别极速版」是当前适配度最高的下一家**：

- **同步单请求**（`POST asr.cloud.tencent.com/asr/flash/v1`，30 分钟音频约 10 秒出结果），无 submit/query 轮询；
- **音频以原始二进制直接进请求体**（`application/octet-stream`，无 base64 膨胀），上限 **100MB / 2 小时**——远宽于豆包的 16MB/480s，绝大多数视频压缩后免切片一发即成；
- **词级时间戳**（`word_info`）+ `sentence_list` 句级兜底，词级成句管线（含标点回贴）直接复用；
- **免费额度每月 5 小时**，超出约 1.5–3.1 元/小时，对个人用户友好；
- 当初探索时唯一顾虑「需自实现签名」实测很轻：该接口用**旧版签名 v1**（参数字典序拼串 + HMAC-SHA1 + base64），node:crypto 十余行纯函数即可，零新依赖、可单测。

相比之下：阿里百炼 Qwen3-ASR-Flash 同步模式**无时间戳**（官方明示要时间戳走 Filetrans，而 Filetrans **仅收公网 URL**，踩 Non-Goal 红线）；新出的 fun-asr-flash 同步接口未明示词级时间戳与 base64 输入，待 spike 后另行评估；讯飞为上传+轮询慢回执；智谱单文件 30s。均不如腾讯极速版。

本变更完整复用 `add-volcengine-asr-provider` 铺好的机制：三步扩展 recipe、`audioLimits` 类型声明、模型枚举点选 UI、静音 WAV 连接探测——**零架构改动，纯增量接入**。

## What Changes

- **新增品牌型服务商类型 `tencent`（腾讯云·录音文件识别极速版）**，走既有三步 recipe：
  - ① `ASR_PROVIDER_TYPES` 加一条：品牌型硬单例（`multiInstance` 留空），凭据三字段 **AppID + SecretID + SecretKey**（语音识别控制台「API 密钥管理」获取，均必填）；`models` 为**计费档位两档枚举**（`standard` 普通版 / `large` 大模型版，默认 `standard`；识别语言跟随任务原语言、转写时映射 engine_type——实施中按用户反馈由「20 个 engine_type 全枚举」修订，见 design D3）；端点固定 `asr.cloud.tencent.com`（签名绑定 Host，不开放自定义）；超时/并发/限速字段与既有类型同语义；声明 `audioLimits`；
  - ② `main/service/asr/tencent.ts` 实现 `transcribe`：读音频 → **原始字节**直传 `POST /asr/flash/v1/{appid}?{sorted params}`，签名 v1（HMAC-SHA1）进 `Authorization` 头；`word_info=1` 取词级时间戳（毫秒），`flash_result[].text` 整段带标点供标点回贴，`sentence_list` 兼作段级兜底；以响应体 `code` 判成败（`0` 成功；`4002` 鉴权、`4006` 并发超限、`5001–5003` 服务端错等分类重试/报错）；显式超时 + 有限重试 + AbortSignal 取消（结构对齐 `volcengine.ts`）；签名/查询串/结果解析/状态分类抽 `tencentUtils.ts` 纯函数供单测；
  - ③ `ASR_TRANSCRIBER_MAP` 注册 + `testConnection` 探测分支（1 秒静音 WAV 原始字节真实探测，复用既有静音音频构造）+ i18n 字段文案。
- **词级路径复用**：请求 `word_info=1`（词无标点）+ 整段文本带标点——与豆包路径**完全同构**，`realignPunctuation` + `wordCuesFromResult` 零改动直接受益。
- **`audioLimits` 声明**：`maxUploadBytes: 24MB`——官方请求体上限 100MB，但另有 **2 小时时长上限**且引擎只按字节判定；压缩产物为 32kbps mp3（≈0.24MB/分钟），24MB ≈ 100 分钟 < 2h，以字节上限间接钳住时长，超长自动落入切片路径。切片时长沿用全局默认 600s（WAV ≈18.4MB，远小于 100MB）。
- **呈现增补**：引擎副标题/标签/`cloudAsr.intro` 增补「腾讯」；配置面板数据驱动分区**自动**出现腾讯分区（图标复用 `tencentcloud-color.svg`），零布局改动。
- **非破坏**：既有四类型行为、任务页下拉、`store.asrProviders` 结构、成句管线零改动；未配置腾讯实例时应用行为不变。

## Capabilities

### New Capabilities

（无——扩展既有 `cloud-asr-transcription` 能力，不新增能力域。）

### Modified Capabilities

- `cloud-asr-transcription`: 新增一组要求——腾讯云录音文件识别极速版服务商类型：品牌单例、三字段凭据、签名 v1 自包含鉴权（按次生成、时间戳时效 ±3 分钟）、原始二进制直传、模型档位（standard/large）+ 任务原语言自动映射 engine_type（不支持语言上传前报错、原始 engine_type 透传兼容）、词级时间戳 + 标点回贴、以响应体 `code` 判定成败与重试分类。不改变既有转写 / 分发 / 并发 / 超时重试 / 隐私护栏要求。

## Impact

- **类型与常量**：`types/asrProvider.ts`（`ASR_TENCENT` 常量、类型定义含三凭据字段 + 档位枚举 models + `audioLimits`）。
- **服务实现**：`main/service/asr/tencent.ts`（新）、`main/service/asr/tencentUtils.ts`（新，纯函数：查询串构造/签名/状态分类/结果解析）、`main/service/asr/index.ts`（MAP 注册）、`main/service/asr/testConnection.ts`（探测分支——注意腾讯无 `apiKey` 字段，需按自身三字段守卫）。
- **引擎**：零改动——`cloudAsrEngine` 已按 `resolveAudioLimits` 读取类型声明；`audioProcessor.ts` 不动。
- **UI/i18n**：`renderer/public/locales/{zh,en}/resources.json`（字段 label/tips/placeholder、`engines.cloud.subtitle/tags`、`cloudAsr.intro` 增补腾讯）；`CloudAsrPanel` 零代码改动（models 枚举点选 UI 已数据驱动）。
- **测试**：`scripts/test-engine-units.ts` 增 `tencentUtils` 断言（签名向量、参数字典序、状态分类、毫秒→秒解析、engine_type options 形态）；`check:i18n` 守卫。
- **依赖**：零新增——签名用 node:crypto（HMAC-SHA1），HTTP 用全局 `fetch`；**不用**腾讯云 SDK（其封装面向云 API 网关签名 v3，本接口为独立的简化签名 v1）。
- **文档**：README(zh/en)「云端听写」小节增补腾讯云（凭据获取入口：语音识别控制台 API 密钥管理；注明每月 5 小时免费额度与大模型版引擎计费差异）。
- **待实测风险**：`word_info=1` 词条目形态（是否含空格前缀/英文分词粒度）、静音探测的实际 `code` 取值——按官方文档固化实现，随用户凭据手测校准（同豆包流程）。
