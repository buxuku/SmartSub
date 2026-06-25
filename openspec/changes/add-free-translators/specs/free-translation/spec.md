## ADDED Requirements

### Requirement: 免 Key 免费翻译源

系统 SHALL 提供无需用户配置任何 API Key 即可使用的免费翻译源：`bingFree`（Bing/Edge 免费接口）与 `googleFree`（Google 免费接口）。这些源 MUST 注册进翻译 provider 映射，并以 `isAi:false` 走 API 批量翻译流程；UI MUST 将其归入 `free` 分组。

#### Scenario: 未配置任何 Key 使用 Bing 免费翻译

- **WHEN** 用户未填写任何凭据，选择 `bingFree` 翻译一段字幕
- **THEN** 系统成功返回译文，且全程不要求 API Key

#### Scenario: 免费源出现在 free 分组

- **WHEN** 用户打开翻译 provider 选择界面
- **THEN** `bingFree` 与 `googleFree` 出现在"免费"分组中

### Requirement: 批量结果数量与输入对齐

免费翻译源 SHALL 接收 `string[]` 输入并返回**等长** `string[]`，使每条译文与原字幕时间轴一一对应。当某条原文包含换行（多行字幕合并）时，源 MUST 仍返回单条对应译文而不拆分条数。

#### Scenario: 批量翻译返回等长数组

- **WHEN** 传入包含 N 条字幕的批次
- **THEN** 返回的译文数组长度严格等于 N

#### Scenario: 多行原文不破坏条数对齐

- **WHEN** 某条字幕内容为多行（含 `\n`）
- **THEN** 该条仍映射为结果数组中的单个元素

### Requirement: Bing 匿名令牌生命周期管理

`bingFree` 源 SHALL 自动获取并缓存 Bing 的匿名访问令牌，无需用户参与。令牌接近过期或被服务端拒绝（401/403）时，系统 MUST 自动重新获取一次令牌并重试该请求。

#### Scenario: 令牌过期后自动续期

- **WHEN** 缓存的匿名令牌已过期且发起新一批翻译
- **THEN** 系统自动重新获取令牌并成功完成翻译，对用户透明

### Requirement: 客户端限速

系统 SHALL 提供按 provider 维度的客户端限速能力，至少支持"最小请求间隔"，并可选支持"滑动窗口内最大请求数"。免费源在每次真实网络请求前 MUST 经过限速器节流。限速参数 SHALL 可由 provider 配置（复用现有 `requestInterval`）。

#### Scenario: 请求间隔被强制执行

- **WHEN** 配置了最小请求间隔且连续发起多次翻译请求
- **THEN** 相邻请求的实际发出时间间隔不小于配置值

#### Scenario: 窗口配额用尽时等待

- **WHEN** 配置了滑动窗口最大请求数且窗口内配额已用尽
- **THEN** 后续请求被延迟到最早记录过期后才发出，而非立即失败

### Requirement: 多源失败自动回退

系统 SHALL 提供聚合翻译源 `autoFree`，按用户可配置的有序回退链依次尝试底层免费源。当当前源失败或被限流时，系统 MUST 自动切换到链中的下一个源；仅当链中所有源都失败时，该批次才判定为失败。回退链中不可用的源（如缺少端点的 DeepLX）MUST 被自动跳过而不计为失败。

#### Scenario: 首选源失败后回退成功

- **WHEN** 回退链为 `[bingFree, googleFree, deeplx]` 且 `bingFree` 请求失败
- **THEN** 系统自动改用 `googleFree` 并成功返回译文

#### Scenario: 跳过未配置的源

- **WHEN** 回退链包含 `deeplx` 但用户未填写 DeepLX 端点
- **THEN** 系统跳过 `deeplx` 继续尝试链中其余源，不因其缺配置而中断

#### Scenario: 全部源失败才判失败

- **WHEN** 回退链中所有源均请求失败
- **THEN** 该批次返回失败，由上层批级重试/降级逻辑处理

### Requirement: 免 Key 源不触发缺 Key 配置错误

对于无需凭据的免费源，系统 MUST NOT 因"缺少 API Key"而抛出配置错误中断翻译。可恢复错误（网络错误、429、5xx、空解析结果）SHALL 触发回退或批级重试，而非直接终止任务。

#### Scenario: 免费源缺 Key 不报配置错误

- **WHEN** 选择 `bingFree`/`googleFree` 且未提供任何 Key
- **THEN** 翻译正常进行，不出现"配置不完整"类错误
