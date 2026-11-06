# Spec Delta: google-free-translation

## ADDED Requirements

### Requirement: 双通道结构与固定顺序

`googleFree` SHALL 在内部由两条通道组成：chrome 通道（`GET https://translate.googleapis.com/translate_a/t`，`client=dict-chrome-ex`，一个请求可带多个条目）与 gtx 通道（`GET https://translate.googleapis.com/translate_a/single`，`client=gtx`，一个请求一个条目）。每个块 MUST 先尝试 chrome 通道；仅当该通道不可用（冷却中或探测被占用）或本块在该通道失败时，才 MUST 改用 gtx 通道。通道顺序 MUST 是内部常量：服务商 id、字段、默认值与服务商版本号 MUST 保持不变，系统 MUST NOT 提供用户可见的通道选择。无论由哪条通道完成翻译，翻译函数的契约 MUST 一致：返回与输入等长的数组，条目内部的换行原样保留。

#### Scenario: chrome 健康时 gtx 零请求

- **WHEN** chrome 通道对一批 5 条文本返回合法响应
- **THEN** 结果来自 chrome 通道，gtx 通道没有收到任何请求

#### Scenario: chrome 被限时本块改走 gtx

- **WHEN** chrome 通道返回 429 与异常流量页，且 gtx 通道成功
- **THEN** 本块由 gtx 通道逐条完成，返回与输入等长的数组

#### Scenario: 条目内换行保留

- **WHEN** 某条文本为 `Hello\nWorld`
- **THEN** 返回数组中对应条目仍是一个字符串且保留换行，两条通道都是如此

#### Scenario: 服务商定义不变

- **WHEN** 对比变更前后的 `googleFree` 服务商定义
- **THEN** 批量大小 5、并发 1、请求间隔 0.5 秒、每分钟最大请求数 0 保持不变，没有新增字段或新服务商

### Requirement: chrome 通道的请求格式

chrome 通道的每个请求 MUST 是对 `https://translate.googleapis.com/translate_a/t` 的 GET，查询参数包含 `client=dict-chrome-ex`、`sl`、`tl`，以及每个待翻译条目一个重复出现的 `q` 参数，MUST NOT 序列化为 `q[]`。查询串中的文本 MUST 经百分号编码。单个条目 MUST 在发送前截断到 5,000 字符；空串与全空白条目 MUST NOT 发送，并 MUST 原样放回原位置；整批全是空白时 MUST NOT 发出任何请求。源语言映射为空时 `sl` MUST 为 `auto`。

#### Scenario: 整批一个请求

- **WHEN** 一批 5 条非空文本被翻译
- **THEN** 发出 1 个请求，其 URL 含 5 个 `q=` 且不含 `q[]`

#### Scenario: 特殊字符被正确编码

- **WHEN** 文本含 `&`、`#`、`+`、`%`、换行与 emoji
- **THEN** 假服务按查询串解码得到的每个 `q` 与原文逐字一致

#### Scenario: 空白条目原位还原

- **WHEN** 批内第 2 条是空串
- **THEN** 请求中不含该条，返回数组的第 2 项仍是空串，其余条目的译文位置不错位

#### Scenario: 整批空白零请求

- **WHEN** 批内所有条目都是空串或全空白
- **THEN** 不发出任何请求，返回与输入相同的数组

#### Scenario: 超长条目截断

- **WHEN** 单个条目有 6,000 个字符
- **THEN** 发送的 `q` 内容是该条的前 5,000 个字符

### Requirement: chrome 通道的切块

一个 chrome 请求的编码后查询串（含 `client`、`sl`、`tl`）MUST NOT 超过 6,000 字节，且 `q` 参数 MUST NOT 超过 50 个；超出时 MUST 按原顺序切成多个块，每块一个请求、一次限速申请，结果按原顺序拼接。单个条目编码后本身超过预算时 MUST 单独成块，MUST NOT 被拆开。

#### Scenario: 行数上限

- **WHEN** 一批 120 条短文本被翻译
- **THEN** 发出 3 个请求，分别含 50、50、20 个 `q`，结果顺序与输入一致

#### Scenario: 字节预算

- **WHEN** 一批 20 条文本，每条编码后约 2,500 字节
- **THEN** 每块含 2 条、共 10 个请求，每个请求的查询串不超过 6,000 字节

