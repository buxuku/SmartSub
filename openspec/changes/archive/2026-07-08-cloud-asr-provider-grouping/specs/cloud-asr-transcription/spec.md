## ADDED Requirements

### Requirement: 云端听写类别呈现全部服务商类型（平级并列）

资源页「云端听写」类别的呈现（副标题 / 标签 / 描述）SHALL 平级并列列出其支持的全部服务商类型（当前为 OpenAI 兼容、ElevenLabs、Deepgram），类型清单以 `ASR_PROVIDER_TYPES` 为唯一事实源。文案 MUST NOT 将「OpenAI 兼容」当作涵盖其它服务商的伞盖表述（去除「仅 OpenAI」口径）。

#### Scenario: 打开云端听写即可见支持的服务商

- **WHEN** 用户进入「引擎与模型 ▸ 云端听写」
- **THEN** 副标题与标签展示 `OpenAI 兼容 · ElevenLabs · Deepgram` 等各服务商类型，而非仅「OpenAI 兼容的在线转写」

#### Scenario: 文案不把 OpenAI 当伞盖

- **WHEN** 阅读云端听写的描述 / intro 文案
- **THEN** 文案点名各服务商类型，不出现「仅 OpenAI」或将 ElevenLabs/Deepgram 归入「OpenAI 兼容」之下的表述

### Requirement: 配置面板按服务商类型分区

`CloudAsrPanel` SHALL 按服务商类型（`AsrProviderType`）分区呈现，而非单一扁平实例列表。每个分区 SHALL 含类型名与图标标题、该类型下的实例列表、以及一个区内「添加实例」入口（直接新建该类型实例）。面板 SHALL 展示 `ASR_PROVIDER_TYPES` 中的全部类型（含尚无实例者），使「支持哪些服务商」自解释。

#### Scenario: 混类型实例各归其分区

- **WHEN** 用户已配置 1 个 OpenAI 兼容实例、1 个 ElevenLabs 实例、1 个 Deepgram 实例
- **THEN** 三者分别出现在各自的服务商类型分区下，而非混在一个扁平列表里

#### Scenario: 区内添加直接新建该类型实例

- **WHEN** 用户点击某服务商类型分区内的「添加实例」
- **THEN** 系统直接新建该类型的实例并选中，无需再选择服务商类型

#### Scenario: 无实例的类型仍可见并可添加

- **WHEN** 某服务商类型尚无任何实例
- **THEN** 该类型分区仍显示（可折叠），并提供「添加实例」入口

### Requirement: 服务商类型基数（协议型多实例 / 品牌型硬单例）

`AsrProviderType` SHALL 通过可选 `multiInstance` 标记区分基数：协议型（`multiInstance:true`，如 OpenAI 兼容——同协议对接多家 vendor）允许多实例，其分区 SHALL 提供「添加实例」入口且不限数量；品牌型（未标记，如 ElevenLabs / Deepgram——固定单端）SHALL 为硬单例——未配置时提供「配置」入口新建唯一实例，已存在实例后 MUST NOT 再提供任何新增入口（封顶 1）。该区分 MUST 仅影响配置面板呈现，MUST NOT 改动后端分发、凭据校验或存储结构。

#### Scenario: 协议型可添加多个实例

- **WHEN** 用户在 OpenAI 兼容（协议型）分区
- **THEN** 可反复使用「添加实例」新建多个实例（对接多家兼容端点）

#### Scenario: 品牌型未配置显示「配置」

- **WHEN** ElevenLabs / Deepgram（品牌型）分区尚无任何实例
- **THEN** 分区显示「配置」入口，点击后新建该品牌的唯一实例并选中

#### Scenario: 品牌型已配置后不再提供新增

- **WHEN** 某品牌型已存在一个实例
- **THEN** 分区 MUST NOT 再显示「添加实例 / 配置」入口（硬单例封顶 1），且已有实例仍可查看与删除

#### Scenario: 删除品牌型实例后回到可配置

- **WHEN** 用户删除品牌型的唯一实例
- **THEN** 分区重新显示「配置」入口

### Requirement: 服务商扩展遵循两级分类与三步 recipe

云端听写 SHALL 采用「类别 ▸ 类型 ▸ 实例」两级分类：类别为单一云引擎（`engine:'cloud'`）；类型为 `AsrProviderType`（各自 `fields` 驱动表单 + 一个 `transcribe` 实现）；实例为 `AsrProvider`（用户凭据，同类型可多实例）。新增一个服务商类型 SHALL 仅需：向 `ASR_PROVIDER_TYPES` 增一条、在 `main/service/asr/` 实现其 `transcribe`、于 `ASR_TRANSCRIBER_MAP` 注册；分区呈现（上条）SHALL 据 `ASR_PROVIDER_TYPES` 自动纳入新类型，MUST NOT 需要改动分组/呈现代码。

#### Scenario: 新增类型自动出现在面板与类别文案来源

- **WHEN** 开发者向 `ASR_PROVIDER_TYPES` 增加一个新服务商类型
- **THEN** 该类型自动成为面板中的一个分区，并被纳入类别呈现的类型来源，无需改动分区/呈现逻辑

#### Scenario: OpenAI 兼容端点服务商零代码复用

- **WHEN** 某服务商提供 OpenAI 兼容的 `/audio/transcriptions` 端点
- **THEN** 用户用现有「OpenAI 兼容」类型填入其 base URL 与凭据即可使用，无需新增类型或代码

### Requirement: 云端听写保持单一引擎视图（不拆分左栏，非破坏）

云端听写 MUST 在资源页左栏保持**单一**引擎视图（`'cloud'`），MUST NOT 将各服务商类型拆分为多个独立左栏引擎项。本变更 MUST NOT 改动后端引擎 id、`ASR_TRANSCRIBER_MAP` 分发、任务页「引擎 ▸ 模型」下拉的实例分组，或 `store.asrProviders` 数据结构与已保存实例。

#### Scenario: 侧栏仍是一个云端听写入口

- **WHEN** 配置了多种服务商类型的多个实例
- **THEN** 资源页左栏仍只有一个「云端听写」入口（服务商区分在面板内分区呈现），左栏不随服务商数量增加而新增条目

#### Scenario: 任务页与存储行为不变

- **WHEN** 用户在任务页选择云实例并转写，或读取已保存的云实例
- **THEN** 「引擎 ▸ 模型」下拉的实例分组、转写分发与存储读写行为与本变更前完全一致
