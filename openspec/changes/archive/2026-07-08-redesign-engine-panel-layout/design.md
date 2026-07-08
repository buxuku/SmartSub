## Context

「引擎与模型」页是主从双栏：左栏 `ENGINE_VIEWS = [builtin, fasterWhisper, sherpa, localCli, cloud]`，右栏渲染选中视图的运行时面板。云端听写整体折叠在**一个** `cloud` 入口下，`CloudAsrPanel` 内部再做一层主从：左列按 `ASR_PROVIDER_TYPES` 分区（现已 8 区）+ 区内实例行 + 「配置/添加实例」按钮，右列实例表单。

规模变化引发的实际问题（proposal 详述）：三层嵌套、单例的「实例」壳、预设与品牌可见性差、左栏 cloud 条目 tags 溢出破版。

相关现状与约束：

- `types/asrProvider.ts` 是类型唯一事实源：`ASR_PROVIDER_TYPES`（含 `multiInstance` / `icon` / `iconImg` / `fields`）、`ASR_PROVIDER_PRESETS`、纯函数（`groupInstancesByType` / `buildInstanceFromPreset` / `isAsrProviderConfigured` / `parseAsrModels`）均有 `test:engines` 单测。
- `EngineModelTab` 已经为左栏就绪点拉取 `asrProviders`；`CloudAsrPanel` 又自己拉一份并管 debounce 持久化（`setAsrProviders` 全量写）——两处各持状态，靠 `onProvidersChange` 上抛同步。
- 选中视图持久化于 localStorage `engineModelSelectedView`（带校验器），`Layout.tsx` / `OnboardingDialog` / `resources.tsx` 会直写 `'builtin'` 做深链。
- 后端契约（不可动）：引擎 id 恒 `'cloud'`，按实例 `type` 经 `ASR_TRANSCRIBER_MAP` 分发；任务页「引擎 ▸ 模型」下拉按已配置实例分组（`getEngineModelGroups`）；`store.asrProviders` 为实例数组。
- 可抄范式：翻译服务商页（`ProvidersTab`）的 `ProviderIcon`（品牌 logo 白底圆角 chip，深色模式可见）。

## Goals / Non-Goals

**Goals:**

- 左栏一眼可见全部云服务商平台（平级入口、品牌图标），并与本地引擎有清晰分组边界。
- 单例服务商「进来就是表单」：填了就能用，删掉凭据即未配置——零实例管理概念。
- OpenAI 兼容的预设（OpenAI / Groq / 硅基流动）常驻可见。
- 消掉一层嵌套：任何配置项 ≤2 次点击可达（选服务商 → 填表单）。
- 保持非破坏：后端 / 任务页 / 存储零改动；`engineModelSelectedView` 历史值平滑迁移。

**Non-Goals:**

- 不改任何服务商的字段定义、`transcribe` 实现、测试连接逻辑与音频上限声明。
- 不改任务页「引擎 ▸ 模型」下拉与 `EngineModelGroup` 编码（`cloud::<asrProviderId>::<model>`）。
- 不做云服务商的启用/禁用开关、排序拖拽、搜索过滤（当前规模不需要）。
- 不动本地引擎四个视图的面板内容（builtin / fasterWhisper / sherpa / localCli 面板本体零改动）。

## Decisions

### D1 — 左栏两组分区：本地引擎组照旧，云组逐条目平级入口（一条目一表单）

**决定**（v3，随 D4 迭代）：左栏渲染两个带组标题的分组：

