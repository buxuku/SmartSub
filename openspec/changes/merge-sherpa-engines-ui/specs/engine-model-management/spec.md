## ADDED Requirements

### Requirement: sherpa 系引擎在引擎面合并为单一条目

系统 SHALL 在引擎面把 sherpa 系引擎（funasr / qwen / fireRedAsr）呈现为**单一合并条目**，并以中性主名 + 列出模型族（FunASR · Qwen · FireRed）的副标题表达其覆盖范围。合并 MUST 仅发生在呈现层：底层引擎 id 与任务的 `transcriptionEngine` 取值 MUST 保持不变（funasr / qwen / fireRedAsr）。合并条目的右栏 MUST 只呈现一次共享运行库管理，并按模型族分组呈现各自的模型清单（下载 / 导入 / 删除 / 更换路径不减）。各模型族的高级设置 MUST 按族上下文呈现——逆文本规整（ITN）MUST 仅在 SenseVoice/FunASR 族出现，MUST NOT 作为引擎级全局开关。

#### Scenario: 单一条目覆盖三族模型

- **WHEN** 用户打开引擎面
- **THEN** funasr / qwen / fireRedAsr 表现为一个合并条目，主名中性、副标题列出 `FunASR · Qwen · FireRed`
- **AND** 右栏按 FunASR / Qwen / FireRed 分组列出各自模型，并提供下载 / 导入 / 删除 / 更换路径

#### Scenario: 共享运行库只呈现一次

- **WHEN** 用户查看该合并条目的右栏
- **THEN** 共享运行库管理（或「已内置」状态）只出现一处
- **AND** 系统不让用户产生「需为每个模型族各自获取一次运行库」的误解

#### Scenario: 高级设置按模型族上下文呈现

- **WHEN** 用户查看各模型族的高级设置
- **THEN** 逆文本规整（ITN）仅出现在 SenseVoice/FunASR 族
- **AND** Qwen / FireRed 族不出现 ITN 开关（其规整由模型内部处理）

#### Scenario: 任务页模型选择器按族分组且 id 不变

- **WHEN** 用户在任务页选择转写模型
- **THEN** 三族模型按族分组展示
- **AND** 选定后写入对应的 `transcriptionEngine` id（funasr / qwen / fireRedAsr），后端行为不变
