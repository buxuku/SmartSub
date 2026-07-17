# Spec Delta: ai-translation-alignment

## ADDED Requirements

### Requirement: 动态批次 Schema 约束

AI 批量翻译时，系统 SHALL 按当前批次的字幕 ID 动态生成 JSON Schema（每个 ID 为一个 required 属性，`additionalProperties: false`），并在支持结构化输出的渠道以 json_schema 模式随请求下发；service 层 MUST 优先使用调用方传入的动态 schema，未传入时保持现有静态 schema 行为。

#### Scenario: ollama 渠道使用动态 schema

- **WHEN** 通过 ollama 渠道以 json_schema 模式翻译一个包含 ID 1~20 的批次
- **THEN** 请求的 `format` 字段为包含且仅包含键 1~20（全部 required、禁止额外属性）的 JSON Schema，响应键集合与批次 ID 集合完全一致

#### Scenario: OpenAI 兼容渠道使用原生 response_format

- **WHEN** 通过 OpenAI 兼容渠道以 json_schema 模式翻译一个批次
- **THEN** 请求使用 `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }`，其中 schema 为该批次动态生成

#### Scenario: 渠道不支持 json_schema 时降级

- **WHEN** 渠道对 json_schema 请求返回「不支持」类错误
- **THEN** 按既有回退链降级到 json_object 重试，翻译不中断

#### Scenario: 批次超过 schema 属性上限时自动拆分

- **WHEN** 用户配置的批量大小大于 100
- **THEN** 系统按不超过 100 条每批自动拆分后再翻译，每个子批次拥有独立的动态 schema

### Requirement: 回显锚定对齐校验

系统 SHALL 默认要求模型对每条字幕返回 `{src: 原文回显, tr: 译文}` 结构，并将回显 src 与该 ID 的真实原文做归一化相似度比对（阈值 0.75）；相似度不足或 tr 为空的条目 MUST 被标记为错位条目。provider SHALL 提供 `echoAnchoring` 开关（默认开启），关闭后系统 SHALL 退回非回显动态 schema 并仅执行条数与空值校验。

#### Scenario: 回显全部匹配

- **WHEN** 模型返回的每条 src 与对应原文相似度 ≥ 0.75 且 tr 非空
- **THEN** 全部译文按 ID 入库，不触发修复

#### Scenario: 检测到合并滑移

- **WHEN** 模型将相邻两条原文合并翻译导致后续条目回显与真实原文不匹配
- **THEN** 所有相似度 < 0.75 的条目被标记为错位，进入定点修复流程，未受影响的条目正常入库

#### Scenario: 关闭回显锚定

- **WHEN** provider 的 `echoAnchoring` 设为 false
- **THEN** 请求使用 `{id: 译文}` 非回显 schema，校验仅覆盖键集合一致与值非空

### Requirement: 解析器双形态兼容

响应解析器 SHALL 同时接受两种值形态：`{src, tr}` 对象（提取双字段供回显校验）与纯字符串（降级为仅条数与空值校验）；两种形态混合出现时 MUST 逐条按各自形态处理，不得整批判失败。

#### Scenario: 自定义提示词返回旧协议

- **WHEN** 用户自定义提示词使模型返回 `{id: 译文字符串}` 旧格式
- **THEN** 解析成功，跳过回显校验，仅执行条数与空值校验，翻译流程不中断

#### Scenario: UI 提示更新自定义提示词

- **WHEN** 用户的 provider 配置了自定义系统提示词且其中不含 src/tr 协议约定
- **THEN** provider 设置界面展示提示，告知更新提示词可获得错位检测保护

### Requirement: 失败分级与单条定点补翻

批次校验失败时系统 SHALL 分级处理：响应不可解析或错位条目数超过批次的 1/3 时整批重试一次；错位或空值条目数不超过 1/3 时对每个问题条目执行单条定点补翻（携带前后各 2 条原文与已译文作为上下文、单键 schema 锁定输出、最多 3 次）；补翻仍失败的条目 MUST 单独标记为翻译失败，同批次其余译文 MUST 正常入库。

#### Scenario: 个别空值触发定点补翻

- **WHEN** 批次响应中 1 条译文为空串、其余正常
- **THEN** 仅对该条发起带上下文的单条补翻请求，成功后与其余译文一并入库，无整批重试

#### Scenario: 大面积错位触发整批重试

- **WHEN** 批次中超过 1/3 的条目回显不匹配
- **THEN** 整批重试一次；重试后仍有个别问题条目则转入单条补翻

#### Scenario: 补翻耗尽后局部失败

- **WHEN** 某条目单条补翻 3 次均失败
- **THEN** 仅该条目标记为翻译失败（targetContent 含失败标记），批次其余条目译文正常写入结果

### Requirement: 默认提示词升级与迁移

默认系统提示词 SHALL 升级为 {src,tr} 回显协议（含输入输出示例），旧默认提示词 MUST 追加进历史提示词列表；provider 配置版本迁移时仍在使用任一历史默认提示词的用户 SHALL 自动升级为新默认值，自定义过提示词的用户 MUST 保留原值。

#### Scenario: 未修改默认提示词的用户自动升级

- **WHEN** 用户的 systemPrompt 与任一历史默认提示词一致且触发 provider 版本迁移
- **THEN** systemPrompt 更新为新的 {src,tr} 协议默认值

#### Scenario: 自定义提示词用户保留原值

- **WHEN** 用户的 systemPrompt 与所有历史默认值均不一致
- **THEN** 迁移后 systemPrompt 保持用户自定义内容不变