```
本地引擎                      ← engines.groups.local
  [🎛] whisper.cpp（内置）     ● 现有两行样式（名称 + tags + 状态点）不变
  [⚡] faster-whisper          ●
  [〰] 本地多模型聚合           ●
  [>_] 本地命令行              ●
云端听写                      ← engines.groups.cloud
  [🤖] OpenAI                 ●  ← 协议型预设槽位（固定常驻，kind=preset）
  [⚡] Groq                    ●
  [🧊] SiliconFlow 硅基流动    ●
  [🎙] 我的中转                ●  ← 用户自定义实例（kind=custom，逐实例一条）
  [🗣] ElevenLabs             ●  ← 品牌型单例（kind=brand）
  [🐬] Deepgram               ●
  [logo] 豆包听写              ●
  [logo] 腾讯云               ●
  [logo] 阿里云               ●
  [logo] 讯飞听写              ●
  [🎧] Gladia                 ●
  [+] 添加自定义                  ← 固定在云组末尾的虚线入口（对话框新建）
```

- 云组条目**数据驱动**（`buildCloudViews`，见 D6/D7）：品牌型类型一条；协议型类型展开为「每个预设一个固定槽位 + 每个自定义实例一条」；孤儿类型兜底追加（D6）。新增服务商类型或预设 = types/presets 数组加一条，侧栏自动出现。
- 云条目用**紧凑单行**（无 tags、无计数）：品牌/预设图标（`iconImg` 白底 chip，复用 `ProvidersTab.ProviderIcon` 的样式约定）或 emoji `icon` 兜底 + 显示名 + 就绪状态点。**每个条目背后至多一个实例**，状态点即该实例已配置与否（`isAsrProviderConfigured`）。
- 给 `AsrProviderType` 加可选 `shortName?: string`（如「腾讯云 录音识别极速版」→「腾讯云」）供侧栏；右栏标题仍用全名。品牌名非 UI 文案，留在 types 不进 i18n。
- 「添加自定义」按用户决策**固定在云组末尾**（虚线次要样式，不参与选中态），点击弹对话框（名称必填 + Base URL 可选）新建 OpenAI 兼容自定义实例并跳转其条目。
- 小屏（现有横向滚动形态）组标题降级为不渲染，条目顺序不变——沿用现 nav 的 `overflow-x-auto` 行为。

**理由**：面板内那列 8 个类型盒子事实上已是「第二根侧栏」，上提为真侧栏分组反而**少一层**结构；预设直接成为侧栏条目后，「多实例管理」概念从 UI 消失，云组全体条目获得与品牌型一致的「选中即表单」心智（对齐翻译服务商页的双列表范式）；品牌 logo 外显直接达成可见性目标。**代价**：显式推翻 cloud-asr-provider-grouping 的「单一云入口」要求——由本变更的 spec delta 承接（RENAMED/MODIFIED）；侧栏行数随自定义实例数增长（预期个位数，`md:overflow-y-auto` 可滚）。

**备选（弃）**：

- 顶部 Tab「本地 | 云端」切换左栏内容：多一次点击才能看见云平台清单，可见性反而不如常驻分组；且两个 Tab 各持选中态，状态机复杂。
- 维持单入口、只优化面板内分区（折叠/横向 chips）：不解决三层嵌套与 tags 溢出，治标。

### D2 — `EngineView` 扩展 `cloud:*` 家族 id，legacy `'cloud'` 平滑映射

**决定**（v2，随 D4 迭代）：视图 id 形态 `type EngineView = 'builtin' | 'fasterWhisper' | 'sherpa' | 'localCli' | 'cloud:${string}'`。云 id 三种：`cloud:<typeId>`（品牌型/孤儿类型）、`cloud:<typeId>:<presetId>`（协议型预设槽位）、`cloud:<typeId>:i:<instanceId>`（协议型自定义实例）；构造/解析经 `cloudViewId` / `cloudPresetViewId` / `cloudCustomViewId` / `cloudViewTypeId`（取首段类型 id）。

- localStorage 校验器（`isEngineViewId`）接受：四个本地 id、legacy `'cloud'`、任意非空 `cloud:*` 前缀（孤儿/失效条目只有加载后才可知，先宽进）。
- **legacy 迁移**：读到旧值 `'cloud'` → `asrProviders` 加载后解析为「首个已配置条目，无则云组首条目」并写回（纯函数 `resolveLegacyCloudView(providers)`）。
- **失效条目收敛**（持续生效，非仅一次）：`cloud:*` 未命中当前条目清单（自定义条目被删 / 类型下线且无孤儿实例 / 旧格式 id）→ 优先回落**同类型首个条目**（如 OpenAI 预设槽位），无同类条目再回落 builtin。
- 既有直写 `'builtin'` 的三处深链（GPU 徽章 / onboarding / resources 重定向）无需改动。

