## ADDED Requirements

### Requirement: 引擎左栏两组分区与云条目平级入口

资源页「引擎与模型」左栏 SHALL 分为两个带组标题的分组：「本地引擎」（builtin / fasterWhisper / sherpa 聚合 / localCli，条目样式与行为不变）与「云端听写」。云组 SHALL 渲染**逐条目平级入口**（一条目对应至多一个实例、一张表单）：品牌型类型每类型一条；协议型类型（`multiInstance: true`）SHALL 展开为「每个命名预设一个恒驻槽位条目 + 每个自定义实例一条」；条目为紧凑单行：品牌/预设图标（`iconImg` 优先、emoji `icon` 兜底）+ 显示名（品牌型可用 `shortName` 缩短；预设条目=预设名；自定义条目=实例名）+ 就绪状态点。状态点 SHALL 以「该条目绑定实例已配置」（`isAsrProviderConfigured` 口径）为就绪。云组末尾 SHALL 固定一个「添加自定义」入口（见协议型基数要求）。选中某云条目 SHALL 在右栏直达该条目的配置表单，且右栏 MUST NOT 渲染本地模型清单区。

本要求 MUST NOT 改动：后端引擎 id（恒 `'cloud'`）、`ASR_TRANSCRIBER_MAP` 按实例 `type` 分发、任务页「引擎 ▸ 模型」下拉的实例分组、`store.asrProviders` 既有数据结构与已保存实例（新实例 MAY 附加可选 `presetId` 来源标记）。

#### Scenario: 打开页面即见全部云服务商与预设

- **WHEN** 用户进入「引擎与模型」页
- **THEN** 左栏「云端听写」组下逐一列出 OpenAI、Groq、硅基流动（预设槽位）、ElevenLabs、Deepgram、豆包、腾讯云、阿里云、讯飞、Gladia 等全部条目（带品牌图标），无需展开任何面板即可看到支持哪些平台

#### Scenario: 选中云条目直达其配置

- **WHEN** 用户点击左栏某云条目（如「腾讯云」或「Groq」）
- **THEN** 右栏直接渲染该条目的配置表单（标题 + 就绪徽标），不出现其它服务商的分区列表或实例列表

#### Scenario: 状态点反映条目就绪态

- **WHEN** 某条目绑定的实例已配置
- **THEN** 该条目的左栏状态点为就绪色；条目未绑定实例或实例未配置时为待办色

#### Scenario: 新增类型或预设自动出现在侧栏

- **WHEN** 开发者向 `ASR_PROVIDER_TYPES` 增加一个新服务商类型，或向 `ASR_PROVIDER_PRESETS` 增加一个新预设
- **THEN** 左栏云组自动出现对应条目，无需改动导航代码

#### Scenario: 任务页与存储行为不变

- **WHEN** 用户在任务页选择云实例并转写，或读取已保存的云实例
- **THEN** 「引擎 ▸ 模型」下拉分组、转写分发与存储读写行为与本变更前完全一致

### Requirement: 云视图选中态持久化兼容

左栏选中态持久化（`engineModelSelectedView`）SHALL 支持云条目 id 形态：`cloud:<typeId>`（品牌/孤儿）、`cloud:<typeId>:<presetId>`（预设槽位）、`cloud:<typeId>:i:<instanceId>`（自定义实例）。历史遗留值 `'cloud'` SHALL 平滑迁移：实例数据加载后解析为「首个已配置条目，无则云组首个条目」并写回新格式，MUST NOT 回落 builtin。`cloud:*` 未命中当前条目清单（自定义条目被删、类型下线且无孤儿实例、旧格式 id）时 SHALL 优先回落同类型首个条目，无同类条目再回落 builtin。既有直写 `'builtin'` 的深链跳转（GPU 徽章、新手引导、resources 重定向）行为 MUST 保持不变。

#### Scenario: 旧 'cloud' 选中态平滑接管

- **WHEN** 用户升级前左栏选中「云端听写」（存储值 `'cloud'`），且已配置过 Gladia
- **THEN** 升级后进入页面落在云组的 Gladia 条目（首个已配置条目），而非回落 builtin

#### Scenario: 删除自定义条目后就近回落

- **WHEN** 用户删除当前选中的自定义 OpenAI 兼容实例
- **THEN** 选中态回落到 OpenAI 兼容的首个条目（如 OpenAI 预设槽位），而非跳回本地引擎

#### Scenario: 未知云视图回落

- **WHEN** 存储值为 `cloud:<已下线且无实例的类型>`
- **THEN** 页面回落 builtin 视图，不白屏不报错

### Requirement: 孤儿类型入口兜底

已存实例的 `type` 不在当前 `ASR_PROVIDER_TYPES` 时，左栏云组 SHALL 在已知类型之后为每个孤儿类型追加入口；其右栏 SHALL 至少支持查看实例名与删除实例（无表单、无测试连接），使旧数据不凭空消失。

#### Scenario: 类型下线后实例仍可清理

- **WHEN** 某服务商类型从 `ASR_PROVIDER_TYPES` 移除，但用户仍存有该类型实例
- **THEN** 左栏云组末尾出现该孤儿类型入口，用户可查看并删除这些实例

