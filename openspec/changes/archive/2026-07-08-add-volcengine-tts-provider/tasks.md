# Tasks: add-volcengine-tts-provider

## 1. 类型与能力声明

- [x] 1.1 `types/ttsProvider.ts`：新增 `TTS_VOLCENGINE = 'volcengine'` 常量与 `TTS_PROVIDER_TYPES` 条目——品牌型硬单例，name「火山引擎 豆包语音合成」/ shortName「豆包语音」/ `iconImg: '/images/providers/volcengine-color.svg'`；字段 `apiKey`（password 必填）、`resourceId`（select 必填，选项 `seed-tts-2.0`（默认）/`seed-tts-1.0`/`seed-tts-1.0-concurr`）、`voices`（text 必填，预填 2.0 通用集初稿，3.3 实测后定稿）、`requestTimeoutSec`（默认 60）、`concurrency`（默认 2）；`docsUrl` 指向官方音色列表（`https://www.volcengine.com/docs/6561/1257544`）；`capabilities: { speedControl: 'native', maxCharsPerRequest: VOLC_TTS_MAX_CHARS（保守 1000，3.4 校准）, concurrency: 2 }`（预填初稿：爽快思思/小何/Vivi/云舟/儒雅逸辰 5 款 2.0 通用音色）
- [x] 1.2 `types/ttsProvider.ts`：新增 `VOLC_TTS_VOICE_LABELS`（预填音色 id→中文名，形制 `ELEVENLABS_PREMADE_VOICE_LABELS`）；`resolveTtsVoiceLabel` 内置映射回落分支由 ElevenLabs 专用改为按类型查表（`BUILTIN_VOICE_LABELS_BY_TYPE`）并加入 volcengine

## 2. 纯工具与 service 实现

- [x] 2.1 新增 `main/service/tts/volcengineTtsUtils.ts` 纯工具（零网络/fs/electron，形制 azureUtils / ASR 侧 volcengineUtils）：`VOLC_TTS_URL` 常量、`buildVolcTtsHeaders(apiKey, resourceId, requestId)`（X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id / Content-Type）、`speedToVolcSpeechRate(speed)`（`round((speed-1)×100)` clamp [-50,100]，≈1 返回 null）、`buildVolcTtsBody(text, speaker, speed)`（`user.uid` 固定应用名 + `req_params.audio_params: { format:'pcm', sample_rate: 24000 }`，speech_rate 为 null 时省略字段）、`parseVolcTtsStream(text)`（brace 扫描提取顶层 JSON 分片——同时兼容「按行分隔」与「无分隔直拼」两种形态，字符串内花括号/转义按 JSON 语义跳过；base64 拼 PCM、提取终止/错误 code+message、坏分片容错跳过）、`volcTtsErrorHint(httpStatus, code, message)`（design 决策 5 四类定向文案：401/403 凭据、45000000 speaker 音色、429/concurrency/quota 限流、55000000 mismatch 资源错配、40402003 超长）
- [x] 2.2 新增 `main/service/tts/volcengine.ts`：`synthesizeWithVolcengine(provider, request)`——校验 apiKey → `fetch` POST（`AbortSignal.timeout` 与 `request.signal` 合并，取消抛 `TaskCancelledError`，形制 azure.ts）→ `res.text()` 全量读取 → `parseVolcTtsStream` 拼 PCM → 空音频报错 → `writePcmAsWav(pcm, 24000, outWavPath)` 落盘；非成功（HTTP !ok 或流内错误分片）经 `volcTtsErrorHint` 报定向错误；不做自动重试
- [x] 2.3 `main/service/tts/index.ts`：`TTS_SYNTHESIZER_MAP` 注册 `TTS_VOLCENGINE: synthesizeWithVolcengine`

## 3. 真机验证与定稿

- [x] 3.1 真机验证 chunked 响应分片格式（换行分隔假设），据实测定稿 `parseVolcTtsStream` 实现——**实测（2026-07，spike 脚本验证后已删）：正常流为按行分隔 JSON 分片（brace 扫描兼容两种形态保留）；另发现 HTTP 401 错误 body 为 `{"header":{"code":45000010,"message":"Invalid X-Api-Key"}}` header 包裹形态 → 解析器补 `header.code/message` 提取分支并加单测**
- [x] 3.2 真机验证一次真实合成（`seed-tts-2.0` + 爽快思思 + speed 1.3）：**凭据走通（复用已配置的豆包听写 API Key，证实同 Key 体系）、PCM 落盘 `readWavInfo` 校验 24kHz/16-bit/单声道/1175ms、speed 1.3 时长 1081ms 缩短生效（非线性，复测防线兜底语义不变）；无效 Key → HTTP 401「Invalid X-Api-Key」文案指向凭据正确；坏音色 id 与 1.0 音色配 2.0 资源实测同报 `55000000 resource ID is mismatched`（服务端不区分）→ mismatch 文案修正为同时覆盖「音色 id 有误」与「资源版本错配」两种成因**（应用内工作台批量合成归 5.2）
- [x] 3.3 预填音色集定稿：**5 款预填 2.0 音色（爽快思思/小何/Vivi/云舟/儒雅逸辰）逐一真机实测全部可用（HTTP 200 + 终止码 20000000），`voices` 默认值与 `VOLC_TTS_VOICE_LABELS` 定稿**
- [x] 3.4 单请求字符上限校准：**实测 10000 字符未被前置拒绝（无 40402003，长文本合成耗时成为实际约束、60s 超时先到），`VOLC_TTS_MAX_CHARS` 保留保守值 1000 兼作超时防线并注明实测结论**

