# Proposal: add-volcengine-tts-provider

> 依据：`openspec/changes/archive/2026-07-08-tts-dubbing-phase-1-5/design.md` Non-Goals 显式推迟的国内厂商首位（「火山豆包语音 / 阿里 CosyVoice / MiniMax / Fish Audio → 后续变更」）；叠加 2026-07 云端 TTS 调研结论——豆包语音合成大模型中文自然度第一梯队、约 1.3 元/千字符、新用户有免费赠额、国内直连零代理。

## Why

云端配音已有四类服务商（OpenAI 兼容 / Edge / Azure / ElevenLabs），但**中文场景没有一个「效果与可达性双优」的选项**：Edge 是不承诺可用性的试用档，Azure 中文音色自然度弱于国产大模型 TTS 且免费层并发低，ElevenLabs 国内不可直连且中文按字节膨胀计费。豆包语音合成 2.0 是 2026-07 调研的中文自然度第一梯队，字符版约 1.3 元/千字符、新用户有免费额度、国内直连。同时项目已接入火山 ASR（`main/service/asr/volcengine*.ts`）：**同一「豆包语音」控制台、同一 X-Api-Key 鉴权体系、同一状态码语义**，凭据可直接复用，服务商框架（schema 类型 + 分发表 + 数据驱动 UI）已铺好，接入是纯增量的最低成本窗口。

## What Changes

- **新增品牌型 TTS 服务商类型 `volcengine`（火山引擎·豆包语音合成，硬单例）**：
  - 凭据为**单 API Key**（必填，新版「豆包语音」控制台签发，走 `X-Api-Key` 头；与已接入的豆包听写 ASR 同源可复用同一 Key；旧版控制台 App ID + Access Token 两件套**不支持**——沿用 ASR 侧既有裁剪决策）；
  - **资源版本可选**（`resourceId` 枚举：`seed-tts-2.0` 默认 / `seed-tts-1.0` / `seed-tts-1.0-concurr`，经 `X-Api-Resource-Id` 头传递，决定可用音色集与计费商品）；
  - 合成走 **V3 单向流式 HTTP**（`POST /api/v3/tts/unidirectional`，一次性输入全部文本、chunked 流式返回 JSON 分片）：请求 `format=pcm`（24kHz）拿裸 PCM，分片 base64 解码拼接后**本地包 WAV 头落盘为 16-bit PCM 单声道 wav，零 ffmpeg 转码**（ElevenLabs 先例，复用 `writePcmAsWav`）；
  - **原生语速**：`speedControl='native'`——speed 折算为 `audio_params.speech_rate`（区间 [-50, 100] ↔ 倍速 [0.5, 2.0] 线性映射，纯函数可单测；覆盖对齐引擎全部实用区间，超界残余由既有云端 atempo 复测分支兜底）。
- **音色预填与文档外链**：`voices` 预填 2.0 通用音色 id（`*_uranus_bigtts` 系列中英常用集，实现期真机实测定稿）+ 内置 id→中文名映射兜底展示；类型声明 `docsUrl` 指向官方音色列表文档，面板出现「音色文档」外链。**不做在线拉取**（音色列表属控制台 OpenAPI，走火山主账号 AK/SK 签名体系，与豆包语音 API Key 不通，不纳入 `voiceListMode`）。
- **测试连接与错误分类**：测试连接经通用 `testTtsConnection`（真实合成一句）自动生效，无需新增分支；错误分类定向引导（形制 ASR 侧 `classifyVolcStatus`）——HTTP 401/403 → 指向 API Key（豆包语音控制台签发、方舟/推理 Key 不通用、确认已开通语音合成服务）；`45000000` speaker permission denied → 指向音色 id 未授权或拼写错误；`quota exceeded ... concurrency` → 并发限流引导（调低实例并发/稍后重试）；`55000000` resource mismatched → 指向资源版本与音色版本不匹配（2.0 音色配 `seed-tts-2.0`、1.0 音色配 `seed-tts-1.0`）。
- **计费口径提示**：配置面板 tips 与工作台字符量预估处附豆包计费口径（字符版约 1.3 元/千字符、新用户免费赠额、按版本对应不同计费商品）。
- **非破坏**：既有四类型行为、`ttsProviders` 存储结构零改动；「配音服务」页与工作台引擎下拉经 `buildTtsViews` / `isTtsProviderConfigured` 数据驱动自动外显，零 UI 结构改动。

**不做**（Non-Goals，见 design）：声音复刻（`seed-icl-*` / `S_` 音色）、情感与语音指令参数化（`emotion` / `context_texts`）、其它服务商。

## Capabilities

### New Capabilities

（无——扩展既有 `tts-cloud-providers` 能力域，不新增能力域。）

### Modified Capabilities

- `tts-cloud-providers`：新增「火山引擎豆包语音合成服务商」Requirement（凭据/资源版本/端点协议/裸 PCM 落盘合同/原生语速折算/音色预填与文档外链/错误分类定向引导/计费提示）；「云端 TTS 服务商框架」Requirement 的内置类型清单句同步增补豆包。

## Impact

- **类型**：`types/ttsProvider.ts`（新增 `TTS_VOLCENGINE` 常量、类型定义含 resourceId 枚举字段与能力声明、单请求字符上限常量、内置音色 id→名称映射）。
- **main 侧新增**：`main/service/tts/volcengine.ts`（synthesize 实现）+ `main/service/tts/volcengineTtsUtils.ts`（纯工具：header/body 构造、speech_rate 折算、chunked JSON 流解析拼 PCM、错误分类；零网络/fs/electron，形制 `azureUtils` / ASR 侧 `volcengineUtils`）。
- **main 侧修改**：`main/service/tts/index.ts`（分发表加一条映射）。
- **renderer 侧**：「配音服务」页零代码自动外显；`renderer/components/dubbing/DubbingFileBar.tsx` 计费提示按 providerType 增补豆包分支。
- **i18n**：`renderer/public/locales/{zh,en}/resources.json`（API Key / 资源版本 / 音色清单字段 tips）、`{zh,en}/dubbing.json`（计费口径文案），`check:i18n` 守卫。
- **测试**：`scripts/dubbing/test-dubbing-units.ts` 增 volcengineTtsUtils 固定向量用例（速率折算 / body 构造 / 流解析 / 错误分类），`npm run test:dubbing` 全过。
- **依赖**：**零新增**——原生 `fetch`（HTTP chunked 响应经 `res.text()` 全量读取后解析，无需流式消费）+ 现有 `uuid`；不引入火山 SDK（语音接口仅需 header 鉴权）。
- **待实测风险**：单请求文本上限官方未在接口文档明示（错误码 `40402003` TTSExceededTextLimit 存在），初始取保守值、实现期以真机校准；预填音色集需真机验证账号默认可用性（2.0 音色需账号开通对应商品）。
