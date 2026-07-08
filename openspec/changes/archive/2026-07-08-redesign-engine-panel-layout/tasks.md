## 1. 纯逻辑层（types/asrProvider.ts + 单测）

- [x] 1.1 给 `AsrProviderType` 增加可选 `shortName?: string`，为长名品牌型补充侧栏短名（豆包听写 / 腾讯云 / 阿里云 / 讯飞 等），不动 `name` 与后端逻辑
- [x] 1.2 新增 `buildCloudViews(providers, types?)` 纯函数：按 `ASR_PROVIDER_TYPES` 顺序产出 `{ viewId: 'cloud:<typeId>', type, instances, configured, orphan }`，复用 `groupInstancesByType` 的孤儿兜底语义（孤儿追加末尾、`orphan: true`）
- [x] 1.3 新增 `resolveSingletonInstance(providers, typeId)`（取该类型首个实例，无则 undefined）与 `resolveLegacyCloudView(providers, types?)`（legacy `'cloud'` → 首个已配置类型的 viewId，无已配置则首个类型）
- [x] 1.4 新增 `isEngineViewId(value)` 校验辅助：接受四个本地视图 id、legacy `'cloud'`、任意 `cloud:*` 前缀（宽进，加载后收敛）
- [x] 1.5 在 `scripts/test-engine-units.ts` 补单测：buildCloudViews 顺序/计数/就绪聚合/孤儿追加、resolveSingletonInstance、resolveLegacyCloudView（优先已配置）、isEngineViewId 宽进；`npm run test:engines` 通过

## 2. asrProviders 状态上提（单一事实源）

- [x] 2.1 抽 `useAsrProviders()` hook（renderer/hooks 或组件同目录）：平移 `CloudAsrPanel` 现有的加载（`getAsrProviders`）、`applyProviders`、500ms debounce 持久化 + 卸载 flush、`persistNow`，暴露 `providers / updateInstanceField / addInstance / removeInstance`
- [x] 2.2 `EngineModelTab` 改为经该 hook 持有 providers（替换现 `asrProviders` state 与 `refresh()` 内的 `getAsrProviders` 拉取），左栏状态点、计数、右栏面板消费同一份数据

## 3. 左栏分组导航（EngineModelTab）

- [x] 3.1 扩展 `EngineView` 为本地四视图 + `cloud:<typeId>` 形态；`useLocalStorageState` 校验器换用 `isEngineViewId`
- [x] 3.2 左栏渲染两组：「本地引擎」（现有条目与样式不变）+「云端听写」组（`buildCloudViews` 驱动）；云条目紧凑单行：品牌图标（`iconImg` 白底 chip / emoji 兜底，样式对齐 ProvidersTab 的 ProviderIcon）+ `shortName ?? name` + 多实例计数 + 就绪状态点；小屏横向滚动形态下组标题不渲染
- [x] 3.3 legacy 收敛：providers 首次加载后，若当前选中为 `'cloud'` 则一次性 `resolveLegacyCloudView` 并写回；`cloud:<未知类型>` 且无孤儿实例回落 builtin
- [x] 3.4 右栏头部适配云视图：标题=类型全名、徽标=该类型已就绪/未配置；清理旧 `'cloud'` 单视图的 badge/tone/subtitle 分支；云视图不渲染 `ModelLibrarySection`（沿用现行为）

## 4. 右栏云服务商面板（CloudProviderPanel 替代 CloudAsrPanel）

- [x] 4.1 新建 `CloudProviderPanel`：接收 `{ type, instances, orphan }` + hook 回调；顶部保留一条通用上传/隐私说明；平移 `CloudAsrPanel` 的字段渲染（`renderField`）、标签式/勾选式模型录入、密码可见切换、测试连接逻辑
- [x] 4.2 品牌型单例形态：表单直显绑定 `resolveSingletonInstance` 结果；无实例时展示字段默认值、首次编辑经 `buildInstanceFromPreset(type)` 惰性物化再应用编辑；无实例列表/「配置」按钮/改名输入；新增「清除配置」次要按钮 + AlertDialog 确认（删除单例、表单回默认）
- [x] 4.3 协议型多实例形态：常驻「快速添加」区（预设图标按钮 OpenAI / Groq / 硅基流动 + 自定义，点击新建并选中）；实例横向 chips（名称 + 就绪点）切换选中；表单头部含实例名输入、测试连接、常驻删除图标按钮（带确认）；空状态=快速添加区 + 引导文案
- [x] 4.4 孤儿类型形态：仅实例名列表 + 删除（无表单、无测试连接）
- [x] 4.5 删除 `CloudAsrPanel.tsx` 及 `EngineModelTab` 中对它的引用/`onProvidersChange` 回调链

## 5. i18n 与文案收敛

