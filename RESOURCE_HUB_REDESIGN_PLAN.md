# 资源中心（Resource Hub）重构方案

> 状态：草案，待评审
> 范围：模型管理 + 翻译服务管理 + GPU 加速包管理 → 统一资源中心（Tab 化）
> 前置依赖：Vulkan GPU 接入（feat/vulkan-gpu 分支，已完成）

---

## 1. 背景与目标

### 1.1 现状痛点

| 模块           | 当前位置                                   | 问题                                                               |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| 模型管理       | 侧边栏独立页 `/modelsControl`              | 与翻译/加速割裂，新用户不知道"先要下模型"                          |
| 翻译服务管理   | 侧边栏独立页 `/translateControl`           | 同上                                                               |
| GPU 加速包管理 | 设置页内嵌卡片 `settings#gpu-acceleration` | 藏在设置里，发现成本高                                             |
| 全局状态       | 无                                         | 没有任何一处能一眼看到"我有哪些模型 / 开了哪些服务 / 跑的什么后端" |

三者本质都是**转写流水线的可插拔资源**，心智模型一致：浏览 → 安装/启用 → 在任务里消费。

### 1.2 目标

1. 一个统一入口「资源中心」，四个 Tab：**全景 / 模型 / 翻译服务 / 加速**
2. 全景 Tab = readiness dashboard：新用户首次上手的 checklist，老用户的状态总览
3. 其余 Tab 保持现有功能不减，呈现向"市场/集成库"风格靠拢
4. 导航降噪：侧边栏 6 项 → 5 项

### 1.3 非目标（本期不做）

- 不改变模型下载、服务商配置、加速包下载的底层 IPC 与数据结构
- 不引入 Provider `enabled` 字段（见 §5.3 设计决策）
- 不做在线模型市场（仍是内置 `modelCategories` 静态清单）

---

## 2. 信息架构

### 2.1 导航变化

```
变更前                          变更后
─────────                      ─────────
🖥 任务                         🖥 任务
🤖 模型管理        ┐            📦 资源中心   ← 新增（合并 3 处）
🌐 翻译管理        ┼─ 合并 →    ✏️ 字幕校对
✏️ 字幕校对        │            🎬 字幕合成
🎬 字幕合成        │            ⚙️ 设置（移除 GPU 卡片）
⚙️ 设置(GPU卡片)  ┘
```

### 2.2 路由与深链接

| 路由                                   | 内容                                           |
| -------------------------------------- | ---------------------------------------------- |
| `/{locale}/resources`                  | 资源中心，默认 `?tab=overview`                 |
| `/{locale}/resources?tab=models`       | 模型 Tab                                       |
| `/{locale}/resources?tab=providers`    | 翻译服务 Tab                                   |
| `/{locale}/resources?tab=acceleration` | 加速 Tab                                       |
| `/{locale}/modelsControl`              | **保留为薄重定向** → `resources?tab=models`    |
| `/{locale}/translateControl`           | **保留为薄重定向** → `resources?tab=providers` |

- Tab 状态进 URL query，刷新/分享/返回均可恢复
- 顶栏 GPU 指示器深链接：`settings#gpu-acceleration` → `resources?tab=acceleration`
- 设置页移除 `<GpuAccelerationCard />`，原位置放一行"GPU 加速已迁移至资源中心 →"的引导（一个版本后移除）

---

## 3. 全景 Tab（核心新增）

### 3.1 线框

```
┌────────────────────────────────────────────────────────────┐
│  资源中心                                          [刷新 ⟳] │
│  ┌──────┬──────┬──────────┬──────┐                          │
│  │ 全景 │ 模型 │ 翻译服务 │ 加速 │                          │
│  └──────┴──────┴──────────┴──────┘                          │
│                                                             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐│
│  │ 🤖 语音模型      │ │ 🌐 翻译服务     │ │ ⚡ GPU 加速     ││
│  │                 │ │                 │ │                ││
│  │ 已安装 3 个      │ │ 已配置 2 项     │ │ Vulkan 运行中  ││
│  │ medium · small  │ │ DeepLX · OpenAI │ │ RTX 3060       ││
│  │ · tiny          │ │                 │ │ 模式：自动      ││
│  │                 │ │                 │ │                ││
│  │ 推荐：large-v3   │ │ [+ 启用更多]    │ │ [可升级 CUDA]  ││
│  │ (32GB 内存)     │ │                 │ │                ││
│  │       [管理 →]  │ │       [管理 →]  │ │      [管理 →]  ││
│  └─────────────────┘ └─────────────────┘ └────────────────┘│
│                                                             │
│  ── 空状态示例（新用户）──────────────────────────────────  │
│  ┌─────────────────┐                                        │
│  │ 🤖 语音模型      │   ⚠ 尚未安装任何模型，                │
│  │ 未安装          │     无法开始转写任务                    │
│  │ [立即下载推荐模型]│  ← 一键下载推荐档位（按内存推荐）       │
│  └─────────────────┘                                        │
└────────────────────────────────────────────────────────────┘
```

