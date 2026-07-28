# Spec Delta: ai-translation-alignment

## ADDED Requirements

### Requirement: 未翻译输出的强弱证据校验

系统 SHALL 在 AI 批量响应解析后、独立于回显协议形态执行未翻译输出语义校验。仅当源/目标语言代码均明确且不相同时启用。跨文字系统的规范化精确复制（至少 2 个字母）或足够长的高相似复制 SHALL 为强证据；同文字系统的精确/高相似结果，以及短标题式或疑似专名的跨文字复制 SHALL 至多为弱证据。纯数字、URL、邮箱和单字符 SHALL 不构成证据。

强证据 MUST 可单条进入修复；弱证据 MUST NOT 单独触发补翻或失败。当同批至少 2 条强证据且强证据数严格超过 1/3 时，跨文字系统的精确复制弱证据 MAY 升级；已使用目标文字系统的合理保留内容 MUST 不升级。

#### Scenario: Issue 283 跨文字整批复制

- **WHEN** 中文→英语批次的模型按旧字符串协议逐条返回原中文
- **THEN** 每条至少 2 字的跨文字精确复制均为强证据，问题数超过 1/3 时整批重试，重试后仍复制则逐条补翻

#### Scenario: 同文字近似翻译

- **WHEN** 「Este problema es importante」译为「Este problema é importante」
- **THEN** 结果至多为弱证据，不触发补翻或失败

#### Scenario: 合法同文翻译

- **WHEN** 克罗地亚语翻译为塞尔维亚语后合法保持相同拉丁文字
- **THEN** 结果至多为弱证据，不触发补翻或失败

## MODIFIED Requirements

### Requirement: 回显锚定对齐校验

系统 SHALL 默认要求模型对每条字幕返回 `{src: 原文回显, tr: 译文}` 并执行回显对齐校验。关闭 `echoAnchoring` 后，回显对齐校验 SHALL 退回键集合与空值校验；独立的未翻译输出强弱证据校验 SHALL 继续执行。

#### Scenario: 关闭回显仍执行语义校验

- **WHEN** provider 关闭 echoAnchoring 且返回 `{id: 译文}` 字符串
- **THEN** 系统跳过 src 回显比对，但仍按强弱证据规则检测明确的原文复制

### Requirement: 解析器双形态兼容

解析器 SHALL 同时接受 `{src,tr}` 与纯字符串值。纯字符串仅在回显对齐层降级为条数与空值校验；未翻译输出语义校验 MUST NOT 因响应形态而关闭。

#### Scenario: 旧协议响应仍受语义保护

- **WHEN** 自定义提示词返回旧 `{id: 译文字符串}` 协议
- **THEN** 解析流程不中断，且明确的跨文字原文复制仍进入修复

### Requirement: 失败分级与单条定点补翻

响应不可解析，或错位、空值及强/升级后的未翻译条目总数严格超过批次 1/3 时，系统 SHALL 整批重试一次。比例 MUST 按 `problemCount * 3 > batchSize` 判断。之后问题条目 SHALL 单条补翻最多 3 次，并重新验证补翻结果；仅弱证据 MUST NOT 进入补翻耗尽后的失败路径。

#### Scenario: 4/10 超过三分之一

- **WHEN** 10 条批次有 4 条问题结果
- **THEN** 系统整批重试一次

#### Scenario: 补翻仍复制原文

- **WHEN** 强证据条目的 3 次补翻均再次返回原文
- **THEN** 该条单独标记失败，其他结果正常入库
