# Design: AI 批量翻译条数与语义对齐

## Context

当前 AI 批量翻译流程：`handleAIBatchTranslation`（`main/translate/services/ai.ts`）把批次组装成 `{id: 原文}` JSON 渲染进 prompt，以字符串传给 service 层翻译器（openai/ollama/azureOpenai），响应经 `parseAITranslationResponse` 解析后校验条数（#308），不一致则整批重试，重试耗尽整批标记失败。

结构性缺陷有三：

1. **schema 是静态的**：`TRANSLATION_JSON_SCHEMA` 只有 `additionalProperties`，没有枚举 required 键。根因是「知道批次 ID 的层（ai.ts）」与「构造 schema 的层（service 层）」分离，翻译器签名只传不透明 prompt 字符串，schema 无法按批次生成。
2. **条数对齐 ≠ 语义对齐**：模型合并相邻字幕导致译文滑移时，键上仍有"流畅译文"，条数校验无感。实测 deepseek-r1:7b 在 45 条批量下 60% 条目发生隐形合并/滑移。
3. **失败处理粒度过粗**：个别条目异常导致整批重试（浪费 token 且不保证收敛），最终整批报废。

调研与实测数据（4 轮实验、约 350 次批量调用、覆盖本地 2B/7B 与云端 gpt-4o-mini/deepseek-v3）见 `~/Downloads/translate/research/FINDINGS.md`。

可复用的既有基建：`structuredOutputFallback.ts` 回退链（json_schema→json_object→disabled）、`strictStructuredOutput` 探测模式、`HISTORICAL_DEFAULT_PROMPTS` 提示词迁移机制、脚本化测试框架。

## Goals / Non-Goals

**Goals:**

- 支持 json_schema 的渠道：条数在解码层面锁死（键集合 = 批次 ID 集合）。
- 所有 AI 渠道（含 json_object 降级）：合并/滑移错位可被确定性检测并定点修复。
- 失败粒度从「整批」细化到「单条」，单条失败不再污染整批。
- 兼容用户自定义提示词（优雅降级）与不支持 schema 的渠道（回退链不变）。

**Non-Goals:**

- 不改造非 AI 的 API 翻译路径（`api.ts`）与免费翻译回退链。
- 不引入两段式翻译（Vimeo 方案：自由翻译→重切分）——成本翻倍且第二段仍是概率性的。
- 不追求译文质量本身的提升（术语表、反思翻译等已有/另行迭代）。

## Decisions

### D1: schema 传递通道——`TranslationRequestOptions.responseJsonSchema`

`ai.ts` 组装批次时构造动态 schema，经 `options` 传给翻译器；service 层优先使用传入 schema，未传时沿用现状（向后兼容）。

- 备选 A（传 batchIds 让 service 层自建 schema）：让 service 层理解「字幕批次」概念，职责泄漏，且 echo 开关逻辑要在多个 service 重复。弃。
- 备选 B（重构翻译器签名传结构化 batch）：影响面大（16 个翻译器实现），收益与 options 通道相同。弃。

### D2: 动态 schema 工厂 `makeBatchSchema(ids, { echo })`

位于 `main/translate/constants/schema.ts`。echo 形态：

```ts
{ type: 'object',
  properties: { [id]: { type: 'object',
    properties: { src: { type: 'string' }, tr: { type: 'string' } },
    required: ['src', 'tr'], additionalProperties: false } },
  required: ids, additionalProperties: false }
```

非 echo 形态为 `{ [id]: { type: 'string' } }`。保留静态 `TRANSLATION_JSON_SCHEMA` 供未传 schema 的调用方（如校对功能）继续使用。

### D3: openai.ts json_schema 路径改用原生 response_format

动态键 schema 无法用 zod 静态表达，`zodResponseFormat(TranslationResultSchema)` 改为直接构造 `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`，走 `chat.completions.create`。zod 依赖与 `TranslationResultSchema` 保留给其他调用方；回退链行为不变（json_schema 任何失败仍降级 json_object）。

