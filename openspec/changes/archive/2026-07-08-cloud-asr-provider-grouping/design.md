## Context

云端听写在三个层面各有各的「合并度」，需先分清：

```
层1 · 资源页左栏（引擎与模型）  ← ★ 真正「合并」的只有这里
  [☁ 云端听写] 一个入口 → CloudAsrPanel 一个扁平实例列表
    ├ DeerAPI (OpenAI兼容)   3 种服务商类型藏在「添加实例 ▾」下拉里
    ├ 我的 ElevenLabs
    └ 我的 Deepgram

层2 · 任务页「引擎 ▸ 模型」下拉  ← 早已按已配置实例分组（getEngineModelGroups）
层3 · 后端 engine id            ← 恒为 'cloud'，按 provider.type 经 ASR_TRANSCRIBER_MAP 分发
```

现状问题集中在**层1 的呈现**：`engines.cloud` 的 `subtitle` / `tags` / `desc` 与 `cloudAsr.intro` 都是「只有 OpenAI 兼容」时代写的文案，且 `CloudAsrPanel` 是不分类型的扁平列表——打开看不出支持 ElevenLabs / Deepgram。

已有现成范式可抄：`sherpa` 同为「一个左栏入口聚合多个子成员（funasr/qwen/fireRedAsr）」，它用 `engines.sherpa.subtitle`（`FunASR · Qwen · FireRed`）+ `tags`（`[FunASR][Qwen3-ASR][FireRedASR]`）在侧栏亮明子品牌，`SherpaEngineGroupPanel` 内再按族用 `Collapsible` 分区。cloud 只需照此适配即可。

约束：Electron + Next(nextron)；`ASR_PROVIDER_TYPES`（`types/asrProvider.ts`）已可枚举全部类型且各带 `icon`/`name`/`fields`；`check:i18n`、`test:engines` 守卫；本变更须**非破坏**（后端 / 任务页 / 存储零改动）。

## Goals / Non-Goals

**Goals:**

- 让用户在资源页**一眼看出**云端听写支持哪些服务商（当前被 OpenAI 口径文案掩盖）。
- 让「管理多个混类型实例」有清晰结构：按服务商类型分区，随类型增多仍可导航。
- 把「新增一家服务商」的扩展路径固化为**两级分类 + 三步 recipe**，作为后续接入阿里/千问/豆包的规范。
- 严格**非破坏**：仅动层1 的 cloud 文案与 `CloudAsrPanel` 布局。

**Non-Goals:**

- **不**新增/改动任何服务商的集成逻辑（`transcribe` 实现、`ASR_TRANSCRIBER_MAP`、字段定义）。
- **不**改任务页「引擎 ▸ 模型」下拉（已按实例分组）与 `store.asrProviders` 数据结构。
- **不**把各服务商拆成独立左栏引擎项（见 D4 弃 D）。
- 不实际接入阿里/千问/豆包（本期只固化 recipe，不新增服务商）。

## Decisions

### D1 — B：类别文案平级并列各服务商类型，而非「OpenAI 兼容」当伞盖

**决定**：`engines.cloud` 文案改为并列列出各类型：`subtitle = OpenAI 兼容 · ElevenLabs · Deepgram`、`tags = [OpenAI 兼容, ElevenLabs, Deepgram]`、`desc`/`cloudAsr.intro` 点名各家并去掉「仅 OpenAI」。类型清单以 `ASR_PROVIDER_TYPES` 为唯一事实源。

**理由**：ElevenLabs/Deepgram 本就不是 OpenAI 兼容协议（各自独立 `transcribe`），伞盖式措辞既不准确也埋没品牌。对齐 sherpa 的 subtitle+tags 做法，近乎零成本解决发现性。**代价**：i18n 文案需随新增类型手动增补（可接受；或后续由 `ASR_PROVIDER_TYPES` 动态生成，见 D6）。

### D2 — C：`CloudAsrPanel` 按 `AsrProviderType` 分区（对齐 `SherpaEngineGroupPanel`）