## MODIFIED Requirements

### Requirement: 云端听写类别呈现全部服务商类型（平级并列）

云端听写支持的全部服务商 SHALL 以左栏「云端听写」分组下**逐条目平级入口**的形式呈现（品牌型逐类型一条、协议型逐预设/逐自定义实例），条目清单以 `ASR_PROVIDER_TYPES` 与 `ASR_PROVIDER_PRESETS` 为唯一事实源。类别级文案（组标题、面板通用说明）MUST NOT 将「OpenAI 兼容」当作涵盖其它服务商的伞盖表述；单入口时代为罗列各家而设的聚合标签（`engines.cloud.tags` 一类 mega-tags）SHALL 移除，品牌可见性由侧栏逐条目入口承担。

#### Scenario: 服务商可见性由侧栏承担

- **WHEN** 用户进入「引擎与模型」页
- **THEN** 支持的服务商平台与预设通过云组逐条目入口（品牌图标 + 名称）直接可见，不依赖任何聚合 tags 或需要点开的列表

#### Scenario: 文案不把 OpenAI 当伞盖

- **WHEN** 阅读云端听写组与各服务商面板的说明文案
- **THEN** 不出现「仅 OpenAI」或将 ElevenLabs / Deepgram 等归入「OpenAI 兼容」之下的表述

### Requirement: 服务商类型基数（协议型多实例 / 品牌型硬单例）

`AsrProviderType` SHALL 通过可选 `multiInstance` 标记区分基数，且该区分 MUST 仅影响左栏条目展开方式与面板呈现，MUST NOT 改动后端分发、凭据校验或存储结构。全部云条目 SHALL 共享「选中即表单」心智——UI MUST NOT 暴露「实例」管理概念（实例列表、配置按钮、实例切换）。

**品牌型**（未标记，如 ElevenLabs / Deepgram / 豆包 / 腾讯云 / 阿里云 / 讯飞 / Gladia）SHALL 为硬单例：每类型一个侧栏条目，选中后右栏**直接渲染凭据表单**。无实例时表单展示字段默认值，首次编辑 SHALL 惰性物化唯一实例（沿用既有实例构造与持久化路径）；已存历史实例 SHALL 被原样接管。面板 SHALL 提供带确认的「清除配置」动作：删除该单例实例、表单回落默认值、状态回「未配置」、条目保留。填齐必填字段即判定「已就绪」（`isAsrProviderConfigured` 口径），以头部徽标为唯一状态口径。

**协议型**（`multiInstance: true`，如 OpenAI 兼容）SHALL 摊平为侧栏逐条目形态：

- **预设槽位条目**（每个命名预设一条，恒驻）：行为与品牌型一致（表单直显、惰性物化、清除配置）；物化实例 SHALL 打 `presetId` 来源标记。槽位与实例的绑定 SHALL 按「`presetId` 显式指向（改 URL 不漂移）→ 无 `presetId` 的历史实例按名称与 base URL 双匹配兜底」认领，每槽至多一个实例；改过名或 URL 的历史实例 MUST NOT 被槽位认领（按自定义条目对待）。
- **自定义实例条目**（逐实例一条）：显示名=实例名；面板含可编辑「名称」字段与常驻「删除」动作（带确认，删除移除整个条目）。
- **「添加自定义」入口** SHALL 固定在云组末尾：收集名称（必填）与可选 Base URL 新建自定义实例并跳转其条目；同类型内 SHALL 自动去重命名（如 `OpenAI` → `OpenAI 2`），MUST NOT 产生仅凭名称无法区分的条目。

#### Scenario: 品牌型选中即填、无实例操作

- **WHEN** 用户选中左栏「ElevenLabs」（尚未配置）
- **THEN** 右栏直接是凭据表单（无「配置」按钮、无实例列表），填入 API Key 等必填项后徽标变为「已就绪」

#### Scenario: 预设槽位与品牌型体验一致

- **WHEN** 用户选中左栏「Groq」预设槽位（尚未配置）
- **THEN** 右栏直接是表单（base URL / 模型已预填，凭据为空），填入 API Key 后徽标变为「已就绪」，全程无实例管理操作

#### Scenario: 首次编辑才落库

- **WHEN** 用户仅打开某品牌型或预设槽位面板但未编辑任何字段
- **THEN** 不产生任何持久化实例；首次编辑字段时才物化唯一实例并持久化（预设槽位物化的实例带 `presetId` 标记）

#### Scenario: 清除配置回到未配置

- **WHEN** 用户在已配置的品牌型或预设槽位面板点击「清除配置」并确认
- **THEN** 背后实例被删除，表单回落默认值，头部徽标与左栏状态点回「未配置」，条目仍驻侧栏

#### Scenario: 添加自定义实例成为独立条目

- **WHEN** 用户点击云组末尾「添加自定义」，输入名称「我的中转」与 Base URL 并确认
- **THEN** 云组出现「我的中转」条目并自动选中，其面板含可改名的「名称」字段与常驻删除入口（带确认）

#### Scenario: 自定义条目自动去重命名

