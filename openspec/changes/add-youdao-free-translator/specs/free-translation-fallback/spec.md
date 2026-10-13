# Spec Delta: free-translation-fallback

## ADDED Requirements

### Requirement: 回退链源集合与顺序执行

自动免费翻译（`autoFree`）SHALL 按可配置的有序回退链依次尝试免费源，支持的源为 `youdaoFree`、`bingFree`、`googleFree`、`deeplx`。链中的 `autoFree` 自身与未知 id MUST 被跳过并记入错误列表，避免递归与无效配置拖垮整条链。服务商表单中链编辑器可添加的源集合 MUST 与上述支持集合一致，并允许添加、移除与调整顺序。

#### Scenario: 按链顺序尝试

- **WHEN** 链为 `youdaoFree,bingFree` 且有道成功返回
- **THEN** 结果来自有道，必应不被调用

#### Scenario: 自身与未知源被跳过

- **WHEN** 链中含有 `autoFree` 或未知 id
- **THEN** 这些项被跳过并记入错误列表，其余源照常按序尝试

#### Scenario: 链编辑器可选有道

- **WHEN** 用户在 `autoFree` 的链编辑器中查看可添加的源
- **THEN** 可看到有道免费翻译，并可添加、移除、上移与下移

### Requirement: 默认回退链

全新安装时 `autoFree` 的默认 `fallbackChain` SHALL 为 `youdaoFree,bingFree,googleFree,deeplx`；运行时服务商配置未提供 `fallbackChain` 时 MUST 使用同一默认顺序。`autoFree` 的批量大小、并发与请求间隔默认值 MUST 保持不变，使必应与谷歌源的请求形态不因本变更而改变。

#### Scenario: 全新安装的默认链

- **WHEN** 用户首次启动应用并查看 `autoFree` 的回退链
- **THEN** 顺序为 有道免费 → 必应免费 → 谷歌免费 → DeepLX

#### Scenario: 缺失字段时使用默认顺序

- **WHEN** 运行时 `autoFree` 配置不含 `fallbackChain`
- **THEN** 按 `youdaoFree,bingFree,googleFree,deeplx` 尝试

#### Scenario: 其它性能默认值不变

- **WHEN** 对比升级前后 `autoFree` 的字段默认值
- **THEN** 批量大小 10、并发 1、请求间隔 0.3 秒、每分钟最大请求数 0 保持不变

### Requirement: 失败切换与跳过语义

某源抛出错误、返回条数与输入不等或全部为空时，系统 MUST 切换到链中的下一个源并重新翻译整个批次。不可用的源（如缺少端点的 `deeplx`）与不支持当前语种的源（错误含 `not supported language`）MUST 被切换跳过而不终止整条链；处于快速失效冷却期的 `youdaoFree` MUST 被立即跳过，不发出网络请求。所有源均失败时，系统 MUST 抛出带 `(network)` 标记并汇总各源原因的错误，避免被判定为配置错误而中止整个任务。任务取消 MUST 立即终止整条链，不再尝试后续源。成功命中非首位的源时 SHALL 记录一条回退日志。

#### Scenario: 首源失败回退到下一源

- **WHEN** 有道抛出 `(network)` 错误而必应成功
- **THEN** 返回必应的结果，并记录已回退到 `bingFree`

#### Scenario: 条数不等视为失败

- **WHEN** 某源返回的条数与输入不一致
- **THEN** 该结果被丢弃，链切换到下一个源

#### Scenario: 不支持的语种切换到下一源

- **WHEN** 源语言为土耳其语，有道抛出 `not supported language`
- **THEN** 链切换到必应并以必应的结果完成翻译，不记为有道服务故障

#### Scenario: 冷却期内的有道被立即跳过

- **WHEN** 有道处于快速失效冷却期时发起一个批次
- **THEN** 不向有道发出请求，直接尝试必应

#### Scenario: 全部源失败

- **WHEN** 链中所有源都失败
- **THEN** 抛出以 `All free translation sources failed (network)` 开头的错误，并列出各源失败原因

#### Scenario: 任务取消终止整条链

- **WHEN** 在某一源执行过程中任务被取消
- **THEN** 立即以任务取消错误结束，不尝试链中后续源

### Requirement: 升级迁移

服务商配置迁移 SHALL 随服务商版本号递增执行一次：为已有用户补齐 `youdaoFree` 服务商，并将其纳入免费源的默认请求间隔补齐；`autoFree` 的 `fallbackChain` 仅当（忽略空白后）恰好等于历史默认值 `bingFree,googleFree,deeplx` 时才更新为新默认链，其它任何取值（自定义顺序、增删源）MUST 原样保留。本变更涉及的迁移步骤 MUST 幂等：对迁移结果再次执行迁移，免费源（`autoFree`、`youdaoFree`、`bingFree`、`googleFree`）的配置不再变化。迁移整体不是幂等的，这是既有行为（例如火山、Azure 的批量大小每次迁移都会被重设），不在本变更范围内。迁移 MUST NOT 修改 `autoFree` 的批量大小、并发与请求间隔。

#### Scenario: 未自定义的旧默认链被更新

- **WHEN** 升级前 `autoFree.fallbackChain` 为 `bingFree,googleFree,deeplx`
- **THEN** 迁移后为 `youdaoFree,bingFree,googleFree,deeplx`

#### Scenario: 自定义链原样保留

- **WHEN** 升级前 `autoFree.fallbackChain` 为 `googleFree,bingFree`
- **THEN** 迁移后保持 `googleFree,bingFree`，不自动插入有道

#### Scenario: 补齐有道服务商

- **WHEN** 升级前的服务商列表不含 `youdaoFree`
- **THEN** 迁移后列表包含使用默认字段的 `youdaoFree`，其余服务商配置不变

#### Scenario: 迁移幂等

- **WHEN** 对迁移结果再次执行迁移
- **THEN** `autoFree`、`youdaoFree`、`bingFree`、`googleFree` 的配置与第一次迁移后完全相同

#### Scenario: 性能字段不被改动

- **WHEN** 迁移 `autoFree` 配置
- **THEN** 其批量大小、并发与请求间隔保持用户原值