### 3.2 三张状态卡的数据源（全部为现有 IPC，零后端改动）

| 卡片     | 数据                                    | IPC                                                                                                  |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 语音模型 | 已装列表 / 下载中 / 内存推荐档位        | `getSystemInfo` → `modelsInstalled` `downloadingModels` `totalMemoryGB` + `getRecommendedCategory()` |
| 翻译服务 | 已配置数量与名称                        | `getTranslationProviders` → 按 PROVIDER_TYPES 必填字段判定"已配置"                                   |
| GPU 加速 | 当前后端 / GPU 型号 / 模式 / 可升级提示 | `get-gpu-environment` + `get-active-backend` + `getSettings.gpuMode`                                 |

### 3.3 状态卡交互规则

- 每张卡：状态色（绿=就绪 / 黄=可优化 / 灰=未配置）+ 主 CTA + 「管理 →」切换到对应 Tab
- **空状态优先**：模型卡未安装时整卡变为引导态，主按钮"立即下载推荐模型"直接触发推荐档位中第一个模型的下载（复用 `DownModel` 流程），不强迫用户先理解模型分类
- 翻译服务卡空状态 CTA「启用翻译服务」→ providers Tab；GPU 卡复用现有状态推导逻辑（`deriveStatus` 的简化版）
- 监听 `active-backend-changed` / `downloadProgress` / `gpu-settings-changed`，全景实时刷新

---

## 4. 模型 Tab

**策略：整体平移，零功能改动。**现有 `modelsControl.tsx` 的页面主体已经是市场化形态（分类卡片 + 评分点 + 推荐徽章 + 安装状态），直接复用。

迁移映射：

| 现有                                                                                     | 迁移后                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pages/[locale]/modelsControl.tsx` 页面主体（标题行/下载源/导入/路径/CategoryCard 列表） | `components/resources/ModelsTab.tsx`                                            |
| 页内函数组件 `CategoryCard` `ModelRow` `RatingDots`                                      | `components/models/` 下独立文件（顺手解耦，便于全景复用 `ModelRow` 的状态徽章） |
| `pages/[locale]/modelsControl.tsx`                                                       | 薄重定向组件（`router.replace`）                                                |

注意点：

- `useLocalStorageState('downSource')` 保持 key 不变，用户偏好无缝迁移
- `downloadProgress` IPC 订阅从页面移到 Tab 组件，hub 页面不重复订阅

---

## 5. 翻译服务 Tab

**策略：保留 master-detail 布局整体平移，左列卡片化微调。**

| 现有                                                                                          | 迁移后                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pages/[locale]/translateControl.tsx` 主体（左列服务商列表 + 右侧 ProviderForm + 添加对话框） | `components/resources/ProvidersTab.tsx` |
| `pages/[locale]/translateControl.tsx`                                                         | 薄重定向组件                            |

### 5.1 文案语义调整（市场化的关键）

翻译服务不是"下载"，是"连接/启用"。左列每项增加状态徽章：

- ✅ **已配置**：必填字段（按 `PROVIDER_TYPES[].fields` 中 `required` 项）全部非空
- ○ **未配置**：点击进入右侧表单即"启用"流程

### 5.2 布局适配

hub 内 Tab 高度受限，master-detail 的左列从 `w-64 border-r` 改为可滚动窄列，整体结构不变。

### 5.3 设计决策：不加 `enabled` 字段

Provider 数据结构不含启用开关，任务页下拉本来就列出全部服务商。本期"开启的翻译服务"语义 = "已配置的服务商"，零数据迁移。若未来需要显式开关（在下拉中隐藏未启用项），再做 `enabled?: boolean` 默认 `true` 的增量迁移。

---

## 6. 加速 Tab

**策略：`GpuAccelerationCard` 整卡平移，不拆。**

刚完成的 Vulkan 重构里，状态卡 + 模式三选一 + 高级选项 + 检测详情是一个闭环，拆开会破坏"GPU 故事"的完整性。

| 现有                                                               | 迁移后                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `settings.tsx` 内 `<GpuAccelerationCard />`                        | `components/resources/AccelerationTab.tsx`（直接包一层渲染） |
| `Layout.tsx` 顶栏指示器 `router.push('settings#gpu-acceleration')` | `router.push('resources?tab=acceleration')`                  |
| 设置页原位置                                                       | 一行引导链接（过渡期）                                       |