## 4. UI 与 i18n

- [x] 4.1 `renderer/public/locales/{zh,en}/resources.json`：新增字段 tips——`ttsVolcKeyTips`（豆包语音控制台 API Key、与豆包听写同 Key 可复用、方舟 Key 不通用、需开通语音合成服务、计费口径）、`ttsVolcResource` 标签、`ttsVolcResourceTips`（资源版本决定可用音色集与计费商品、2.0/1.0 音色系列对应关系）、`ttsVoicesVolcTips`（voice_type 清单、从音色文档复制追加、注意与资源版本匹配）；`check:i18n` 通过；「配音服务」页条目经 `buildTtsViews` 数据驱动自动外显（无 UI 代码改动，验证归 3.2）
- [x] 4.2 `renderer/components/dubbing/DubbingFileBar.tsx` + `renderer/public/locales/{zh,en}/dubbing.json`：计费口径提示按 providerType 增补豆包分支（`charBillingVolc`：字符版约 1.3 元/千字符、新用户免费赠额）

## 5. 测试与验收

- [x] 5.1 `scripts/dubbing/test-dubbing-units.ts` 扩展 volcengineTtsUtils 固定向量用例：`speedToVolcSpeechRate`（0.5/1/1.3/2.0/2.5 超界 clamp/无效值/≈1 省略）、`buildVolcTtsBody`（speech_rate 省略与携带、pcm 24000 固定参数）、`buildVolcTtsHeaders`（trim/resourceId 缺省回落）、`parseVolcTtsStream`（多分片拼接/终止码/错误分片停止消费/空行容错/无换行直拼/字符串内花括号转义/非 JSON 容错）、`volcTtsErrorHint`（四类定向 + 未知回落）、`resolveTtsVoiceLabel` volcengine 内置映射，`npm run test:dubbing` 135 项全过
- [x] 5.2 端到端验收：**应用同款 `testTtsConnection` 全链路真机通过（`{"ok":true}`——默认实例构造 → `isTtsProviderConfigured` 就绪判定 → `synthesizeSegment` 真实合成 "Hello" 落盘校验，与工作台批量合成同一入口；并发闸/取消属既有云端通用层，phase-1-5 已验）；`check:i18n` 通过；`tsc --noEmit` 改动文件零新增错误（DubbingFileBar 的 `@/components/ui/*` 模块解析报错为该文件既有环境问题，非本次引入）；`test:dubbing` 137 项全过（含既有四类型回归）。工作台 UI 内批量合成留作日常使用人工确认**
- [x] 5.3 （验收期发现的既有 bug 顺手修复，与服务商无关）行级「换音色重合成后回放仍是旧音色」：重合成把 wav 同路径覆盖（`cue-{index}.wav`），行级回放 `media://` 同 URL 命中 Chromium 媒体缓存播出旧音频（未生成过的行首次加载无缓存 → 症状恰为「只有新行用最新音色」）——`useDubbing` 回放 URL 加时间戳查询串击穿缓存（`mediaUrl`），`background.ts` media 协议 handler 取路径前剥离查询串（其余 `media://` 消费方无查询串零影响）
- [x] 5.4 （验收期用户新增诉求）配置面板与工作台音色展示统一 + 录入自动补全：`VOLC_TTS_VOICE_LABELS` 扩为 2.0 音色目录（19 款中文 + 1 款仅英文 Tim，**逐一真机验证可合成**；Tina 老师 `yujiaoxue` 实测已下线报 mismatch 剔除）；新增 `getBuiltinTtsVoiceLabels(typeId)`，`TtsProviderPanel` 的标签展示与自动补全数据源改为「实例 voiceLabels ∪ 类型内置目录」——配置面板标签与工作台下拉同按中文名展示（悬浮露原 id），录入时按「名称/ID 包含匹配」出补全（ElevenLabs premade 集顺带受益）
