# Design: ai-thinking-mode-control

## Context

思考/推理模式在字幕翻译场景几乎零收益但代价高昂（延迟、reasoning token 计费、思考内容内联 content 引发解析失败）。当前现状：

- `main/service/openai.ts` 的 `getProviderSpecificParams` 对 qwen/dashscope **无条件**硬编码 `enable_thinking: false`；
- `main/helpers/parameterProcessor.ts` 的 `applyHardCodedParameters` 对同一目标做了**尊重用户自定义**的版本——两处行为不一致；
- `ParameterProcessor` 注册表已有 `enable_thinking`/`thinking` 参数定义与火山（对象格式）/阿里（布尔格式）的特判，但埋在「自定义参数」专家功能里；
- `main/helpers/thinkingModeDetector.ts` 已能从响应的 `reasoning_content`/`reasoning_tokens` 判定思考是否发生，但从未接入真实链路（`testTranslation` 有 TODO）；
- `aiResponseParser.ts` 的 `<think>` 正则剥离是输出侧兜底。

各服务商关闭思考的参数互不兼容（详见 D2 映射表），且严格的服务端（OpenAI 官方等）对未知参数直接 400，不能无脑广播。

项目已有同形问题的成熟先例：`structuredOutput`（字段 + 运行时回退链 + 测试面板严格模式探测 + providerVersion 迁移），本设计大量复刻该模式。

## Goals / Non-Goals

**Goals:**

- 所有 AI 翻译服务商获得一个一等公民的思考模式开关，默认关闭（= 主动禁用思考）。
- 服务商感知的参数映射，未知服务商零风险（不发参数）。
- 参数被拒时错误驱动降级，且不逐批次重复失败。
- 纯思考模型有明确的 UI 预期管理。
- 测试面板可验证思考确实被关闭。
- 收敛两处不一致的 qwen 硬编码为单点模块。

**Non-Goals:**

- 不提供思考预算（thinking budget / reasoning effort 档位）细粒度控制——只有关/不干预两档。
- 开关打开 ≠ 强制开启思考，仅表示「不干预，跟随模型默认」，不发任何启用参数。
- 不持久化参数拒绝缓存到 store（仅主进程内存）。
- 不改动 `<think>` 正则剥离逻辑（保留为兜底）。
- 不覆盖 TTS/ASR 等非翻译 AI 链路。

## Decisions

### D1: 正语义开关 `enableThinking`，默认 false

「思考模式」开关（switch），`defaultValue: false`。运行时判定 `provider.enableThinking !== true` → 执行禁用逻辑；`undefined` 视为关闭，存量用户升级后自动获得新默认。

- 为什么不是「禁用思考」默认开：双重否定（开关开 = 功能关）心智负担高；业界聊天产品的「深度思考」开关均为正语义。
- 为什么默认关：翻译场景思考零收益高成本；qwen 已硬编码禁用且上线无投诉；dashscope 商业版服务端默认亦为关；开关直显可逆，武断默认值逃生成本低。
- 字段加入 `aiCommonFields`（与 `echoAnchoring` 并列，位于表单主体直显区，不进高级折叠区）与 `CONFIG_TEMPLATES.openai`。

### D2: 单点模块 `main/service/thinkingControl.ts` + 保守映射表

收编所有思考控制逻辑：参数映射、拒绝错误判定、会话缓存、thinking-only 型号检测（从 `parameterProcessor.ts` 迁出共享）。

映射规则（按 provider id / apiUrl / modelName 嗅探，与现有 `dashscope.aliyuncs.com`、`volces.com` URL 嗅探先例一致）：