**理由**：id 分段编码条目身份（类型/预设/实例），与 `buildCloudViews` 产物一一对应、无需注册表；宽进严出兼顾「校验器同步执行、实例异步加载」的时序；「同类型优先」让删除自定义实例后落回最近的相关条目而非跳回本地组。**代价**：`EngineView` 从有限枚举变为开放形态，遍历处需用 `buildCloudViews()` 产物而非静态数组。

### D3 — 品牌型单例与预设槽位：表单直显 + 惰性物化 + 「清除配置」

**决定**（v2，预设槽位随 D4 并入同一形态）：选中品牌型条目（kind=brand）或协议型预设槽位（kind=preset），右栏直接渲染该条目凭据表单：

- **绑定**：条目由 `buildCloudViews` 产出时已绑定至多一个实例（brand=该类型首个实例；preset=按认领规则命中的实例，见 D4）；无实例时表单展示默认值（brand=字段 `defaultValue`；preset=默认值+预设预填，经 `buildInstanceFromPreset(type, preset)`）。
- **惰性物化**：首次字段编辑时若无实例，先物化再应用该次编辑（preset 物化时在实例上打 `presetId` 标记），走既有持久化——存储结构零改动；历史已存实例原样接管。
- **去实例壳**：无实例列表、无「配置」按钮；brand/preset 条目无改名输入（显示名即类型短名/预设名）。
- **清除配置**：次要按钮 + AlertDialog 确认 → 删除条目背后实例，表单回默认值、状态回「未配置」，**条目本身保留**（品牌与预设槽位恒驻侧栏）。
- 「测试连接」「就绪徽标」沿用现逻辑与 `isAsrProviderConfigured` 口径。

**理由**：单例场景「实例」纯属实现细节泄漏进 UI；表单直显把配置成本降到理论下限（选中即填）。预设槽位并入同一形态后，OpenAI/Groq 的配置体验与 ElevenLabs 完全一致——用户无需理解「协议型 vs 品牌型」。惰性物化避免「打开面板就写库」产生空实例污染存储。**代价**：「表单有默认值但未持久化」与「已持久化」两态并存——以头部徽标（未配置/已就绪）作为唯一状态口径。

**备选（弃）**：挂载即物化全部单例（10+ 条空实例常驻存储，脏）；保留单例实例行 + 表单（即现状，壳未去掉）。

### D4 — 协议型（OpenAI 兼容）：预设直接成为侧栏槽位条目 + 自定义逐实例条目

**决定**（v3，按用户反馈两轮迭代：chips + 分离表单 → 行卡片 accordion → 预设上侧栏，对齐翻译服务商页双列表范式）：协议型类型不再有「多实例管理面板」——其存在形态完全摊平进左栏云组：

1. **预设槽位条目**（kind=preset，恒驻）：每个 `ASR_PROVIDER_PRESETS` 预设（OpenAI / Groq / 硅基流动）一个固定侧栏条目，行为与品牌型单例完全一致（表单直显 + 惰性物化 + 清除配置，见 D3）；物化实例打 `presetId` 标记。
2. **槽位认领规则**（`buildCloudViews`，每槽至多一实例）：① 实例 `presetId` 显式指向该预设（改 URL 不漂移）；② 兼容历史：无 `presetId` 且名称与 base URL 均与预设一致（`matchAsrPreset` 归一化匹配）。改过名/URL 的历史实例**不被认领**（保留用户身份，成为自定义条目）。
3. **自定义实例条目**（kind=custom，逐实例）：未被槽位认领的实例每个一条，显示名=实例名；面板含可编辑「名称」字段 + 常驻「删除」（带确认，删除移除整个条目）。
4. **「添加自定义」入口**固定在云组末尾（虚线按钮）：对话框收集名称（必填）+ Base URL（可选），`nextInstanceName` 同类型去重命名（`OpenAI` → `OpenAI 2`…），创建后跳转新条目。

