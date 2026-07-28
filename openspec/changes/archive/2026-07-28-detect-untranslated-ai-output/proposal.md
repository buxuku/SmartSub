# Proposal: detect-untranslated-ai-output

## Why

AI 本地模型可能返回结构正确、键数一致，但把原文直接放进译文字段。现有回显锚定只能证明 ID 对齐，无法证明 `tr` 已翻译；issue #283 的 Ollama 兼容端点因此将整批中文原样写入英语字幕。简单按字符相似度硬判又会误伤西班牙语→葡萄牙语等同文字系统近似翻译，以及克罗地亚语→塞尔维亚语的合法同文结果。

## What Changes

- 新增供应商无关的未翻译输出强/弱证据分类。
- 跨文字系统精确复制（至少 2 个字母）可作为单条强证据；长近似复制仅在跨文字系统时为强证据。
- 同文字系统近似/同文，以及短标题式或疑似专名的跨文字复制仅为弱证据，不单独进入失败路径。
- 同批至少 2 条强证据且严格超过 1/3 时，可升级同批跨文字精确复制弱证据。
- 批次升级的弱证据补翻耗尽时保留批量模型原输出，避免专名被失败占位符覆盖。
- 数字、URL、邮箱、单字符及已使用目标文字系统的合理保留内容不升级。
- 目标语言已知时，源语言为 `auto` 仍根据源文本文字系统执行检测；明确同语言方向继续豁免。
- 语义校验独立于 `{src,tr}`/旧字符串响应形态，批量与每次定点补翻均执行。
- 修正整批重试比例为 `problemCount * 3 > batchSize`。

## Capabilities

### Modified Capabilities

- `ai-translation-alignment`: 增加未翻译输出强弱证据校验、批次聚合、补翻结果复验与精确三分之一边界。

## Impact

- `main/translate/utils/{untranslated,similarity,alignment}.ts`
- `main/translate/services/ai.ts`
- `scripts/test-alignment-e2e.ts`
- `scripts/test-ai-untranslated-flow.cjs`
- `openspec/specs/ai-translation-alignment/spec.md`