- **WHEN** 用户添加自定义实例时输入了与既有条目相同的名称
- **THEN** 新条目自动追加序号（如 `OpenAI` → `OpenAI 2`），侧栏不出现无法区分的同名条目

#### Scenario: 历史实例按槽位认领或归为自定义

- **WHEN** 升级前存有名称与 base URL 均与「Groq」预设一致的历史实例，以及一个改过名的「Groq 生产」实例
- **THEN** 前者被 Groq 槽位认领（槽位显示已就绪），后者成为独立的「Groq 生产」自定义条目，数据零丢失

### Requirement: Protocol-type provider presets

The system SHALL let a protocol-type cloud ASR provider type (e.g. OpenAI-compatible) declare a list of named presets, where each preset carries connection field values (such as base URL and model list) but not credentials. Each preset SHALL surface as a **permanent sidebar entry** (a preset slot with its own icon and name) in the cloud group — presets MUST NOT be hidden behind a dropdown, quick-add area, or other disclosure interaction. Selecting a preset slot SHALL show a direct configuration form with the preset's field values prefilled; the instance is lazily materialized on first edit and marked with the preset's id. A preset SHALL only prefill field values; the created instance's provider `type` and the backend transcription/dispatch behavior SHALL remain unchanged.

#### Scenario: Presets visible in the sidebar

- **WHEN** a user opens the engine page
- **THEN** OpenAI / Groq / SiliconFlow each appear as their own sidebar entries in the cloud group, without opening any menu or panel

#### Scenario: Selecting a preset slot prefills endpoint and models

- **WHEN** a user selects a preset slot (e.g. Groq)
- **THEN** the form shows that preset's base URL and model list prefilled, the provider `type` unchanged; first edit materializes the instance with the preset id stamped

#### Scenario: Presets never fill credentials

- **WHEN** an instance is materialized from any preset slot
- **THEN** no API key or other credential is written by the preset, and the entry is reported as not-yet-configured until the user supplies the required credential

#### Scenario: Brand-type providers are unaffected

- **WHEN** the provider type is a brand-type singleton (e.g. ElevenLabs)
- **THEN** it has exactly one sidebar entry with the direct-form behavior and no preset slots

### Requirement: 服务商扩展遵循两级分类与三步 recipe

云端听写 SHALL 采用「类别 ▸ 类型 ▸ 实例」两级分类：类别为单一云引擎（`engine:'cloud'`）；类型为 `AsrProviderType`（各自 `fields` 驱动表单 + 一个 `transcribe` 实现）；实例为 `AsrProvider`（用户凭据，协议型可多实例、品牌型单例）。新增一个服务商类型 SHALL 仅需：向 `ASR_PROVIDER_TYPES` 增一条（按真实形态设 `multiInstance`）、在 `main/service/asr/` 实现其 `transcribe`、于 `ASR_TRANSCRIBER_MAP` 注册；左栏云组条目与右栏配置面板 SHALL 据 `ASR_PROVIDER_TYPES` / `ASR_PROVIDER_PRESETS` 自动纳入新类型与新预设，MUST NOT 需要改动导航/面板呈现代码。

#### Scenario: 新增类型自动获得入口与面板

- **WHEN** 开发者向 `ASR_PROVIDER_TYPES` 增加一个新服务商类型
- **THEN** 该类型自动出现在左栏云组并拥有由 `fields` 驱动的配置面板，无需改动导航与面板代码

#### Scenario: OpenAI 兼容端点服务商零代码复用

- **WHEN** 某服务商提供 OpenAI 兼容的 `/audio/transcriptions` 端点
- **THEN** 用户经云组末尾「添加自定义」填入其名称、base URL 与凭据即可使用，无需新增类型或代码

## REMOVED Requirements

### Requirement: 配置面板按服务商类型分区

**Reason**: 类型分区职责整体上移至左栏「云端听写」分组（每类型一个平级入口），右栏改为所选服务商的专属面板；面板内不再存在多类型分区列表，该要求失去载体。

**Migration**: 由本变更 ADDED「引擎左栏两组分区与云条目平级入口」与 MODIFIED「服务商类型基数」承接：混类型实例经左栏条目按类型天然隔离；「区内添加」由品牌型/预设槽位表单直显 + 云组末尾「添加自定义」替代；「无实例的类型仍可见」由侧栏恒列全部类型与预设槽位达成。

### Requirement: 云端听写保持单一引擎视图（不拆分左栏，非破坏）

**Reason**: 该要求成立的前提（服务商类型仅 3 种、担心左栏膨胀）已变化：类型增至 8 种后，面板内分区列表实际成为「第二根侧栏」，三层嵌套的导航成本超过左栏拆分的成本；分组标题 + 紧凑单行条目可控制左栏规模。

**Migration**: 左栏呈现改为「云端听写」分组下逐条目平级入口（见 ADDED）。原要求中的全部**非破坏约束**（后端引擎 id 恒 `'cloud'`、`ASR_TRANSCRIBER_MAP` 分发、任务页「引擎 ▸ 模型」下拉分组、`store.asrProviders` 结构与已存实例不变）由 ADDED「引擎左栏两组分区与云条目平级入口」原文承接，继续生效。
