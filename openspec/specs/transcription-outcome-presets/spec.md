# transcription-outcome-presets Specification

## Purpose

TBD - created by archiving change subtitle-outcome-presets. Update Purpose after archive.

## Requirements

### Requirement: 字幕效果意图档位（3 档 + 自定义）

系统 SHALL 向普通用户提供一个单选的「字幕效果」意图档位，包含三个内置档位 `文字最准` / `均衡` / `最干净最稳`，以及一个 `自定义` 档。档位 SHALL 以「视频类型」为主标签、「效果名」为副标签呈现（如「口播 / 教程 / 短视频 — 文字最准」「长视频 / 嘈杂 / 带音乐 — 最干净最稳」）。普通用户在选择档位时 MUST NOT 需要直接面对 VAD、上下文长度、减少重复等机制术语。

#### Scenario: 用视频类型主标签呈现三档

- **WHEN** 用户打开转写识别配置
- **THEN** 看到三个以「视频类型」为主、「效果」为副的档位选项，外加可折叠的「自定义」

#### Scenario: 非自定义档隐藏机制术语

- **WHEN** 用户停留在 `文字最准` / `均衡` / `最干净最稳` 任一档
- **THEN** 界面不显示 VAD / 上下文长度 / 减少重复等原始机制控件（它们仅在「自定义」折叠区出现）

### Requirement: 引擎感知的档位参数映射

系统 SHALL 通过单一映射把「档位 + 当前引擎」翻译为该引擎对应的底层识别参数；同一档位在不同引擎下 SHALL 可映射为不同的底层参数。该映射 MUST 集中于一处（纯函数），不分散在各引擎实现里。

#### Scenario: builtin 引擎按档位映射

- **WHEN** 引擎为 builtin 且档位为 `文字最准`
- **THEN** 映射为 `useVAD=false`、`maxContext=-1`、`reduceRepetition=false`

#### Scenario: builtin「最干净最稳」映射

- **WHEN** 引擎为 builtin 且档位为 `最干净最稳`
- **THEN** 映射为 `useVAD=true`、`maxContext=0`、`reduceRepetition=true`

#### Scenario: faster-whisper 同档不同映射

- **WHEN** 引擎为 faster-whisper 且档位为 `最干净最稳`
- **THEN** 映射为 `useVAD=true` 且启用其抗重复参数包（`maxContext` 对该引擎不适用，不参与映射）

#### Scenario: sherpa 引擎映射到 VAD 灵敏度

- **WHEN** 引擎为 funasr / qwen / fireRed（VAD 结构性常开、无上下文/抗重复概念）
- **THEN** 档位映射到 VAD 灵敏度档（`文字最准`≈灵敏、`均衡`≈标准、`最干净最稳`≈保守），MUST NOT 试图关闭其 VAD 或设置 `maxContext` / `reduceRepetition`

### Requirement: 底层参数单一事实来源（消除静默覆盖）

在非「自定义」档下，`maxContext` / `useVAD` / `reduceRepetition` SHALL 全部由档位映射派生，系统 MUST NOT 让某个开关再独立覆盖另一个（即不再出现「`reduceRepetition` 一开就把用户选的 `maxContext` 静默改成 0」）。

#### Scenario: max_context 由档位决定而非被另一开关覆盖

- **WHEN** 当前为 builtin 的 `均衡` 档（映射 `maxContext=-1`、`reduceRepetition=false`）
- **THEN** 实际传给引擎的 `max_context` 为 `-1`，不被任何独立的减少重复开关改写

#### Scenario: 自定义档恢复独立可调

- **WHEN** 用户切到「自定义」档
- **THEN** `useVAD` / `maxContext` / `reduceRepetition` 恢复为可各自独立设置的值

#### Scenario: 逐任务派生不污染全局与其它引擎

- **WHEN** 某任务以非 `custom` 档运行
- **THEN** 其有效 `useVAD` / `maxContext` / `reduceRepetition` 按「档位 × 引擎」在运行时派生并下发，MUST NOT 回写全局设置，且 MUST NOT 影响其它引擎或其它任务的取值

### Requirement: 默认均衡且无需事先决策

系统 SHALL 默认采用 `均衡` 档，使新任务无需用户做任何识别参数选择即可运行。系统 MUST NOT 强制普通用户在首次运行前理解各档差异。

#### Scenario: 新任务默认均衡

- **WHEN** 用户新建任务且从未改过字幕效果
- **THEN** 任务以 `均衡` 档运行，无需任何额外选择

### Requirement: 反应式调整引导（症状语言）

当用户对产出不满意时，系统 SHALL 用症状语言（而非机制术语）引导其切换档位：将「重复 / 鬼畜 / 静音处仍刷字幕」导向 `最干净最稳`，将「想要更准的字 / 更细的断句」导向 `文字最准`。

#### Scenario: 重复/刷屏导向更干净

- **WHEN** 用户反馈字幕出现重复或静音处仍显示
- **THEN** 系统提示切到「最干净最稳」并允许据此重跑该任务

#### Scenario: 想要更准导向文字最准

- **WHEN** 用户希望文字更准、断句更细
- **THEN** 系统提示切到「文字最准」并允许据此重跑该任务

### Requirement: 档位样例对比

系统 SHALL 在档位选择处提供「相邻档位的字幕效果对比」展示，使用户无需理解原理即可看懂差异（如「断句更细但静音处可能冒字」对「合并成块但静音干净」）。

#### Scenario: 展示两档差异对比

- **WHEN** 用户查看字幕效果档位
- **THEN** 看到至少两个相邻档位的字幕样例对比（可为内置示意样例）

### Requirement: 高级用户保留底层参数并安全迁移

系统 SHALL 保留「自定义」折叠区，使高级用户仍可单独设置 VAD（含其细分阈值与环境预设）、上下文长度、减少重复，能力不缩减。对既有用户，系统 SHALL 在引入档位时安全迁移：现有底层值若恰等于某内置档映射则归入该档，否则归入「自定义」并原样保留其值，MUST NOT 改变其既有识别行为。

#### Scenario: 等值迁移到内置档

- **WHEN** 老用户既有设置恰为某内置档的映射值
- **THEN** 迁移后归入该内置档，行为不变

#### Scenario: 非等值迁移到自定义

- **WHEN** 老用户既有设置不等于任何内置档映射
- **THEN** 迁移后归入「自定义」档并原样保留其 VAD / 上下文 / 减少重复值

#### Scenario: sherpa 引擎隐藏不适用旋钮

- **WHEN** 当前引擎为 funasr / qwen / fireRed 且展开「自定义」区
- **THEN** 不显示 `maxContext` / `reduceRepetition`（对 sherpa 引擎无效），仅显示其适用的 VAD 灵敏度相关项
