## ADDED Requirements

### Requirement: 腾讯云录音识别极速版服务商类型

系统 SHALL 提供品牌型云服务商类型 `tencent`（腾讯云·录音文件识别极速版）：硬单例（不提供多实例入口）；凭据为必填的 **AppID + SecretID + SecretKey** 三字段（语音识别控制台「API 密钥管理」获取）；端点固定 `asr.cloud.tencent.com`，MUST NOT 开放自定义 base URL（签名原文绑定 Host）。转写 SHALL 以音频**原始二进制**作请求体单请求同步完成（`application/octet-stream`），MUST NOT 依赖公网 URL 中转或对象存储。实现 MUST NOT 引入腾讯云 SDK 依赖（签名 v1 自包含实现）。

#### Scenario: 配置面板出现腾讯分区（数据驱动）

- **WHEN** 用户打开「引擎与模型 ▸ 云端听写」
- **THEN** 面板出现「腾讯云 录音识别极速版」分区，未配置时提供「配置」入口，新建唯一实例（品牌型封顶 1）

#### Scenario: 三字段凭据就绪判定

- **WHEN** 实例的 appid、secretId、secretKey 任一为空
- **THEN** 实例判定为未配置：不进任务页「引擎 ▸ 模型」下拉，连接自测返回「请先补全凭据」类结果

#### Scenario: 本地音频直传不落第三方存储

- **WHEN** 用户以腾讯实例转写本地视频
- **THEN** 音频以原始二进制直接 POST 到 `asr.cloud.tencent.com`，全程不产生公网 URL、不经对象存储中转

### Requirement: 腾讯签名 v1 自包含鉴权与时效

对腾讯极速版的每次 HTTP 请求（含每次重试）SHALL 重新生成签名：URL 参数按字典序排序拼接 `POST + host + path + appid + '?' + 排序查询串` 为原文，以 SecretKey 做 HMAC-SHA1 并 base64 编码后置于 `Authorization` 头；`timestamp` SHALL 取当次请求时刻的 UNIX 秒（服务端时效 ±3 分钟）。签名与查询串构造 SHALL 为纯函数并有单元测试（含固定输入的签名向量断言）；签名参数集 SHALL 仅含 URL 安全字符的参数（排除热词等含分隔符参数），使排序原文与最终 URL 严格一致。

#### Scenario: 重试重签保时间戳时效

- **WHEN** 某次请求因服务端偶发错误进入退避重试
- **THEN** 重试请求以新的 timestamp 重新签名，不复用上一次签名

#### Scenario: 签名错误可诊断

- **WHEN** 凭据错误或签名不匹配（服务端返回 code 4002）
- **THEN** 任务/自测以明确的鉴权失败结束，透出服务端 message，不进入重试

### Requirement: 腾讯模型档位与原语言自动映射 engine_type

腾讯实例的模型清单 SHALL 为两档计费档位枚举（点选启停，MUST NOT 自由文本录入）：`standard`（普通版）与 `large`（大模型版），默认启用 `standard`。任务转写 SHALL 由「所选档位 + 任务原语言」映射 `engine_type` 请求参数：standard 档按语言取单语种引擎（zh→`16k_zh`、en→`16k_en`、ja→`16k_ja` 等，繁体按普通话、粤语→`16k_yue`）；large 档中/英/粤/繁体→`16k_zh_en`，其余语种→`16k_multi_lang`；原语言为「自动识别」时 standard→`16k_zh-PY`（中英粤混合）、large→`16k_zh_en`。原语言不在腾讯支持清单（如俄语）SHALL 在上传前明确报错（不上传、不计费）。历史存量或手工录入的原始 engine*type（`16k*_`/`8k\__`）SHALL 原样透传并忽略原语言。大模型版档位 SHALL 在文案中标注计费与并发差异（免费并发仅 5）。

#### Scenario: 原语言驱动引擎选择

- **WHEN** 用户为日语视频（原语言 ja）以 standard 档开始转写
- **THEN** 请求以 `engine_type=16k_ja` 发出，无需用户单独点选语言引擎