- [x] 5.1 新增 key：`engines.groups.local` / `engines.groups.cloud`、`cloudAsr.quickAdd`、`cloudAsr.clearConfig` / `clearConfigTitle` / `clearConfigDesc`、`cloudAsr.noInstances`（多实例空态引导）等，zh/en 同步
- [x] 5.2 收敛旧文案：删除 `engines.cloud.tags`（mega-tags）；`engines.cloud.subtitle` / `desc` 改组级通用口径；`cloudAsr.intro` 压缩为一句通用上传/隐私提示；清理不再使用的 `cloudAsr.configure` / `typeEmpty` 等 key
- [x] 5.3 `npm run check:i18n` 通过

## 6. 多实例面板体验迭代（用户反馈方案 A：行卡片 + 就地展开）

- [x] 6.a 纯函数：`nextInstanceName`（同类型去重命名 OpenAI → OpenAI 2…）、`matchAsrPreset`（base URL 归一化反查来源预设）+ `test:engines` 单测
- [x] 6.b `useAsrProviders.addInstance` 接入去重命名
- [x] 6.c `CloudProviderPanel` 多实例形态改行卡片 accordion：预设图标 + base URL 副标题 + 就绪点 + 常驻删除；点击条目就地展开表单（带 label 的实例名 + 字段 + 测试连接），同时仅展开一个
- [x] 6.d 快速添加区分态：空态醒目 outline 按钮组 + 引导文案；有实例后降级为列表尾部轻量 ghost 一行
- [x] 6.e spec/design 文档同步（协议型要求补「可区分身份 + 就地展开 + 去重命名」；D4 更新为 v2）

## 7. 协议型二次迭代（用户反馈方案 Y：预设上侧栏，对齐翻译服务商双列表范式）

- [x] 7.1 types：`CloudEngineView` 改 kind 模型（`brand`/`preset`/`custom`/`orphan`，含 `label`/`preset`/`instance`/`orphanInstances`）；新增 `cloudPresetViewId` / `cloudCustomViewId`，`cloudViewTypeId` 取首段；`AsrProvider` 增可选 `presetId` 来源标记
- [x] 7.2 `buildCloudViews` 重写为逐条目产出：品牌一条、协议型=预设槽位（认领规则：presetId 显式 > 名称+URL 双匹配，改名不认领）+ 自定义逐实例、孤儿兜底；`resolveLegacyCloudView` 泛化为「首个已配置条目」
- [x] 7.3 `useAsrProviders`：`addInstance` 打 presetId 标记；新增 `addCustomInstance(typeId, name, apiUrl?)`（去重命名）；移除 `resolveSingletonInstance` / `groupInstancesByType` 死代码
- [x] 7.4 `CloudProviderPanel` 收敛为单表单形态（brand/preset=清除配置；custom=改名+删除；orphan=列表+删除），移除 accordion / 快速添加区 / 实例列表
- [x] 7.5 `EngineModelTab`：云组渲染逐条目入口（图标+label+状态点，无计数徽标）；云组末尾固定「添加自定义」虚线入口 + 对话框（名称必填 / Base URL 可选）；失效视图持续收敛（优先同类型首条目，再 builtin）；右栏头部按 kind 取标题/副标题
- [x] 7.6 单测重写：id 编解码三形态、buildCloudViews 槽位认领/自定义/孤儿/改名不认领、legacy 回落（含自定义条目命中）、isEngineViewId 多段 id；`npm run test:engines` 通过（617 项）
- [x] 7.7 i18n：新增 `cloudAsr.{addCustom,addCustomDesc,baseUrlOptional}`；删除 `cloudAsr.{quickAdd,customPreset,noInstances}`；`instanceName` 改「名称」、`removeTitle/removeDesc` 改「配置」口径；zh/en 同步
- [x] 7.8 spec/design 文档同步（D1/D2/D3/D4/D5/D6/D7/D8 更新至 v3；spec delta 重写协议型基数与预设要求）

## 8. 验证与收尾

- [x] 8.1 `npm run test:engines` 与 lint 通过；确认未触碰 `main/service/asr/*`、`engineModels.ts`、`store` 结构
- [ ] 8.2 手测清单（待人工验证）：预设槽位（OpenAI/Groq/硅基流动）+ 7 品牌条目与状态点正确；品牌/预设直填→就绪→清除配置→回未配置（条目保留）；添加自定义（同名去重）→改名→删除→选中态就近回落；历史实例槽位认领（同名同 URL）与改名实例归自定义；测试连接（成对成败各一）；任务页「引擎 ▸ 模型」下拉分组与转写不受影响；legacy `'cloud'` 选中态迁移；孤儿类型可见可删；小屏横向导航不破版
- [x] 8.3 README（zh/en）云端听写小节入口描述对齐新布局（截图待人工更新）
