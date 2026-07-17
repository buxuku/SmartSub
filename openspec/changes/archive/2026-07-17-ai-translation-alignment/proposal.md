# Proposal: AI 批量翻译条数与语义对齐

## Why

AI 批量翻译字幕时，模型经常返回与原文条数不一致的译文（尤其大批量场景），导致时间轴错位、空白字幕（issue #308 等长期反馈）。更隐蔽的是：模型会把相邻字幕合并翻译，造成译文整体"滑移"——每个键都有流畅的译文但对应错行，现有的条数校验完全无法发现。实测（2026-07 调研，见 `~/Downloads/translate/research/FINDINGS.md`）本项目现状方案（json_object + 提示词约束）在 45 条批量下条数一致率仅 37.5%，而「动态 JSON Schema 约束解码 + 回显锚定 + 单条定点补翻」管线在本地 2B 小模型上可达 100% 对齐。

## What Changes

- **动态批次 Schema**：翻译批次的 JSON Schema 由该批次的字幕 ID 动态生成（每个 ID 一个 required 属性 + `additionalProperties: false`），替换静态的 `TRANSLATION_JSON_SCHEMA`，使支持 json_schema 的渠道（ollama ≥0.5 / OpenAI / Gemini / Azure）在解码层面锁死条数。
- **回显锚定（echo anchoring）**：响应结构从 `{id: 译文}` 升级为 `{id: {src: 原文回显, tr: 译文}}`，通过回显与真实原文的相似度比对确定性地检测合并/滑移错位。默认开启（正确性优先），provider 提供关闭开关。
- **解析器双形态兼容**：值为 `{src,tr}` 对象走完整回显校验；值为纯字符串优雅降级为「条数+空值」校验（兼容用户自定义提示词）。
- **失败分级处理**（替换现有整批重试→整批报废逻辑）：解析失败或错位超过批次 1/3 → 整批重试一次；个别错位/空值 → 带上下文的单条定点补翻（±2 条原文+已译文做语境，单键 schema，最多 3 次）；补翻仍失败 → 仅该条标记失败，其余照常入库。
- **默认系统提示词升级**为 {src,tr} 协议，走既有 `HISTORICAL_DEFAULT_PROMPTS` 迁移机制（provider 版本 20 → 21）；自定义过提示词的用户在 UI 中收到更新提示。
- **Schema 规模保护**：批次超过属性数上限（100）时自动拆分，规避 Gemini 等渠道的 schema 复杂度限制。

## Capabilities

### New Capabilities

- `ai-translation-alignment`: AI 批量翻译的条数与语义对齐保证——动态批次 schema 约束、回显锚定校验、失败分级与单条定点补翻。

### Modified Capabilities

<!-- openspec/specs/ 下无翻译相关的既有 spec，翻译对齐作为新能力引入 -->

## Impact

- **主进程翻译链路**：`main/translate/services/ai.ts`（批次组装、校验、失败分级、定点补翻）、`main/translate/constants/schema.ts`（动态 schema 工厂）、`main/translate/utils/aiResponseParser.ts`（锚定解析）、新增相似度工具。
- **服务层**：`main/service/openai.ts`（json_schema 路径从 zodResponseFormat 改为原生 response_format）、`main/service/ollama.ts`、`main/service/azureOpenai.ts`（format 使用动态 schema）；`main/translate/types/index.ts`（`TranslationRequestOptions` 增加 schema 传递通道）。
- **配置与迁移**：`types/provider.ts`（默认提示词、echoAnchoring 字段）、`main/helpers/providerManager.ts`（版本迁移）。
- **UI/i18n**：`renderer/public/locales/{zh,en}/translateControl.json`、`ProvidersTab.tsx`（回显开关、自定义提示词更新提示）。
- **测试**：扩展 `scripts/test-ai-response-parser.ts`、`scripts/test-structured-output-fallback.ts`。
- **不影响**：非 AI 的 API 翻译路径（`api.ts`）、免费翻译回退链（`fallback.ts`）。