**决定**：面板从单一扁平实例列表改为**按类型分区**：遍历 `ASR_PROVIDER_TYPES`，每区含 `icon + name` 标题、该类型下实例列表、区内「添加实例」按钮（直接新建该类型实例，取代顶部「添加实例 ▾」下拉）。选中某实例仍在右侧渲染其凭据表单 + 测试连接（逻辑不变）。

**理由**：类型异构（字段不同：API Key vs AK/SK vs region）——按类型分区让配置心智清晰、"支持哪些家" 自解释，且侧栏仍是一个入口，随类型增多不膨胀。这正是 sherpa 已验证的结构。**代价**：面板一次布局重构；但复用现有实例卡片 / 表单 / 测试逻辑，风险低。

### D3 — 固化「两级分类 + 三步扩展 recipe」

**决定**：明确并文档化扩展契约——

- 分类：**类别**（`engine:'cloud'`）▸ **类型**（`AsrProviderType`：`fields` 驱动表单 + 一个 `transcribe` 实现）▸ **实例**（`AsrProvider`：用户凭据，同类型可多实例）。
- 三步（新增一家）：① `types/asrProvider.ts` 向 `ASR_PROVIDER_TYPES` 加一条（声明该家 `fields`）；② `main/service/asr/<x>.ts`(+`<x>Utils.ts`) 实现 `transcribe(provider,input): AsrTranscribeResult`（内部 SDK/WebSocket/签名自由，只需吐统一契约 `{text,words?,segments?,hasWordTimestamps}`）；③ `main/service/asr/index.ts` 向 `ASR_TRANSCRIBER_MAP` 注册。可选：`testConnection.ts` 加探测分支、i18n 加字段文案。

**理由**：ElevenLabs/Deepgram 已按此落地，recipe 已被验证。写进 spec 后，B/C 的分区呈现天然吸纳未来类型，无需再动分组代码。**省事点**：若某家 ASR 提供 OpenAI 兼容 `/audio/transcriptions` 端点，直接用现有「OpenAI 兼容」类型填 baseURL 即可，**零代码**；仅私有协议才走三步。

### D4 — 弃 D：不把各服务商拆成独立左栏引擎项

**决定**：**不**在 `ENGINE_VIEWS` 里为每家服务商加独立入口；保持单一 `'cloud'` 视图 + 面板内分区（D2）。

**理由**：

- **侧栏膨胀**：每加一家 +1 永久入口，接 6–10 家后左栏爆炸（sherpa 也没这么拆）。
- **空服务商占位**：未配置该家时，独立入口会永久显示「去添加」，噪音大；分区可折叠/给提示，更克制。
- **范式相悖**：云的 setup 体验对所有家一致（填凭据 + 测试、无运行时下载）——属于「同一类别下的类型」，不该升格为并列引擎。
- **区分度已足**：任务页层2 早已按实例分组，选择时天然区分服务商；D 的额外区分 B/C 已给到。
- **后端错配**：engine id 恒为 `'cloud'`，拆左栏会造成「N 个左栏项对 1 个引擎」的概念错位。

**备选（弃）**：D 的唯一优点是「首屏最直白」，但 B 的 tags + C 的分区已达成同等发现性，且可扩展。

### D5 — 空类型区行为与「添加实例」入口位置

**决定**：分区始终显示所有 `ASR_PROVIDER_TYPES`（含无实例的类型），空区显示一行「添加即用」提示与区内「添加实例」按钮；有实例的区展开列出实例。移除顶部「添加实例 ▾」下拉（其职责下沉到各区按钮）。

**理由**：始终展示全部类型才能让「支持哪些家」自解释（哪怕未配置）；区内添加按钮语义更直接（点哪个区加哪种），省掉再选类型一步。**代价**：类型多时纵向变长——可对空区默认折叠收敛（沿用 sherpa 的 `Collapsible` 默认态：有实例/首个展开）。

