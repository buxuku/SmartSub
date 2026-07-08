> 实现顺序：先抽纯函数地基（可单测、零 UI），再做面板分区（C），再改类别文案（B），最后文档与守卫。
> 非破坏红线：`main/service/asr/*`、`ASR_TRANSCRIBER_MAP`、任务页下拉、`store.asrProviders` 结构一律不动。

## 1. 分区数据纯函数（地基，零 UI）

- [x] 1.1 抽 `groupInstancesByType(providers, types = ASR_PROVIDER_TYPES)` 纯函数（`types/asrProvider.ts`，无 React/electron）：按 `types` 顺序返回 `[{ type, instances }]`（含空组）；未知 `type` 实例按原始 type 兜底追加末尾
- [x] 1.2 单测（`test:engines`）：混类型分组顺序正确、空类型返回空 instances、未知 type 兜底不丢实例、默认 types = `ASR_PROVIDER_TYPES` 顺序（280 passed）

## 2. C：CloudAsrPanel 按服务商类型分区

- [x] 2.1 `CloudAsrPanel` 消费 `groupInstancesByType`：遍历渲染各类型分区（标题 = `type.icon + type.name` + 实例计数），区内为该类型实例列表 + 「添加实例」按钮（调用 `handleAdd(type.id)`）
- [x] 2.2 移除顶部「添加实例 ▾」下拉（职责下沉到各区按钮）；空类型区显示 `typeEmpty` 提示 + 添加入口；`handleAdd` 未知类型 guard-return
- [x] 2.3 保留选中实例右侧凭据表单 + 测试连接（逻辑不变）；类型多时可后续加折叠（当前 3 类无需）
- [x] 2.4 复用现有实例卡片（名称/已就绪徽标/删除）与选中态；`onProvidersChange` 上抛保持不变；未知类型分区隐藏「添加」按钮

## 3. B：云端听写类别文案平级并列服务商类型（i18n）

- [x] 3.1 `renderer/public/locales/{zh,en}/resources.json`：`engines.cloud.subtitle` → `OpenAI 兼容 · ElevenLabs · Deepgram`
- [x] 3.2 `engines.cloud.tags` → `["OpenAI 兼容","ElevenLabs","Deepgram"]`（en 对应英文品牌）
- [x] 3.3 `engines.cloud.desc` 与 `cloudAsr.intro`：点名各家、去除「仅 OpenAI」措辞；新增 `cloudAsr.typeEmpty`
- [x] 3.4 `npm run check:i18n` 通过（zh/en key 对齐）

## 4. 文档

- [x] 4.1 README（zh/en）「云端听写」小节措辞对齐「多服务商 + 面板按类型分区」（截图后续人工更新）

## 5. 测试与回归

- [x] 5.1 `npm run test:engines` 通过（280 passed，含 §1.2 新增用例）
- [ ] 5.2 手测：已配置混类型实例各归其分区；区内添加新建对应类型；空类型区可见可添加
- [ ] 5.3 非破坏手测：任务页「引擎 ▸ 模型」下拉、转写分发、已存实例读写与变更前一致；左栏仍单一「云端听写」入口
- [x] 5.4 `ReadLints` 云面板与改动文件零告警

## 6. D7：协议型多实例 / 品牌型硬单例

- [x] 6.1 `types/asrProvider.ts`：`AsrProviderType` 加 `multiInstance?: boolean`；`openaiCompatible` 置 `true`，ElevenLabs / Deepgram 留空（默认单例）
- [x] 6.2 `CloudAsrPanel`：按 `type.multiInstance` 分流——协议型保留「添加实例」+ 实例计数 + 空区 `typeEmpty`；品牌型未配置显「配置」、已配置无「添加」（封顶 1）、不显计数/空提示
- [x] 6.3 `handleAdd` 品牌型守卫：同类型已存在实例则只选中既有、不新建
- [x] 6.4 i18n：新增 `cloudAsr.configure`（zh/en）；`cloudAsr.intro` 措辞改为「协议型可多实例 / 品牌型各配置一个」
- [ ] 6.5 手测：OpenAI 兼容可加多个；ElevenLabs / Deepgram 未配置显「配置」、配置后「添加」入口消失；删除后回到「配置」
- [x] 6.6 `check:i18n` + `test:engines` + `ReadLints` 通过
