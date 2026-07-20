# Proposal: ai-thinking-mode-control

## Why

字幕翻译是短文本机械转换任务，推理型/混合型模型（Qwen3、GLM、doubao-seed 等）的思考模式在此场景下几乎零质量收益，代价却是 2-10 倍延迟、reasoning token 按输出计费，且思考内容内联进 content 时是 JSON 解析失败与错位修复链被触发的主要来源之一。当前项目仅对 qwen 硬编码了 `enable_thinking: false`（且两处实现行为不一致），其余服务商用户只能在「自定义参数」专家功能里手工配置，参数名/格式因厂商而异，普通用户无从下手。

## What Changes

- 为所有 AI 翻译服务商（内置 + 自定义 OpenAI 兼容模板）新增「思考模式」开关（`enableThinking`），默认关闭 = 主动禁用思考。
- 新增服务商感知的思考参数映射层：按服务商 id / URL / 型号嗅探下发正确的关闭参数（`enable_thinking: false`、`thinking: {type: "disabled"}`、`think: false`、`reasoning_effort` 等），未知服务商不发参数。
- 新增错误驱动降级：关闭参数被服务端拒绝（400 类）时自动去参重试一次，并在会话内缓存该 provider+model 的失败结果，避免逐批次重复失败。
- 新增提示词软开关降级：参数路径不可用且型号为 qwen3 混合系列时，向提示词追加 `/no_think`。
- 纯思考模型（`deepseek-reasoner`、`*-thinking-*` 等）UI 出非阻断提示并在运行时跳过发参。
- 服务商测试面板展示思考状态徽标（「思考已关闭」/「无法关闭思考（模型限制）」），通过响应元数据回调 + 既有 `ThinkingModeDetector` 实现。
- 收敛清理：删除 `openai.ts` 与 `parameterProcessor.ts` 两处重复且不一致的 qwen 硬编码，统一为单点思考控制模块；自定义参数中的思考相关配置优先于开关。
- `providerVersion` 21 → 22 迁移：为 AI 服务商显式写入 `enableThinking: false`（qwen 用户行为零变化，其余服务商升级后获得新默认）。
- 现有 `<think>` 标签正则剥离保持不变，作为最终兜底。

## Capabilities

### New Capabilities

- `ai-thinking-control`: AI 翻译请求的思考模式控制——开关语义与默认值、服务商感知参数映射、错误驱动去参重试与会话缓存、提示词软开关降级、纯思考模型处理、与自定义参数的优先级、测试面板思考状态反馈、配置迁移。

### Modified Capabilities

（无 —— `ai-translation-alignment` 等既有能力的需求不变；`<think>` 剥离本就不属于任何 spec 的需求层面。）

## Impact

- **类型与配置**：`types/provider.ts`（新增 `FIELD_ENABLE_THINKING` 共享字段并加入 `aiCommonFields` 与 openai 模板）、`main/helpers/providerManager.ts`（v22 迁移）。
- **主进程服务层**：新增 `main/service/thinkingControl.ts`（参数映射 + 拒绝判定 + 会话缓存 + thinking-only 型号检测收编）；`main/service/openai.ts`、`main/service/ollama.ts`、`main/service/azureOpenai.ts` 接入；`main/helpers/parameterProcessor.ts` 删除 qwen 硬编码块、复用共享检测。
- **翻译管线**：`main/translate/types`（`TranslationRequestOptions` 增加 `onResponseMeta` 回调）、`main/translate/index.ts`（`testTranslation` 补上 thinking 分析 TODO）。
- **渲染层**：`renderer/components/ProviderForm.tsx`（纯思考模型内联提示）、`renderer/components/resources/ProvidersTab.tsx`（测试结果徽标）、`renderer/public/locales/{zh,en}/translateControl.json`（新增文案）。
- **休眠代码激活**：`main/helpers/thinkingModeDetector.ts` 首次接入真实链路。
