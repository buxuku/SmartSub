## Why

「云端听写」已落地三家服务商（OpenAI 兼容 / ElevenLabs / Deepgram），但**全部面向海外端点**：国内用户面临网络可达性与付款门槛，而 `add-cloud-asr-providers` design 的 Open Question「第二家接谁」中的国内侧（阿里 DashScope 等）一直悬而未决。经逐家核实国内厂商 API（2026-07 探索结论）：**火山引擎「豆包大模型录音文件识别·极速版」是国内适配度最高的一家**——单请求同步返回（无 submit/query 轮询）、支持 base64 直传（不踩「仅公网 URL 不做」的 Non-Goal 红线）、原生返回**词级时间戳 + 标点 + 智能分句**（可直喂现有词级成句管线）、鉴权仅两个 header（无需 SDK 签名）。相比之下阿里千问 Flash 同步模式无时间戳、腾讯云需自实现 HMAC 签名、智谱单文件仅 30s、小红书 FireRedASR 无官方云 API。

这次核实同时暴露一个**架构缺口**：`CLOUD_MAX_UPLOAD_BYTES`（24MB）/ `CLOUD_MAX_CHUNK_SECONDS`（600s）是按 OpenAI 25MB 口径定的**全局常量**，而各家上限差异巨大（火山 base64 体积膨胀 ×1.33、千问 10MB/5min、智谱 30s）。接豆包前应先让**服务商类型声明自己的音频上传约束**，云引擎按声明取值——这也为后续千问/智谱等铺平道路。

## What Changes

- **前置小改造：服务商类型可声明音频上传约束**。`AsrProviderType` 新增可选 `audioLimits?: { maxUploadBytes?: number; maxChunkSeconds?: number }`；`cloudAsrEngine` 按所选实例类型读取（未声明回落现有全局常量）。纯数据驱动，既有三类型不声明、行为零变化。
- **新增品牌型服务商类型 `volcengine`（火山引擎·豆包录音文件识别极速版）**，走 `cloud-asr-provider-grouping` 固化的三步扩展 recipe：
  - ① `ASR_PROVIDER_TYPES` 加一条：品牌型硬单例（`multiInstance` 留空），凭据为**单 API Key（必填，标准 `apiKey` 字段）**——仅支持火山新版「豆包语音」控制台「API Key 管理」签发的 API Key（走 `X-Api-Key` 鉴权；旧版控制台 App ID + Access Token 两件套**不支持**，按用户决策裁剪）；`models` 默认 `bigmodel`，可选 `apiUrl`（默认 `https://openspeech.bytedance.com`）+ 超时/并发/限速字段（与既有类型同语义）；
  - ② `main/service/asr/volcengine.ts` 实现 `transcribe`：读音频 → base64 → `POST /api/v3/auc/bigmodel/recognize/flash`（`X-Api-Resource-Id: volc.bigasr.auc_turbo`），开启 `show_utterances` + 标点/ITN → 解析 `result.utterances[].words[]`（毫秒）归一为词级 `AsrWord`（秒）、`utterances` 兼作段级兜底；显式超时 + 有限重试 + AbortSignal 取消（结构对齐 `deepgram.ts`）；纯解析/构造逻辑抽 `volcengineUtils.ts` 供单测；
  - ③ `ASR_TRANSCRIBER_MAP` 注册 + `testConnection` 探测分支 + i18n 字段文案。
- **词级路径复用**：火山 words 逐字无标点、utterance 文本带标点——现有 `realignPunctuation`（标点回贴）与 `wordCuesFromResult` 成句管线**不改，直接受益**。
- **呈现增补**：引擎副标题/标签/`cloudAsr.intro` 按 grouping 变更的口径增补「豆包」品牌；配置面板因数据驱动分区**自动**出现火山分区，无布局改动。
- **非破坏**：既有三类型行为、任务页下拉、`store.asrProviders` 结构零改动；未配置火山实例时应用行为不变。

## Capabilities

### New Capabilities

（无——扩展既有 `cloud-asr-transcription` 能力，不新增能力域。）

### Modified Capabilities

- `cloud-asr-transcription`: 新增两组要求——（1）服务商类型可声明音频上传约束、云引擎按声明执行压缩/切片；（2）火山引擎豆包服务商类型：品牌单例、单 API Key 凭据（新版控制台）、base64 直传、词级时间戳 + 标点回贴、以响应状态码（而非仅 HTTP 状态）判定成败。不改变既有转写 / 分发 / 并发 / 超时重试 / 隐私护栏要求。

## Impact

- **类型与常量**：`types/asrProvider.ts`（`ASR_VOLCENGINE` 常量、类型定义含 `audioLimits`、fields 声明）。
- **服务实现**：`main/service/asr/volcengine.ts`（新）、`main/service/asr/volcengineUtils.ts`（新，纯函数）、`main/service/asr/index.ts`（MAP 注册）、`main/service/asr/testConnection.ts`（探测分支）。
- **引擎**：`main/helpers/engines/cloudAsrEngine.ts` 读取 `audioLimits`（回落全局常量）；`audioProcessor.ts` 不改（`prepareCloudAudio` / `splitBySilence` 已参数化）。
- **UI/i18n**：`renderer/public/locales/{zh,en}/resources.json`（字段 label/tips/placeholder、`engines.cloud.subtitle/tags`、`cloudAsr.intro` 增补豆包）；`CloudAsrPanel` 零代码改动（数据驱动分区）。
- **测试**：`scripts/test-engine-units.ts` 增 `volcengineUtils` 与 `audioLimits` 回落逻辑断言；`check:i18n` 守卫。
- **依赖**：零新增——用全局 `fetch` + 现有 `uuid`；**不用** `@volcengine/openapi`（该 SDK 面向签名式 OpenAPI，语音接口仅需 header 鉴权）。
- **文档**：README（zh/en）「云端听写」小节增补豆包；一次性 spike 脚本（`scripts/spike/asr-volcengine.mjs`）验证后删除。
- **待实测风险**：base64 请求体的官方体积上限未在文档明示（初始取保守值 16MB 原始音频，spike 校准）；`testConnection` 空体探测的具体状态码需实测固化。