#### Scenario: 超长单条单独成块

- **WHEN** 某条文本编码后约 7,000 字节
- **THEN** 该条单独占一个请求，不被拆分，其余条目照常分块

### Requirement: chrome 通道的响应解析与对齐

chrome 响应 MUST 是长度等于本块 `q` 个数的数组；每个元素 MUST 是字符串（显式 `sl`），或首元素为字符串的数组（`sl=auto` 时附带检测到的语言），两种形状都 MUST 被接受。长度不符、元素形状不符，或任何一项译文为空（空串或全空白），MUST 被视为 chrome 通道在本块失败并计入该通道的失败计数，该块 MUST 改走 gtx 通道；系统 MUST NOT 返回该块的部分 chrome 结果。唯一的例外是仅因译文为空而被拒绝的块：系统 MUST 在 chrome 通道内用相同的请求把该块重发一次，且仅一次；重发得到有效响应则 MUST 使用它，且这一块不算失败；重发的响应仍被拒绝、或重发的请求本身失败，则按上述规则处理，且该块在 chrome 通道上最多计一次失败。长度不符与元素形状不符 MUST NOT 重发。重发 MUST 与其它请求一样先 `acquire`、响应取消，且 MUST NOT 产生额外日志。译文 MUST NOT 被二次改写。

#### Scenario: 显式源语言的字符串数组

- **WHEN** 请求带显式 `sl` 且响应为 `["译文一","译文二"]`
- **THEN** 两条译文按顺序填回对应条目

#### Scenario: 自动检测的数组对形状

- **WHEN** 请求的 `sl` 为 `auto` 且响应为 `[["译文一","en"],["译文二","en"]]`
- **THEN** 取每个元素的首项作为译文，检测语言被忽略

#### Scenario: 条数不符

- **WHEN** 发出 5 个 `q` 而响应数组只有 4 项
- **THEN** 该块的 chrome 结果被整体丢弃，改由 gtx 通道逐条完成，chrome 通道的失败计数加 1

#### Scenario: 形状异常

- **WHEN** 响应是 HTTP 200，但内容是 HTML 页面或 JSON 对象
- **THEN** 视为协议异常，该块改走 gtx 通道，chrome 通道的失败计数加 1

#### Scenario: 全部译文为空

- **WHEN** 本块 3 个非空输入对应的译文都是空串，重发的响应同样全空
- **THEN** 共发出 2 个 chrome 请求后视为协议异常，该块改走 gtx 通道，chrome 通道的失败计数加 1

#### Scenario: 部分译文为空，重发后恢复

- **WHEN** 本块 20 个非空输入中有 8 项译文是空串或全空白，其余 12 项正常；同样的请求重发一次，响应的 20 项都正常
- **THEN** 使用重发的响应，不使用首次响应里的任何一项；该块不改走 gtx 通道，chrome 通道的失败计数不变，共 2 个 chrome 请求、0 个 gtx 请求，且不产生额外日志

#### Scenario: 重发后仍有空项

- **WHEN** 首次响应与重发的响应都含空项
- **THEN** 不再重发；该块改走 gtx 通道，chrome 通道的失败计数只加 1（不是 2）；gtx 通道也失败时，调用以 `(network)` 错误失败，不返回带空行的结果

#### Scenario: 条数或形状不符不重发

- **WHEN** 响应条数不符，或形状异常
- **THEN** 只发出 1 个 chrome 请求，该块直接改走 gtx 通道

#### Scenario: 重发遵守限速与取消

- **WHEN** 首次响应含空项，重发尚未发出
- **THEN** 重发与其它请求一样先 `acquire`；此时任务被取消则不再发出重发请求，调用以任务取消错误结束，不计入通道失败

#### Scenario: 探测中的重发属于同一次探测

- **WHEN** 冷却结束后的探测请求得到含空项的响应，重发的响应正常
- **THEN** 通道恢复，只记一条「recovered」日志；若重发仍含空项，则这次探测算失败，通道再冷却 120 秒，退避等级不变

#### Scenario: 不可译的行返回原文是有效答案

- **WHEN** 本块含 `♪`、`...`、`{\an8}` 这类无法翻译的行，响应对它们返回原文
- **THEN** 这些项是有效译文，不触发回退

### Requirement: 通道健康与冷却

