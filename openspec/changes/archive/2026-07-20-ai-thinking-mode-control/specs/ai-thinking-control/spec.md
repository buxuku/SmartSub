# Spec Delta: ai-thinking-control

## ADDED Requirements

### Requirement: 思考模式开关

所有 AI 翻译服务商（内置及自定义 OpenAI 兼容模板）SHALL 提供「思考模式」开关字段 `enableThinking`（switch 类型，默认 false）。系统 SHALL 在 `enableThinking !== true`（含 undefined）时执行思考禁用逻辑；开关为 true 时 MUST 不下发任何思考相关参数（不干预，跟随模型默认行为）。

#### Scenario: 默认关闭即禁用思考

- **WHEN** 用户未触碰过思考模式开关（值为 undefined 或 false）并发起 AI 翻译
- **THEN** 系统对该服务商执行思考禁用逻辑（按映射表发参或降级）

#### Scenario: 打开开关即不干预

- **WHEN** 用户将思考模式开关置为 true 并发起 AI 翻译
- **THEN** 请求体中不包含任何由开关派生的思考控制参数

### Requirement: 服务商感知参数映射

思考禁用逻辑 SHALL 按服务商 id、apiUrl、modelName 嗅探下发对应参数：qwen/dashscope 与 siliconflow 用 `enable_thinking: false`；火山方舟 URL 用 `thinking: {type: "disabled"}`；ollama 用顶层 `think: false`；Gemini 用 `reasoning_effort: "none"`；型号命中 gpt-5 系用 `reasoning_effort: "minimal"`、o 系推理模型用 `reasoning_effort: "low"`。未命中任何映射规则的服务商（含 deepseek、DeerAPI、未知自定义服务商）MUST 不下发思考参数。

#### Scenario: qwen 下发布尔参数

- **WHEN** 通过 qwen 服务商（或 apiUrl 含 dashscope.aliyuncs.com 的自定义服务商）翻译且开关为关
- **THEN** 请求体包含 `enable_thinking: false`

#### Scenario: 火山方舟下发对象参数

- **WHEN** 通过 apiUrl 含 volces.com 的自定义服务商翻译且开关为关
- **THEN** 请求体包含 `thinking: {"type": "disabled"}`

#### Scenario: ollama 下发顶层 think 参数

- **WHEN** 通过 ollama 服务商翻译且开关为关
- **THEN** 请求体包含顶层 `think: false`

#### Scenario: 未知服务商不发参数

- **WHEN** 通过未命中映射表的自定义 OpenAI 兼容服务商翻译且开关为关
- **THEN** 请求体不包含任何思考控制参数

### Requirement: 自定义参数优先于开关

用户在「自定义参数」中显式配置的思考相关键（`enable_thinking`、`thinking`、`think`、`reasoning_effort`）SHALL 优先于开关派生参数；开关派生参数 MUST 仅在目标键未被自定义参数占用时注入。

#### Scenario: 用户显式启用思考不被覆盖

- **WHEN** 开关为关（默认），但用户在自定义参数中配置了 `enable_thinking: true`
- **THEN** 请求体中 `enable_thinking` 为 true，开关派生值不生效

### Requirement: 参数拒绝的错误驱动降级与会话缓存

思考参数被服务端拒绝（错误消息同时命中参数关键词与 unsupported/unrecognized/unknown/invalid 类关键词）时，系统 SHALL 自动去除思考参数重试一次完整调用，并将该 provider+model 组合写入主进程内存缓存；后续请求命中缓存时 MUST 直接跳过参数下发。思考参数去参重试 MUST 发生在结构化输出回退链外层。

#### Scenario: 参数被拒后去参重试成功

- **WHEN** 某服务商对含 `enable_thinking: false` 的请求返回「unrecognized request argument」类 400 错误
- **THEN** 系统去除该参数后重试，翻译成功，且该 provider+model 被写入拒绝缓存

#### Scenario: 缓存命中不再重复失败