`GpuAccelerationCard` 自身零改动（id 锚点保留无害）。

---

## 7. 任务页闭环（P1，可独立排期）

消费侧引导回供给侧，把环闭上：

- `TaskConfigForm` 模型下拉为空 → 下拉底部/旁边显示「去下载模型 →」链接到 `resources?tab=models`
- 翻译服务商下拉同理 →「去启用翻译服务 →」
- 此项不阻塞 hub 上线，独立提交

---

## 8. i18n 策略

**保留现有 namespace，不做 key 大迁移**——这是成本控制的关键决策：

- hub 页面加载：`makeStaticProperties(['common', 'resources', 'modelsControl', 'translateControl', 'settings', 'parameters'])`
- 新增 `resources` namespace（zh/en）：仅 hub 自身文案（约 20 个 key）：tab 名、全景卡片标题、状态文案、空状态 CTA、迁移引导
- `ModelsTab` 内部仍用 `useTranslation('modelsControl')`，`ProvidersTab` 用 `translateControl`，`AccelerationTab`（GpuAccelerationCard）用 `settings` —— 组件平移后翻译调用零改动

---

## 9. 实施任务拆分

按原子提交划分，每个任务独立可构建：

| #   | 任务                                                                                         | 改动文件                                                                                             | 工作量 |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| T0  | hub 骨架：`resources.tsx` 页面 + shadcn Tabs + URL query 同步 + 侧边栏新增入口（旧入口暂留） | `pages/[locale]/resources.tsx`（新）、`Layout.tsx`、`resources.json`×2（新）                         | S      |
| T1  | 模型 Tab：页面主体抽为 `ModelsTab` + `CategoryCard/ModelRow` 独立文件 + 旧页重定向           | `components/resources/ModelsTab.tsx`（新）、`components/models/*`（新）、`modelsControl.tsx`（改薄） | M      |
| T2  | 翻译服务 Tab：主体抽为 `ProvidersTab` + 已配置徽章 + 旧页重定向                              | `components/resources/ProvidersTab.tsx`（新）、`translateControl.tsx`（改薄）                        | M      |
| T3  | 加速 Tab：`GpuAccelerationCard` 平移 + 顶栏深链接改向 + 设置页引导行                         | `components/resources/AccelerationTab.tsx`（新）、`settings.tsx`、`Layout.tsx`                       | S      |
| T4  | 全景 Tab：三张状态卡 + 空状态 CTA + 实时刷新订阅                                             | `components/resources/OverviewTab.tsx`（新）                                                         | M      |
| T5  | 侧边栏收编：移除模型/翻译两个旧图标（资源中心入口已可用）                                    | `Layout.tsx`                                                                                         | XS     |
| T6  | 任务页闭环：下拉空状态跳转链接（P1）                                                         | `TaskConfigForm.tsx`                                                                                 | S      |
| T7  | 终验：typecheck + `yarn build` + 全 Tab 冒烟 + 深链接回归                                    | —                                                                                                    | S      |

依赖关系：T0 → {T1, T2, T3} 可并行 → T4（依赖三个 Tab 的组件就位）→ T5 → T6/T7。

---

## 10. 风险与缓解

| 风险                                     | 缓解                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| 老用户肌肉记忆（直达模型页）             | 旧路由薄重定向永久保留；T5 移除旧图标可推迟一个版本                            |
| hub 页面体积大（四个重 Tab）             | Tab 内容惰性挂载（`TabsContent` 仅激活时渲染，或 `forceMount=false` 默认行为） |
| master-detail 在 Tab 内高度计算          | `ProvidersTab` 用 `h-full` flex 布局承接，hub 容器给定 `flex-1 min-h-0`        |
| 全景与各 Tab 数据不同步                  | 统一经现有事件（`gpu-settings-changed` 等）+ Tab 切换时拉取，不引入新状态管理  |
| `settings#gpu-acceleration` 外部书签失效 | 设置页保留引导行；锚点 id 随卡片迁移仍有效                                     |

---

## 11. 验收清单

- [ ] 四个 Tab 均可达，URL 直链/刷新/返回行为正确
- [ ] 旧路由 `/modelsControl` `/translateControl` 重定向正确
- [ ] 模型下载/删除/导入/换路径功能与重构前一致
- [ ] 服务商增删改/测试翻译功能一致；已配置徽章准确
- [ ] GPU 卡片全功能一致；顶栏指示器点击落到加速 Tab
- [ ] 全景三卡状态准确；空状态 CTA 可用；下载推荐模型动线跑通
- [ ] macOS 下加速 Tab 仅显示状态卡+检测详情（沿用现有平台逻辑）
- [ ] zh/en 双语完整；typecheck 零新增错误；`yarn build` 通过
