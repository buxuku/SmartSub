# Tasks: ai-thinking-mode-control

## 1. 字段定义与配置迁移

- [x] 1.1 `types/provider.ts`：新增 `FIELD_ENABLE_THINKING` 共享字段（switch，defaultValue: false，tips: `enableThinkingTips`），加入 `aiCommonFields` 与 `CONFIG_TEMPLATES.openai`（与 `FIELD_ECHO_ANCHORING` 并列）
- [x] 1.2 `main/helpers/providerManager.ts`：`CURRENT_PROVIDER_VERSION` 升至 22，`migrateProviders` 对内置 AI 服务商与自定义 openai 模板显式写入 `enableThinking: p.enableThinking === true`

## 2. 思考控制核心模块

- [x] 2.1 新建 `main/service/thinkingControl.ts`：实现 `resolveThinkingParams(provider)` 服务商感知映射表（design D2：qwen/dashscope、siliconflow → `enable_thinking: false`；volces → `thinking: {type: 'disabled'}`；ollama → `think: false`；Gemini → `reasoning_effort: 'none'`；gpt-5 → `'minimal'`；o 系 → `'low'`；deepseek 与未知服务商 → 不发参数）
- [x] 2.2 同模块实现 `isThinkingParamRejectedError(error)`（镜像 `isStructuredOutputUnsupportedError`，覆盖 unrecognized/unknown field/unsupported/invalid/not support 及中文关键词）
- [x] 2.3 同模块实现会话级拒绝缓存（`Map<providerId:modelName, true>`）：`markThinkingParamRejected` / `isThinkingParamRejected` / `clearThinkingParamRejection`（测试面板绕过用）
- [x] 2.4 型号检测收敛：模式常量与 `isThinkingOnlyModelName` 放入 `types/provider.ts`（主进程与渲染层单一来源），`thinkingControl.ts` re-export；纯思考模型跳过 L1 发参
- [x] 2.5 同模块实现 L2 软开关 `appendNoThinkSoftSwitch(systemPrompt, provider)`：L1 不可用且 modelName 匹配 `/qwen3/i` 时追加 `/no_think`

## 3. 服务层接入与硬编码收敛

- [x] 3.1 `main/service/openai.ts`：删除 `getProviderSpecificParams` 的 qwen 硬编码；接入 `resolveThinkingParams`（注入时机在自定义参数处理之前，让自定义参数覆盖，design D3）；顶层 catch 接入 `isThinkingParamRejectedError` → 写缓存 → 去参重跑完整调用（在结构化输出回退链外层，design D4）
- [x] 3.2 `main/helpers/parameterProcessor.ts`：删除 `applyHardCodedParameters` 中 qwen 默认块；`isThinkingOnlyModel` 改为从共享单一来源导入；保留自定义 `thinking` 字符串 → 厂商格式的转换特判
- [x] 3.3 `main/service/ollama.ts`：开关为关时注入顶层 `think: false`；接入拒绝判定与去参重试（兼容旧版 Ollama unknown field 错误）
- [x] 3.4 `main/service/azureOpenai.ts`：克制接入（design D9）——仅 deployment/modelName 命中 `o1/o3/o4/gpt-5` 模式时注入 `reasoning_effort`
- [x] 3.5 L2 接入：openai.ts / ollama.ts 构造 system prompt 时调用 `appendNoThinkSoftSwitch`

## 4. 测试面板反馈

- [x] 4.1 `main/translate/types`：`TranslationRequestOptions` 新增可选 `onResponseMeta` 回调；openai.ts（含 azure）与 ollama.ts 在拿到原始响应后回传 `reasoning_content` 有无、`reasoning_tokens`、ollama `message.thinking`
- [x] 4.2 `main/translate/index.ts`：`testTranslation` 注入元数据收集器，测试前清除该 provider+model 的拒绝缓存，用元数据判定并在返回值 `analysis` 中带上 `thinking_enabled`（补上既有 TODO；判定函数 `isThinkingActiveFromMeta` 收入 thinkingModeDetector）
- [x] 4.3 `renderer/components/resources/ProvidersTab.tsx`：测试结果区渲染思考状态徽标——开关为关且未检出思考 →「思考已关闭」；开关为关但检出思考 →「无法关闭思考（模型限制）」；开关为开不展示；不展示 token 数

## 5. 渲染层 UI 与文案

- [x] 5.1 `renderer/components/ProviderForm.tsx`：型号命中纯思考模型检测时，在思考模式开关下方渲染非阻断提示（开关保持可操作）；型号检测工具放在共享 `types/provider.ts`（`isThinkingOnlyModelName`），主进程与渲染层单一来源
- [x] 5.2 `renderer/public/locales/zh/translateControl.json` 与 `en/translateControl.json`：新增 `enableThinking`（思考模式）、`enableThinkingTips`、`thinkingOnlyModelHint`、`testThinkingDisabled`、`testThinkingCannotDisable`，`check:i18n` 通过

## 6. 测试与验证

- [x] 6.1 `thinkingControl` 单元测试：新增 `scripts/test-thinking-control.ts`（npm run test:thinking-control，47 项全过）——映射表各分支（id/URL/型号嗅探）、未知服务商返回空、纯思考模型跳过、拒绝判定关键词（含 axios 响应体形态）、缓存写入/命中/清除、`/no_think` 仅命中 qwen3、字段定义与迁移语义
- [x] 6.2 `parameterProcessor` 既有测试更新：三处 qwen 断言改为新优先级语义（自定义参数 > 开关派生 baseParams）；顺带修复测试文件陈旧的 `headerConfigs/bodyConfigs` 字段名与注册表 `'number'` 非法类型（改为 `float/integer`，修复了数值参数校验必失败的潜在缺陷）；全部用例通过
- [x] 6.3 迁移测试：v22 写入语义（`p.enableThinking === true` 保留、其余落 false）与字段默认值断言并入 test-thinking-control（migrateProviders 依赖 electron store，不可脱离 electron 单测）
- [ ] 6.4 手工验证清单（归档时延后：由用户真机验证）：qwen（行为零变化）、siliconflow qwen3 型号（思考关闭、速度提升）、ollama ≥0.9 与 <0.9（去参重试）、deepseek-reasoner（UI 提示）、未知自定义服务商（不发参数）、测试面板徽标两态