- **WHEN** 同一翻译任务的后续批次使用已被写入拒绝缓存的 provider+model
- **THEN** 请求首次发出即不含思考参数，不再产生额外的失败往返

#### Scenario: 旧版 Ollama 未知字段兼容

- **WHEN** Ollama 旧版本对含 `think` 字段的请求返回 unknown field 类错误
- **THEN** 系统去参重试，翻译不中断

### Requirement: 提示词软开关降级

当 L1 参数路径不可用（未命中映射或已缓存拒绝）且 modelName 匹配 qwen3 系列时，系统 SHALL 向 system prompt 末尾追加 `/no_think` 软开关；其他型号 MUST 不做提示词注入。既有 `<think>` 标签输出剥离逻辑 SHALL 保持不变作为最终兜底。

#### Scenario: qwen3 系型号获得软开关

- **WHEN** 通过未知自定义服务商翻译，modelName 为 `qwen3:8b`，开关为关
- **THEN** system prompt 末尾追加 `/no_think`

#### Scenario: 非 qwen3 型号不注入

- **WHEN** 通过未知自定义服务商翻译，modelName 为 `llama3:8b`，开关为关
- **THEN** system prompt 不被追加任何软开关文本

### Requirement: 纯思考模型处理

系统 SHALL 以型号名模式（`deepseek-reasoner`、含 `thinking-`、`-reasoning` 等）检测无法关闭思考的纯思考模型：UI 在开关下方渲染非阻断提示（建议改用非思考模型），开关控件 MUST 保持可操作；运行时 MUST 跳过 L1 参数下发。

#### Scenario: deepseek-reasoner 出提示

- **WHEN** deepseek 服务商的 modelName 为 `deepseek-reasoner` 且开关为关
- **THEN** 开关下方显示「无法通过参数关闭思考，建议改用非思考模型」类提示，且请求不含思考参数

#### Scenario: 提示不锁死开关

- **WHEN** 型号命中纯思考模式检测
- **THEN** 开关仍可切换，其值正常保存

### Requirement: 测试面板思考状态反馈

服务商测试翻译 SHALL 通过响应元数据（`reasoning_content` 有无、`reasoning_tokens`、ollama `message.thinking`）判定思考是否实际发生，并在测试结果中以徽标展示：开关为关且未检出思考时显示「思考已关闭」；开关为关但检出思考时显示「无法关闭思考（模型限制）」；开关为开时 MUST 不展示徽标。徽标 MUST 不展示 token 数量。测试请求 MUST 绕过拒绝缓存以保证新鲜探测。

#### Scenario: 思考成功关闭

- **WHEN** 开关为关，测试翻译的响应无 reasoning_content 且 reasoning_tokens 为 0
- **THEN** 测试结果显示「思考已关闭」徽标

#### Scenario: 模型限制无法关闭

- **WHEN** 开关为关，测试翻译的响应含非空 reasoning_content
- **THEN** 测试结果显示「无法关闭思考（模型限制）」徽标

### Requirement: 硬编码收敛与配置迁移

系统 SHALL 移除 `openai.ts` 与 `parameterProcessor.ts` 中重复的 qwen 思考硬编码，统一由思考控制模块驱动，qwen 的默认请求参数 MUST 保持前后等价（`enable_thinking: false`）。`providerVersion` SHALL 升至 22，迁移时为所有 AI 服务商显式写入 `enableThinking`（用户已显式为 true 的保留，其余落为 false）。

#### Scenario: qwen 升级行为零变化

- **WHEN** 存量 qwen 用户升级后以默认配置发起翻译
- **THEN** 请求体与升级前一致，包含 `enable_thinking: false`

#### Scenario: v22 迁移写入默认值

- **WHEN** providerVersion 为 21 的存量配置首次在新版本启动
- **THEN** 所有 AI 服务商的 `enableThinking` 字段被显式写入且默认为 false，providerVersion 更新为 22