每条通道 SHALL 在进程内独立维护健康状态，不落盘、不跨进程。被限（HTTP 429 或 403，且响应体含 `unusual traffic`、`automated queries` 或 `/sorry/` 之一，不区分大小写）MUST 立即冷却：首次 10 分钟，之后每次再被限（含探测失败）翻倍，上限 60 分钟。其它失败（网络错误、超时、不含上述标记的 4xx / 5xx、协议异常）连续 3 次 MUST 进入 120 秒冷却，探测失败 MUST 再冷却 120 秒。一次成功 MUST 清零该通道的失败计数与退避等级。任务取消与目标语言映射失败 MUST NOT 计入失败。冷却结束后 MUST 只放行一个探测请求；探测进行时，该通道对其它并发调用 MUST 视为不可用；探测占用 MUST 在探测结束或被取消时释放。

#### Scenario: 被限立即冷却

- **WHEN** chrome 通道返回 429，响应体含「unusual traffic」
- **THEN** 该通道立即冷却 10 分钟，期间不再收到请求

#### Scenario: 退避翻倍并封顶

- **WHEN** 冷却结束后的探测再次被限
- **THEN** 冷却依次为 20、40、60 分钟，之后保持 60 分钟

#### Scenario: 无标记的 429 不触发长冷却

- **WHEN** 通道返回不含异常流量页标记的 429
- **THEN** 按其它失败计数，连续 3 次才进入 120 秒冷却

#### Scenario: 其它失败连续 3 次冷却

- **WHEN** 通道连续 3 次请求超时
- **THEN** 该通道冷却 120 秒

#### Scenario: 冷却结束只放行一个探测

- **WHEN** 冷却结束后两个并发调用同时到来
- **THEN** 只有一个调用向该通道发出探测请求，另一个视该通道不可用

#### Scenario: 探测成功即恢复

- **WHEN** 探测请求成功
- **THEN** 失败计数与退避等级清零，该通道恢复为优先使用

#### Scenario: 取消与语言错误不计入

- **WHEN** 任务在请求进行中被取消，或目标语言无法映射
- **THEN** 通道的失败计数不变，探测占用被释放

#### Scenario: 状态不持久化

- **WHEN** 进程重启
- **THEN** 两条通道都从没有冷却的初始状态开始

### Requirement: 块级切换与失败汇总

一个块在某条通道失败时 MUST 立即改用另一条通道，每块最多切换一次、不循环。两条通道都失败时，整个调用 MUST 以 `Google free translate failed (network): …` 失败，MUST NOT 返回部分结果。一个块开始时若两条通道都处于冷却或探测占用，MUST NOT 发出任何网络请求并 MUST 立即失败，错误信息含剩余冷却秒数。通道状态 MUST 按块更新，使同一次调用中后续的块能立即绕开刚失败的通道。

#### Scenario: 同一次调用内混合通道

- **WHEN** 一次调用分 3 块：第 1 块 chrome 成功，第 2 块 chrome 被限、gtx 成功，第 3 块开始时 chrome 仍在冷却
- **THEN** 第 3 块不向 chrome 发请求而直接走 gtx，三块结果按原顺序拼接

#### Scenario: 两条通道都失败

- **WHEN** 同一个块在 chrome 与 gtx 上都失败
- **THEN** 调用以 `Google free translate failed (network)` 开头的错误失败，不返回部分结果

#### Scenario: 两条通道都在冷却时零请求

- **WHEN** 一个块开始时 chrome 与 gtx 都在冷却
- **THEN** 不发出任何网络请求，立即失败，错误信息含剩余冷却秒数

### Requirement: 可用性自省与回退链集成

`googleFree` 模块 SHALL 导出 `getGoogleFreeAvailability()`：仅当两条通道都不可用（冷却中或探测占用）时返回 `available: false`，并给出 `retryAfterMs`（两条通道剩余冷却中较小者，探测占用时为 0）；否则返回 `available: true`。自动免费翻译（`autoFree`）MUST 在谷歌不可用时跳过 `googleFree`：不发出请求、不计为失败，并以 info 级别记录跳过原因；谷歌恢复后 MUST 重新参与回退链。

#### Scenario: 一条通道可用即可用

- **WHEN** chrome 在冷却而 gtx 可用
- **THEN** `getGoogleFreeAvailability()` 返回 `available: true`