#### Scenario: 大模型档位按语言分流

- **WHEN** 用户以 large 档分别转写中文视频（zh）与日语视频（ja）
- **THEN** 中文请求以 `engine_type=16k_zh_en`、日语请求以 `engine_type=16k_multi_lang` 发出

#### Scenario: 自动识别原语言的回落

- **WHEN** 用户原语言选「自动识别」并以 standard 档转写
- **THEN** 请求以 `engine_type=16k_zh-PY`（中英粤混合）发出

#### Scenario: 不支持语言在上传前报错

- **WHEN** 用户原语言选俄语（ru）并以腾讯实例开始转写
- **THEN** 任务在上传音频前以「腾讯不支持该源语言」类明确错误失败，不产生请求与计费

#### Scenario: 历史存量原始引擎透传

- **WHEN** 实例模型清单存有历史值 `16k_yue` 且任务选中它
- **THEN** 请求以 `engine_type=16k_yue` 原样发出，任务原语言不影响该参数

#### Scenario: 大模型版档位有计费提示

- **WHEN** 用户查看腾讯实例的模型字段说明
- **THEN** 文案标注 large 为大模型版：识别更强、单价更高、免费并发仅 5

### Requirement: 腾讯转写结果的词级归一与标点回贴

腾讯转写 SHALL 请求词级时间戳（`word_info=1`，词无标点），并把 `flash_result[].sentence_list[].word_list[]`（毫秒）归一为秒级词条目（`hasWordTimestamps: true`），复用既有词级成句管线；标点 SHALL 经既有标点回贴从整段带标点文本（`flash_result[].text`）回贴到词序列。`sentence_list[]` SHALL 同时映射为秒级段级结果作降级兜底（某响应缺词级时自动走段级路径）。多声道场景 SHALL 固定只识别首声道（`first_channel_only=1`），与单声道音频准备管线一致。

#### Scenario: 词级路径生成带标点字幕

- **WHEN** 中文视频经腾讯实例转写返回 word_list（毫秒、无标点）与整段带标点文本
- **THEN** 词条目归一为秒并回贴标点，经本地成句管线产出多条带标点字幕，风格与其他云服务商一致

#### Scenario: 缺词级时段级兜底

- **WHEN** 某次响应的 sentence_list 无 word_list
- **THEN** 以 sentence_list 的句级时间戳（秒）作段级结果继续成句，任务不失败

### Requirement: 腾讯响应以业务码判定成败与重试

腾讯转写 SHALL 以响应体 `code` 判定成败（HTTP 状态之外）：`0` 为成功（空文本视为空结果成功）；`4002`（鉴权）与 `4001/4003/4004/4005/4007/4011/4012`（参数/开通/额度/欠费/解码/体积/空数据）SHALL 不重试并携 `message` 报错；`4006`（并发超限）、`5001/5002/5003`（服务端偶发）及 HTTP 429/5xx、网络错误、超时 SHALL 按指数退避有限重试；未知 `code` SHALL 按不可重试失败透出 `code + message`。连接自测 SHALL 以 1 秒静音 WAV 原始字节真实探测：`code 0` 判通过，`4002` 判凭据无效，`4003/4004/4005` 分别透出可行动的开通/额度/欠费提示。

#### Scenario: 并发超限退避重试

- **WHEN** 请求返回 code 4006（当前并发超限）
- **THEN** 按指数退避自动重试（有限次数），不立即失败

#### Scenario: 未开通服务的自测提示可行动

- **WHEN** 用户以有效密钥但未开通语音识别服务的账号运行连接自测（code 4003）
- **THEN** 自测失败并提示需在腾讯云语音识别控制台开通服务，而非笼统的「连接失败」

#### Scenario: 假凭据被自测拦截

- **WHEN** 用户填入错误的 SecretKey 并测试连接
- **THEN** 探测请求到达鉴权层返回 4002，自测判失败并透出服务端 message
