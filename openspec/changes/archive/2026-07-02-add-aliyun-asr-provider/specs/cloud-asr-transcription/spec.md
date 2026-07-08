## ADDED Requirements

### Requirement: 阿里云录音识别极速版服务商类型

系统 SHALL 提供品牌型云服务商类型 `aliyun`（阿里云·录音文件识别极速版）：**硬单例**（同豆包/腾讯；识别语种由 Appkey 对应的 NLS 控制台项目配置决定，换语种在控制台调整项目模型）；凭据为必填的 **AccessKey ID + AccessKey Secret + Appkey** 三字段；模型为固定单值 `flash`（该接口无模型参数，UI 只读展示）；识别与取号端点固定（`nls-gateway-cn-shanghai.aliyuncs.com` / `nls-meta.cn-shanghai.aliyuncs.com`），MUST NOT 开放自定义 base URL。转写 SHALL 以音频**原始二进制**作请求体单请求同步完成（`application/octet-stream`），MUST NOT 依赖公网 URL 中转或对象存储。实现 MUST NOT 引入阿里云 SDK 依赖（POP 签名自包含实现）。

#### Scenario: 配置面板出现阿里云分区（数据驱动、单例）

- **WHEN** 用户打开「引擎与模型 ▸ 云端听写」
- **THEN** 面板出现「阿里云 录音识别极速版」分区，提供「配置」入口（同豆包/腾讯的品牌型单例形态，配置一个、封顶 1）

#### Scenario: 三字段凭据就绪判定

- **WHEN** 实例的 accessKeyId、accessKeySecret、appkey 任一为空
- **THEN** 实例判定为未配置：不进任务页「引擎 ▸ 模型」下拉，连接自测返回「请先补全凭据」类结果

#### Scenario: 本地音频直传不落第三方存储

- **WHEN** 用户以阿里实例转写本地视频
- **THEN** 音频以原始二进制直接 POST 到阿里 NLS 网关，全程不产生公网 URL、不经对象存储中转

#### Scenario: 语种绑定项目的文案提示

- **WHEN** 用户查看阿里实例的模型/appkey 字段说明
- **THEN** 文案明确：识别语种在 NLS 控制台项目功能配置中设定（非任务原语言驱动），默认普通话模型可识别中英混合，其它语种需在控制台调整项目模型

### Requirement: 阿里 CreateToken 两段式鉴权与 Token 缓存

阿里转写与探测 SHALL 采用两段式鉴权：先以 AccessKey ID/Secret 经 POP 签名（参数字典序 + RFC3986 percentEncode + `GET&%2F&` 原文 + HMAC-SHA1(Secret+"&") + base64）调用 CreateToken 获取临时 Token，再以 `appkey + token` 调用识别接口。Token SHALL 在进程内按 AccessKey ID 缓存复用，直至 ExpireTime 前的安全余量（提前刷新）；每次 CreateToken 请求 SHALL 使用不重复的 UUID SignatureNonce。识别请求返回 Token 失效类错误（40000001 / HTTP 403）时 SHALL 强制刷新 Token 并原地重试一次，仍失败才按鉴权失败终态报错。POP 签名与查询串构造 SHALL 为纯函数并有单元测试（含固定输入的签名向量断言）。

#### Scenario: Token 缓存跨请求复用

- **WHEN** 同一账号（AccessKey ID）的实例在 Token 有效期内连续转写多个切片
- **THEN** 仅首次请求调用 CreateToken，后续切片复用缓存 Token，不逐请求取号

#### Scenario: Token 过期自动刷新重试

- **WHEN** 识别请求因缓存 Token 恰好过期返回 40000001
- **THEN** 系统清除缓存、重新 CreateToken 并原地重试该请求一次，成功则任务无感继续

#### Scenario: AccessKey 无效可诊断

- **WHEN** 用户填入错误的 AccessKey ID 并测试连接
- **THEN** CreateToken 失败，自测以明确的「AccessKey 无效/签名错误」类结果透出服务端 Code 与 Message

### Requirement: 阿里转写结果的词级归一与标点拼接

阿里转写 SHALL 请求词级信息（`enable_word_level_result=true`），并把 `flash_result.sentences[].words[]` 归一为秒级词条目（`hasWordTimestamps: true`）：词文本 SHALL 拼接词条目自带的词尾标点字段 `punc`，使词序列天然带标点后复用既有词级成句管线；拼接前 SHALL 去除词文本与标点字段的首尾空白（实测英文场景两者均可能带尾空格，直拼会与成句管线的拉丁词补空格逻辑叠出双空格）；时间戳解析 SHALL 宽容字符串与数字两种形态（实测 words 级为字符串毫秒、sentences 级为数字毫秒）。`sentences[]` SHALL 同时映射为秒级段级结果作降级兜底。多声道场景 SHALL 固定只识别首声道（`first_channel_only=true`）。

#### Scenario: 词级路径生成带标点字幕

- **WHEN** 中文视频经阿里实例转写返回 words（毫秒、含 punc 字段）
- **THEN** 词条目拼接标点并归一为秒，经本地成句管线产出多条带标点字幕，风格与其他云服务商一致

#### Scenario: 缺词级时段级兜底

- **WHEN** 某次响应的 sentences 无 words 数组
- **THEN** 以 sentences 的句级时间戳（秒）作段级结果继续成句，任务不失败

#### Scenario: 字符串毫秒时间戳宽容解析

- **WHEN** 响应中 words 级时间戳为字符串形态（如 "1010"）
- **THEN** 解析按数值宽容处理，词条目时间轴正确（1.010 秒），不因形态差异丢词

### Requirement: 阿里响应以业务 status 判定成败与重试

阿里转写 SHALL 以响应体 `status` 判定成败（HTTP 状态之外）：`20000000` 为成功；`40270002`（无有效语音）SHALL 视为空结果成功（任务不失败）；`40000001`/`403`（Token 类）走强刷重试一次后仍失败按鉴权失败终态；`40000004`（空闲超时）、`40000005`（并发超限）、`50000000/50000001/52010001`（服务端偶发）及 HTTP 429/5xx、网络错误、超时 SHALL 按指数退避有限重试；`40000003/40000009/40000010/40010001/40020105/40020106/40270001/40270003` 及未知 status SHALL 不重试并携 `status + message` 报错。连接自测 SHALL 以 1 秒静音 WAV 原始字节真实探测：`20000000` 与 `40270002` 均判通过；`40020105/40020106` 透出 appkey 不存在/与账号不匹配的可行动提示；`40000010` 透出「极速版需开通商用版（无免费试用）/账号欠费」的可行动提示。

#### Scenario: 并发超限退避重试

- **WHEN** 识别请求返回 status 40000005（并发过多）
- **THEN** 按指数退避自动重试（有限次数），不立即失败

#### Scenario: 静音探测的无有效语音判通过

- **WHEN** 连接自测发送 1 秒静音 WAV，服务端返回 40270002（无有效语音）
- **THEN** 自测判定通过（链路与凭据已验证，静音被拒识属预期）

#### Scenario: 未开通商用版的自测提示可行动

- **WHEN** 用户以有效 AccessKey 但未开通极速版商用的账号运行连接自测（status 40000010）
- **THEN** 自测失败并提示需在 NLS 控制台开通商用版（极速版无免费试用）或检查欠费，而非笼统的「连接失败」

#### Scenario: appkey 与账号不匹配可诊断

- **WHEN** 用户填入他人账号的 appkey（status 40020106）
- **THEN** 自测失败并明确提示 Appkey 与当前账号不匹配，需使用同一账号下创建的项目