#### Scenario: 两条都冷却时不可用

- **WHEN** chrome 与 gtx 都在冷却，剩余时间分别为 300 秒与 120 秒
- **THEN** 返回 `available: false` 且 `retryAfterMs` 约为 120,000

#### Scenario: autoFree 跳过冷却中的谷歌

- **WHEN** 谷歌两条通道都在冷却，回退链为 `googleFree,deeplx`
- **THEN** 不向谷歌发出请求，info 日志记录 `autoFree skip googleFree`，链继续尝试下一个源

#### Scenario: 恢复后重新参与

- **WHEN** 冷却结束且探测成功
- **THEN** 后续批次的回退链重新尝试谷歌

### Requirement: 限速、超时与取消

两条通道 MUST 共用限速键 `googleFree:<providerId>`（`providerId` 取服务商配置的 `id`，缺省为 `googleFree`），每个 HTTP 请求（chrome 一块、chrome 空项重发、gtx 一条、探测、切换后的重发）发出前 MUST 先 `acquire`；`windowMaxRequests` 按请求数而不是按行数计。chrome 通道的请求超时 MUST 为 15 秒；gtx 通道的超时 MUST 保持现有取值。请求 MUST 使用与现状相同的 `axios`（自动跟随全局代理）与同一个 UA，MUST NOT 新增请求头。取消信号 MUST 贯穿请求与限速等待。

#### Scenario: 两条通道共用限速键

- **WHEN** 同一个服务商先后通过 chrome 与 gtx 发出请求
- **THEN** 两类请求都经过同一个限速键的 `acquire`，相邻请求间隔不小于配置的请求间隔

#### Scenario: chrome 通道超时 15 秒

- **WHEN** chrome 通道的请求发出
- **THEN** 其超时配置为 15,000 毫秒，gtx 通道请求仍使用全局超时

#### Scenario: 取消立即中止

- **WHEN** 任务在限速等待或请求进行中被取消
- **THEN** 立即以任务取消错误结束，不再发出后续请求

### Requirement: 错误分类与语言映射

运行期失败的错误消息 MUST 以 `Google free translate failed (network): ` 开头，使其不被 `isConfigurationError` 判为配置错误。目标语言无法映射 MUST 在发出任何请求之前抛出 `not supported language`；源语言映射为空 MUST 使用 `auto`；系统 MUST NOT 把未经映射表校验的语言码发给服务端。错误消息 MUST NOT 包含字幕原文或响应体。

#### Scenario: 被限的错误不会中止整个任务

- **WHEN** 两条通道都因 429 或 403 失败
- **THEN** 抛出的错误以 `Google free translate failed (network)` 开头，且 `isConfigurationError` 判定为 false

#### Scenario: 不支持的目标语言零请求

- **WHEN** 目标语言在映射表中为 `null`
- **THEN** 抛出 `not supported language`，两条通道都没有收到请求

#### Scenario: 无源语言时自动检测

- **WHEN** 源语言为空
- **THEN** 请求的 `sl` 为 `auto`，响应按 `[译文, 检测语言]` 形状解析

### Requirement: 克制与隐私

系统 MUST NOT 轮换 `client` 标识、代理或 User-Agent，MUST NOT 伪造指纹，MUST NOT 绕过异常流量页或验证码。日志 MUST NOT 记录请求 URL、字幕原文、译文或响应体，仅记录通道 id、状态类别（blocked / failure）、冷却秒数、恢复，以及块数与条数；通道状态每发生一次变化 MUST 只记一条日志（进入冷却为 warning，恢复为 info），不得按批次重复。

#### Scenario: 请求参数只有两种 client

- **WHEN** 检查一次完整翻译中发出的所有请求
- **THEN** `client` 只有 `gtx` 与 `dict-chrome-ex` 两种取值，User-Agent 始终是同一个字符串

#### Scenario: 日志不含文本与 URL

- **WHEN** 翻译含有标志性文本的字幕并触发一次通道冷却
- **THEN** 日志与错误信息中不出现该文本、译文、请求 URL 或响应体

#### Scenario: 状态变化只记一条

- **WHEN** chrome 通道进入冷却后的 10 分钟内发出 20 个批次
- **THEN** 日志里只有一条「进入冷却」记录，批次不重复刷屏
