## Why

资源中心当初把「模型 + 翻译 + 加速」合并为一个 Tab 化入口（见 `RESOURCE_HUB_REDESIGN_PLAN.md`），目的是降噪 + 给新用户一个「全景」就绪清单。但在两步重构之后，这个「中心」的合并价值被显著稀释：

- `fold-gpu-into-builtin`：加速不再是独立 Tab（已并入 builtin 引擎）。
- `merge-sherpa-engines-ui`：引擎面更内聚。

于是资源中心实际只剩 **引擎与模型** + **翻译服务** 两个领域，二者一个是「转写供给」、一个是「翻译供给」，彼此独立、各自已是一个信息充实的页面，**共处一个 hub 并不增添综合价值**，反而多一层 Tab 切换。「全景」仪表盘的综合价值也随之减弱（新手引导已有独立的 `OnboardingDialog`）。

因此：删除「全景」Tab，把资源中心**拆为两个独立侧边菜单**——「引擎与模型」与「翻译服务」，让用户少一层嵌套直达目标。

## What Changes

- **删除「全景 / overview」Tab 与 `OverviewTab`**：首启就绪引导交由既有 `OnboardingDialog`；跨引擎就绪判断（`hasAnyModelAnyEngine`）逻辑保留复用处不受影响。
- **拆为两个顶级侧边菜单**：
  - 「引擎与模型」（承载原 `engines` Tab 内容，已含 GPU 加速 via `fold-gpu-into-builtin`）；
  - 「翻译服务」（承载原 `providers` Tab 内容）。
- **路由与重定向**：新增 `/engines`、`/translation` 两个顶级路由；`/resources`（及 `?tab=*`）、`/modelsControl`、`/translateControl` 做薄重定向到对应新页（保住旧深链接 / 书签）。
- **侧边栏**：由「任务 / 资源中心 / 字幕校对 / 字幕合成 / 设置」改为「任务 / **引擎与模型** / **翻译服务** / 字幕校对 / 字幕合成 / 设置」。
- **全局入口改向**：顶栏加速徽章（已由 `fold-gpu-into-builtin` 指向 builtin）、下载 pill（现 `resources?tab=engines`）改指 `/engines`。
- **不在本次范围**：不改各 Tab 内部功能（引擎 / 模型 / 翻译服务的增删改与下载）；不改 GPU 折叠本身（前置变更已处理）。

## Capabilities

### New Capabilities

<!-- 无新增能力；细化 engine-model-management 在「资源导航信息架构」上的契约。 -->

### Modified Capabilities

- `engine-model-management`: 新增需求——资源管理拆分为「引擎与模型」「翻译服务」两个独立顶级导航，移除统一资源中心的「全景」Tab；旧路由薄重定向到新页。

## Impact

- **渲染层**：
  - `Layout.tsx`：`NAV_ITEMS` 用「引擎与模型」「翻译服务」替换单一「资源中心」；下载 pill 跳转改 `/engines`。
  - 新增页面 `pages/[locale]/engines.tsx`（渲染原 `EngineModelTab`）、`pages/[locale]/translation.tsx`（渲染原 `ProvidersTab`）；`makeStaticProperties` 各自带所需 namespace。
  - `pages/[locale]/resources.tsx`：改薄重定向（默认→`/engines`；`?tab=providers`→`/translation`；`?tab=acceleration`→`/engines` 选中 builtin；`?tab=models`/`engines`→`/engines`）。
  - `pages/[locale]/modelsControl.tsx` / `translateControl.tsx`：重定向目标改为 `/engines` / `/translation`。
  - 删除 `OverviewTab.tsx` 及资源中心 Tab 容器（`resources.tsx` 不再用 Tabs）。
- **i18n**：`common` namespace 新增侧边栏标签「引擎与模型」「翻译服务」；移除/保留 `resources.tab.overview`、`overview.*`（按是否仍被引用清理）。
- **不变**：`EngineModelTab` / `ProvidersTab` 内部实现、各引擎/模型/翻译 IPC、`OnboardingDialog`。
- **依赖关系**：依赖 `fold-gpu-into-builtin` 先腾空「加速」Tab（GPU 已有 builtin 家）；建议 `merge-sherpa-engines-ui` 一并或先行，使「引擎与模型」页呈现合并后的引擎面。