**理由**：预设升为侧栏条目使诉求 2（预设外显）达到最强形态——打开页面即见 OpenAI / Groq，且与品牌型共享同一「选中即表单」心智，「实例」概念从 UI 全面消失；与翻译服务商页（内置服务商列表 + 添加自定义）范式对齐，学习成本为零。**代价**：侧栏行数随自定义实例增长（预期个位数）；槽位认领需处理历史数据歧义（presetId 标记 + 名称/URL 双匹配兜底，改过名的历史实例按自定义对待）。

**备选（弃）**：横向 chips + 下方分离表单（v1：同名不可区分、对应关系弱）；行卡片 accordion（v2 已实现后废弃：面板内仍残留「实例列表」心智，与品牌型形态割裂）；面板内嵌套双列表（v2.5 讨论稿：多一层内部导航，与「侧栏即入口」矛盾）。

### D5 — `asrProviders` 状态上提：`EngineModelTab` 单一持有，面板收 props

**决定**：把实例数组的加载 / 更新 / debounce 持久化从 `CloudAsrPanel` 上提为 `useAsrProviders()` hook（加载 `getAsrProviders`、`updateInstanceField` / `addInstance`（可带 presetId 打标）/ `addCustomInstance`（名称+可选 URL，自动去重命名）/ `removeInstance`、500ms debounce `setAsrProviders` 全量写 + 卸载 flush），由 `EngineModelTab` 持有；按条目传给右栏面板组件：

- `CloudProviderPanel`（新，替代 `CloudAsrPanel`）：接收单个 `CloudEngineView` 条目，按 `kind` 微分流（brand/preset=直显表单+清除配置；custom=直显表单+改名+删除；orphan=实例名列表+删除）；字段渲染（`renderField` / 标签式模型录入 / 密码可见切换）与测试连接逻辑从 `CloudAsrPanel` 平移复用。
- 左栏状态点直接消费同一份 providers——删除现有「面板自拉一份 + `onProvidersChange` 上抛」的双份状态。

**理由**：左栏云条目的状态点、右栏面板、legacy 视图解析（D2）都要读 providers，单一事实源消除同步时序问题（现两处各自 `getAsrProviders`，靠回调对齐）。**代价**：`CloudAsrPanel` 大部分重写为 `CloudProviderPanel`；测试连接、字段渲染逻辑需完整平移，回归面集中在此。

### D6 — 孤儿类型兜底：仍生成侧栏入口，可查可删

**决定**：`buildCloudViews(providers)` 纯函数产出云组条目清单：已知类型条目（品牌一条 / 协议型=预设槽位+自定义逐条，`ASR_PROVIDER_TYPES` 顺序）+ 孤儿类型追加末尾（type 不在已知清单的实例按原始 type 归组为一个 kind=orphan 条目，携带全部遗留实例）。孤儿视图右栏仅展示实例名列表与删除入口（无表单、无测试连接）。

**理由**：类型下线后用户数据不能凭空消失（与原分组兜底等价，只是载体从面板分区变为侧栏条目）。原 `groupInstancesByType` 的兜底语义并入 `buildCloudViews`（原函数随旧面板一并移除）。

### D7 — 纯逻辑抽函数 + 单测（对齐 `test:engines` 惯例）

**决定**：新增纯函数集中在 `types/asrProvider.ts`（或就近模块），`scripts/test-engine-units.ts` 补用例：