| 命中条件                                                | 下发参数                              |
| ------------------------------------------------------- | ------------------------------------- |
| id=qwen 或 URL 含 `dashscope.aliyuncs.com`              | `enable_thinking: false`              |
| id=siliconflow 或 URL 含 `siliconflow`                  | `enable_thinking: false`              |
| URL 含 `volces.com`/`volcengine`                        | `thinking: { type: 'disabled' }`      |
| id=ollama                                               | 顶层 `think: false`                   |
| id=Gemini 或 URL 含 `generativelanguage.googleapis.com` | `reasoning_effort: 'none'`            |
| 型号匹配 `gpt-5*`                                       | `reasoning_effort: 'minimal'`         |
| 型号匹配 `o1/o3/o4` 系                                  | `reasoning_effort: 'low'`             |
| id=deepseek                                             | 不发参数（模型选择即思考选择，见 D6） |
| 其余（DeerAPI、未知自定义）                             | 不发参数（L1 跳过，零 400 风险）      |

- 为什么映射表而非广播：OpenAI 官方等严格服务端对未知参数 400；保守映射让未知服务商默认零风险。
- 为什么不用 select 让用户选参数格式：用户不应需要知道厂商参数差异，这正是本功能要消化的复杂度。

### D3: 优先级——自定义参数 > 开关 > （删除的）硬编码

开关派生参数作为「默认值」注入：仅当目标键（`enable_thinking`/`thinking`/`think`/`reasoning_effort`）未被自定义参数显式设置时生效，沿用 `applyHardCodedParameters` 的既有让位模式。同时：

- 删除 `openai.ts` `getProviderSpecificParams` 的无条件 qwen 硬编码；
- 删除 `parameterProcessor.ts` `applyHardCodedParameters` 的 qwen 默认块（行为由开关默认值取代，等价）；
- 保留 `processBodyParameters` 中自定义 `thinking` 字符串 → 厂商格式的转换特判。

qwen 行为前后等价性：旧硬编码 = 发 `enable_thinking: false`；新逻辑 = 开关默认关 → 映射表命中 dashscope → 发同一参数。用户显式配过自定义参数的，两代逻辑都让位。

### D4: 错误驱动去参重试 + 会话级拒绝缓存

新增 `isThinkingParamRejectedError(error)`（镜像 `isStructuredOutputUnsupportedError`：消息同时含参数关键词与 unsupported/unrecognized/unknown field/invalid/not support 类关键词）。

执行时序：**思考参数重试包裹在结构化输出回退链外层**。若思考参数导致 400，内层回退链会拿同一错误徒劳降级三档，故必须在 `translateWithOpenAI`/`translateWithOllama` 顶层 catch：命中拒绝判定 → 写入缓存 → 去参后重跑整个调用。

缓存：模块级 `Map<providerId:modelName, true>`，命中则 L1 直接跳过发参。生命周期 = 主进程存活期。

- 为什么必须缓存：一次翻译任务几十个批次，不缓存则每批次都吃一次 400 往返。
- 旧版 Ollama 兼容：Ollama 对未知字段返回 `json: unknown field "think"` 类错误，天然被拒绝判定捕获 → 去参重试 → 走 L2/L3。
- 测试面板须绕过/清除对应缓存项，保证「测试」永远是新鲜探测（用户可能升级了后端）。

### D5: 提示词软开关降级（L2）

当 L1 不发参数（未知服务商或已缓存拒绝）且 `modelName` 匹配 `/qwen3/i` 时，向 system prompt 末尾追加一行 `/no_think`（Qwen3 混合系列的官方软开关，其他模型视为普通文本无副作用）。不做通用的「请勿输出思考」注入——默认提示词与重试提示词已含等价指令，重复注入收益为零且改动 `defaultSystemPrompt` 会触发提示词迁移机制。

完整降级阶梯：L1 参数 → L2 `/no_think`（仅 qwen3 系）→ L3 `<think>` 正则剥离（已存在，不动）。

### D6: 纯思考模型——UI 非阻断提示 + 运行时静默跳过

`isThinkingOnlyModel` 检测（`deepseek-reasoner`、含 `thinking-`、`-reasoning` 等模式，迁入 `thinkingControl.ts`）：