### D7 — 协议型多实例 vs 品牌型硬单例（`multiInstance` 标记）

**决定**：给 `AsrProviderType` 加可选 `multiInstance?: boolean`，把服务商类型分成两类，仅影响面板呈现：

- **协议型**（`multiInstance: true`，如 OpenAI 兼容）：同一协议对应多家 vendor / 多个 base URL（OpenAI、Groq、硅基流动…），保留「添加实例」按钮，可加任意多个；显示实例计数；空区给 `typeEmpty` 提示。
- **品牌型**（留空 = falsy，如 ElevenLabs / Deepgram）：固定单一服务端，**硬单例**——未配置时区内显示「配置」按钮（点一次即建唯一实例并选中），已配置后**不再显示任何「添加」入口**（封顶 1）；不显示计数；空区不显示 `typeEmpty`（「配置」按钮本身自解释）。`handleAdd` 对品牌型加守卫：已存在实例则只选中、不新建。

**理由**：上一轮 C（按类型分区）在品牌型上产生了「为固定服务商添加多个实例」的无意义入口——ElevenLabs / Deepgram 是单账号单端点，多实例既无场景又造成困惑。用一个声明式标记区分「协议 vs 品牌」，让 UI 语义自然贴合各家真实形态，是最干净的做法。**代价**：`AsrProviderType` 增一字段 + 面板按标记分流渲染；纯呈现、后端与 `ASR_TRANSCRIBER_MAP` 分发零改动。

**备选（弃）**：

- 「全部按多实例」——即现状，品牌型出现无意义「添加」，被本轮否决。
- 「品牌型直接内联表单、不走左栏行」——两种交互模型并存、重构面更大且不一致；单例封顶 + 「配置」入口已达同等克制，成本更低。

**扩展指引**：新增一家服务商时，按其真实形态设 `multiInstance`——可对接多端点/多 vendor 的协议置 `true`，固定品牌服务留空即可。

### D6 — 分区数据用纯函数聚合，便于单测

**决定**：抽 `groupInstancesByType(providers, types)` 纯函数（无 React/electron），返回 `[{ type, instances }]` 按 `ASR_PROVIDER_TYPES` 顺序；`CloudAsrPanel` 消费其结果渲染。放可被 `test:engines` 引入的位置（如 `types/asrProvider.ts` 或 `renderer/lib`）。

**理由**：分区/排序/未知类型归置是易回归的纯逻辑，抽出后可单测（对齐项目「纯逻辑抽模块单测」惯例，如 `cloudAudioChunking` / `*Utils`）。顺带可为 D1 文案动态化留口（由 types 派生 subtitle/tags）。

## Risks / Trade-offs

- **文案与类型清单漂移**（新增类型忘了更文案）→ D6 预留「由 `ASR_PROVIDER_TYPES` 派生」路径；至少在 tasks 里把「加类型要同步文案」列为清单项。
- **面板纵向变长**（类型多 + 空区都显示）→ D5 空区折叠收敛。
- **重构回归**（实例增删/选中/测试连接）→ 复用现有卡片与逻辑，仅改容器分组；`test:engines` 覆盖 `groupInstancesByType`，手测覆盖增删/切换/测试。
- **i18n key 增改**→ `check:i18n` 守 zh/en 对齐。

## Migration Plan

- **纯呈现变更，无数据迁移**：`store.asrProviders` 结构与已存实例不变；老用户已配置的实例自动落入对应类型分区。
- **回滚**：还原 cloud 文案与 `CloudAsrPanel` 布局即可，后端 / 任务页 / 存储不受影响。

## Open Questions

- 空类型区默认折叠还是展开首个类型？（倾向：有实例的类型展开，无实例的折叠，沿用 sherpa 默认态。）
- D1 文案是否直接由 `ASR_PROVIDER_TYPES` 动态生成（subtitle/tags 免手工增补）？本期可先静态、留 D6 纯函数口，后续再动态化。