- `buildCloudViews(providers, types?, presetsByType?)` → `CloudEngineView[]`（`{ viewId, kind, type, label, icon/iconImg, preset?, instance?, orphanInstances?, configured }`）：条目顺序 / 槽位认领（presetId 优先、名称+URL 兜底、改名不认领）/ 自定义追加 / 孤儿兜底 / 就绪判定；
- `cloudViewId` / `cloudPresetViewId` / `cloudCustomViewId` / `cloudViewTypeId`（id 编解码）；
- `matchAsrPreset(instance, presets?)`（base URL 归一化反查预设）与 `nextInstanceName(existing, base)`（去重命名）；
- `resolveLegacyCloudView(providers, types?)`（`'cloud'` → 首个已配置条目视图 id，无则首条目）；
- `isEngineViewId(value)`（localStorage 校验器用，宽进 `cloud:*`）。

**理由**：条目清单 / 槽位认领 / legacy 映射是易回归纯逻辑，项目惯例是抽纯函数进 `test:engines`。

### D8 — i18n 收敛

**决定**：新增 `engines.groups.{local,cloud}`、`cloudAsr.{addCustom,addCustomDesc,baseUrlOptional,clearConfig,clearConfigTitle,clearConfigDesc,orphanHint}` 等 key；`engines.cloud.tags`（单入口 mega-tags）与 `engines.cloud.subtitle/desc` 删除；随预设上侧栏（D4 v3）一并删除面板内快速添加时代的 `cloudAsr.{quickAdd,customPreset,noInstances}`；`cloudAsr.intro` 压缩为一句通用隐私/上传提示，展示在每个云服务商面板顶部；`cloudAsr.instanceName` 改「名称」（仅自定义条目表单用）。`npm run check:i18n` 守 zh/en 对齐。

## Risks / Trade-offs

- **[推翻既有 spec 要求]** 与 cloud-asr-provider-grouping 的「单一云入口」正面冲突 → 本变更 spec delta 显式 RENAMED/MODIFIED 该要求并陈述规模前提变化（3 类型 → 8 类型），不留两份矛盾规格。
- **[侧栏纵向变长]** 4 本地 + 3 预设槽位 + 7 品牌 + 自定义 N 条 + 「添加自定义」在低矮窗口需滚动 → 云条目单行紧凑（≈32px）、nav 已有 `md:overflow-y-auto`；分组标题不做 sticky，避免遮挡；自定义实例预期个位数。
- **[CloudAsrPanel 重写回归]** 字段渲染 / 模型标签录入 / 测试连接 / debounce 持久化平移中出错 → 逻辑整块平移不重写；增删改查与测试连接列入手测清单；纯逻辑（视图清单 / 单例解析 / legacy 映射）进 `test:engines`。
- **[惰性物化边界]** 用户填了一半清空所有字段——实例已物化、判定未配置 → 可接受：头部徽标「未配置」即唯一口径；「清除配置」可随时抹掉残留。
- **[localStorage 时序]** legacy `'cloud'` 解析依赖异步 providers → 渲染先按云组首类型显示，加载后一次性收敛写回；`cloud:*` 宽进严出（未知类型回落 builtin）。
- **[i18n key 漂移]** 删 `engines.cloud.tags` 等 key 时 zh/en 不同步 → `check:i18n` CI 守卫。

## Migration Plan

纯呈现层重构，无数据迁移：

1. `store.asrProviders` 结构零改动（新实例可带可选 `presetId` 标记，旧数据无此字段照常工作）；品牌型历史实例被条目原样接管；协议型历史实例按槽位认领规则归位（名称+URL 均与预设一致→认领对应槽位；否则成为自定义条目，含改过名的实例）。
2. `engineModelSelectedView` 旧值 `'cloud'` 按 D2 一次性映射写回；其余旧值不受影响。
3. 回滚 = 还原 `EngineModelTab` / 恢复 `CloudAsrPanel`（git revert 级别），存储与后端无残留。

## Open Questions

- 各品牌 `shortName` 取值（「豆包听写 / 腾讯云 / 阿里云 / 讯飞」等）实现时按侧栏宽度微调，不阻塞设计。
- 云组是否需要一个组级聚合视图（点组标题看全部云实例总览）——本期不做，规模到 15+ 类型再议。