- **UI**：`ProviderForm` 在开关下方渲染非阻断提示文案（如「当前模型无法通过参数关闭思考，建议改用 deepseek-chat 等非思考模型」）。不禁用开关控件——检测是启发式，误判时不能把用户锁死；且开关值需独立于当前型号保存。
- **运行时**：命中则 L1 跳过发参（避免必然的 400），L2/L3 照常。
- deepseek 特殊性：官方 API 无任何思考参数，思考与否由模型名决定（`deepseek-chat` 不思考 / `deepseek-reasoner` 必思考），故 deepseek 的「关闭思考」实质是 UI 引导换模型。

### D7: 测试面板反馈——`onResponseMeta` 回调 + 激活 `ThinkingModeDetector`

`TranslationRequestOptions` 新增可选 `onResponseMeta?: (meta) => void`，`openai.ts`（含 azureOpenai）与 `ollama.ts` 在拿到原始响应后回传 `reasoning_content` 有无、`reasoning_tokens`、（ollama 的 `message.thinking`）等字段。`testTranslation` 注入收集器，用 `ThinkingModeDetector.analyzeResponse` 判定，返回值扩展 `analysis.thinking_enabled`。

UI 徽标两态：「思考已关闭」（`thinking_enabled === false` 且开关为关）/「无法关闭思考（模型限制）」（开关为关但 `thinking_enabled === true`）。开关为开时不展示徽标。不展示 token 数。

- 为什么回调而非改返回值：translator 函数返回 string 的签名被翻译管线全链依赖，改返回结构 ripple 太大；回调侵入最小且正式翻译链路不传即零开销。

### D8: 迁移 `providerVersion` 21 → 22

`migrateProviders` 对 AI 服务商（内置 + 自定义 openai 模板）显式写入 `enableThinking: p.enableThinking === true`（即：除非用户已显式为 true，一律落为 false）。显式写入而非留空，保证配置导出/导入的可见性。回滚安全：旧版本代码读到多余字段无副作用。

### D9: azureopenai 的克制接入

Azure 部署名是用户自定义的，未必反映底层模型，型号嗅探不可靠。策略：仅当 deployment/modelName 命中 `o1/o3/o4/gpt-5` 模式时发 `reasoning_effort`，否则不发。Azure 常规模型（gpt-4o 等）本就不思考，不干预无损失。

## Risks / Trade-offs

- [升级后开始对 siliconflow/ollama 等主动发参数，个别模型/旧后端首次请求 400] → 保守映射 + thinking-only 预判 + D4 去参重试与缓存，最坏代价为每 provider+model 会话内一次额外往返。
- [拒绝缓存在用户升级后端（如 Ollama 0.8→0.9）后过期失真] → 缓存仅存活到应用重启；测试面板绕过缓存可即时重探；失真的后果仅是思考未关（功能仍正常）。
- [Gemini 2.5 Pro 等不允许完全关闭思考] → 参数被拒后自动去参，思考保持开启，测试徽标显示「无法关闭思考」做预期管理。
- [开关开 =「跟随模型默认」可能被误解为「强制开启」] → tips 文案明确两档语义。
- [DeerAPI 等聚合商完全不干预，用户以为开关失效] → tips 说明未知服务商依赖模型自身默认；qwen3 系仍有 L2 兜底。
- [`/no_think` 对非 qwen3 模型是无意义文本] → 仅在型号名匹配 qwen3 时注入，命中面精确。

## Migration Plan

1. 合并后首次启动触发 v22 迁移，AI 服务商写入 `enableThinking: false`（保留显式 true）。
2. qwen 用户行为零变化（硬编码 → 开关默认值，参数相同）；其余服务商开始按映射表发参。
3. 回滚：降级安装旧版本，多余字段被忽略；`providerVersion` 大于旧版常量时旧代码跳过迁移（`savedVersion === CURRENT` 不成立会重跑旧迁移，幂等无害）。

## Open Questions

- 无阻塞项。后续可选演进：拒绝缓存持久化、思考预算档位（reasoning effort 三档）、把测试面板探测结果写回配置（类比 structuredOutput 自动探测）。
