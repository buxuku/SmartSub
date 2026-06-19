## 1. 新增两个顶级页面

- [x] 1.1 新增 `pages/[locale]/engines.tsx`：整页渲染既有 `EngineModelTab`（无外层 Tabs）；`makeStaticProperties(['common','resources','modelsControl','settings','parameters'])`
- [x] 1.2 新增 `pages/[locale]/translation.tsx`：整页渲染既有 `ProvidersTab`；`makeStaticProperties(['common','translateControl','parameters'])`
- [x] 1.3 各页加 `PageHeader`（标题/描述用 common 的 `enginesAndModels(Desc)` / `translationServices(Desc)`）

## 2. 重定向矩阵

- [x] 2.1 `pages/[locale]/resources.tsx` 改薄重定向：无 tab / `overview` / `engines` / `models` → `/engines`；`providers` → `/translation`；`acceleration` → `/engines`（写 `engineModelSelectedView='builtin'` 后跳）
- [x] 2.2 `pages/[locale]/modelsControl.tsx` → 重定向 `/engines`
- [x] 2.3 `pages/[locale]/translateControl.tsx` → 重定向 `/translation`
- [ ] 2.4 冒烟覆盖六类旧地址（含带 query）重定向正确（需运行 App）

## 3. 侧边栏与全局入口

- [x] 3.1 `Layout.tsx#NAV_ITEMS`：移除单一「资源中心」，新增「引擎与模型」(`/engines`, icon `Cpu`) 与「翻译服务」(`/translation`, icon `Languages`)；`isActive` 匹配各自路径（含旧 `/resources`、`/modelsControl`、`/translateControl`）
- [x] 3.2 下载 pill 跳转 `resources?tab=engines` → `/engines`
- [x] 3.3 顶栏加速徽章直接改向 `/engines`（写 builtin）；并把 InlineConfigBar / home / OnboardingDialog 的内部链接改向新路由，避免重定向闪烁
- [x] 3.4 移除未使用的 `Package` 图标导入，新增 `Cpu` / `Languages`

## 4. 删除 overview

- [x] 4.1 删除 `components/resources/OverviewTab.tsx` 与 `resources.tsx` 的 Tabs 容器/`RESOURCE_TABS`；并删除已成孤儿的 `AccelerationTab.tsx`
- [x] 4.2 首启 onboarding（`Layout` 的 `hasAnyModelAnyEngine` 自动唤起）逻辑未改动，仍工作
- [x] 4.3 清理对 `OverviewTab`/`AccelerationTab` 的引用与未使用 import（tsc 零悬挂引用）

## 5. i18n

- [x] 5.1 `common`（zh/en）新增 `enginesAndModels`/`enginesAndModelsDesc`/`translationServices`/`translationServicesDesc`
- [x] 5.2 删除 `resources.json` 的 `tab.*` 与 `overview.*`（已不再引用）；`node scripts/check-i18n.mjs` 通过

## 6. 校验

- [x] 6.1 `npx tsc --noEmit -p renderer/tsconfig.json`（改动文件零错误）全绿
- [ ] 6.2 冒烟：两新菜单可达；`/engines` 含引擎+模型(+GPU via 前置变更)；`/translation` 含翻译服务增删改/测试（需运行 App）
- [ ] 6.3 冒烟：六类旧地址 + 顶栏徽章 + 下载 pill 全部落到正确新页（需运行 App）
- [ ] 6.4 冒烟：全新环境首启自动唤起 onboarding；删 overview 后无控制台报错/悬挂引用（需运行 App）