### D4: 回显锚定默认全开，provider 级开关

**用户已拍板：默认全开。** 理由：正确性优先，字幕输出 token 成本低；实测回显本身还抑制合并倾向（gemma2 91 条批量回显全对齐）。provider 增加 `echoAnchoring` 布尔字段（默认 true），关闭后退回非 echo 动态 schema + 条数/空值校验。

### D5: 解析器双形态兼容

`parseAITranslationResponse` 升级：值为 `{src, tr}` 对象 → 提取双字段做回显校验；值为纯字符串 → 降级为无回显模式（仅条数+空值校验）。保证自定义提示词（旧 `{id: 译文}` 协议）的用户不炸。**用户已拍板：对这批用户在 UI 提示更新提示词**（provider 设置页检测到自定义提示词且不含 src/tr 协议时展示提示条）。

### D6: 回显相似度判定

归一化（去标点空白、小写）后计算编辑相似度，阈值 0.75；无现成依赖（repo 无 lev/diff 库），自实现 ~30 行 Levenshtein 于 `main/translate/utils/similarity.ts`。批次内逐条比对为 O(n·len²)，91 条毫秒级，无性能顾虑。

### D7: 失败分级

```
解析失败 / 错位条目 > 批次 1/3  → 整批重试一次（复用现有 retry 循环，计入 translateRetryTimes）
个别错位 / 空值               → repairEntry(): ±2 条原文+已译文做上下文，
                                单键 schema 锁输出，最多 3 次
补翻仍失败                    → 仅该条 targetContent 标记 [翻译失败]，其余照常入库
```

补翻提示词要点（实验教训）：上下文必须标注「仅作参考勿翻译」，翻译目标单独引用，否则小模型会翻错对象。

### D8: schema 规模保护

**用户已拍板：按建议来。** 批次条数超过 100 时在 `createTranslationBatches` 后自动二次拆分（schema 属性数上限 100），规避 Gemini 等渠道的 schema 复杂度限制；UI 的 batchSize tips 同步说明。

### D9: 提示词迁移

`defaultSystemPrompt` 升级为 {src,tr} 协议（含示例），旧默认追加进 `HISTORICAL_DEFAULT_PROMPTS`，`CURRENT_PROVIDER_VERSION` 20 → 21。沿用 `shouldUpdateSystemPrompt` 语义：仍用默认值的用户自动升级，自定义用户保留原值 + UI 提示（D5）。

## Risks / Trade-offs

- [回显使输出 token 约翻倍] → 默认开启但可关；本地模型免费、云端字幕场景 token 成本低；D4 开关兜底。
- [Gemini/第三方兼容端点对大 schema 的支持不确定] → D8 属性数上限 + 既有回退链（schema 失败降级 json_object，回显校验在 json_object 下依然工作）。
- [自定义提示词用户拿不到回显保护] → D5 优雅降级 + UI 提示更新；不强改用户配置。
- [ollama 的 GBNF 约束不强制 minLength，空串仍可能出现] → 实测已知，空值走 D7 定点补翻路径修复。
- [thinking 模型（deepseek-r1 等）思考内容混入] → schema 约束解码本身抑制思考输出（实测）；解析器已有 strip think 逻辑兜底。
- [补翻单条时上下文不足导致术语漂移] → ±2 条已译文作语境 + 既有术语表机制叠加。

## Migration Plan

1. 解析器先行（双形态兼容落地后才允许 prompt/schema 切换），随后 schema 工厂 + service 层通道，再失败分级，最后提示词迁移与 UI。每步跑对应脚本测试。
2. 回滚：`echoAnchoring=false` + provider 版本不回退（历史提示词机制天然支持继续用旧协议解析）。

## Open Questions

- 无（三个关键张力已由用户拍板：回显默认全开；自定义提示词走 UI 提示；zod→原生 response_format + schema 上限拆批）。
