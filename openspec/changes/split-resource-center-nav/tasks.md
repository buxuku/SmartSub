## 1. 新增两个顶级页面

- [ ] 1.1 新增 `pages/[locale]/engines.tsx`：整页渲染既有 `EngineModelTab`（去外层 Tabs）；`makeStaticProperties(['common','resources','modelsControl','settings','parameters'])`
- [ ] 1.2 新增 `pages/[locale]/translation.tsx`：整页渲染既有 `ProvidersTab`；`makeStaticProperties(['common','resources','translateControl'])`
- [ ] 1.3 各页加 `PageHeader`（标题/描述对齐原 Tab 文案）

## 2. 重定向矩阵

- [ ] 2.1 `pages/[locale]/resources.tsx` 改薄重定向：无 tab / `overview` / `engines` / `models` → `/engines`；`providers` → `/translation`；`acceleration` → `/engines`（写 `engineModelSelectedEngine='builtin'` 后跳）
- [ ] 2.2 `pages/[locale]/modelsControl.tsx` → 重定向 `/engines`
- [ ] 2.3 `pages/[locale]/translateControl.tsx` → 重定向 `/translation`
- [ ] 2.4 冒烟覆盖六类旧地址（含带 query）重定向正确

## 3. 侧边栏与全局入口

- [ ] 3.1 `Layout.tsx#NAV_ITEMS`：移除单一「资源中心」，新增「引擎与模型」(`/engines`, icon `Cpu`) 与「翻译服务」(`/translation`, icon `Languages`)；`isActive` 匹配各自路径
- [ ] 3.2 下载 pill 跳转 `resources?tab=engines` → `/engines`
- [ ] 3.3 确认顶栏加速徽章目标（由 `fold-gpu-into-builtin` 指向 builtin）随新路由生效

## 4. 删除 overview

- [ ] 4.1 删除 `components/resources/OverviewTab.tsx` 与 `resources.tsx` 的 Tabs 容器/`RESOURCE_TABS`
- [ ] 4.2 确认首启 onboarding（`Layout` 的 `hasAnyModelAnyEngine` 自动唤起）仍工作
- [ ] 4.3 清理对 `OverviewTab` 的引用与未使用 import

## 5. i18n

- [ ] 5.1 `common`（zh/en）新增侧边栏标签「引擎与模型」「翻译服务」
- [ ] 5.2 清理 `resources.json` 中 `tab.overview` / `overview.*`（若不再引用）；`node scripts/check-i18n.mjs` 通过

## 6. 校验

- [ ] 6.1 `npx tsc --noEmit`（renderer 用 `renderer/tsconfig.json`）全绿
- [ ] 6.2 冒烟：两新菜单可达；`/engines` 含引擎+模型(+GPU via 前置变更)；`/translation` 含翻译服务增删改/测试
- [ ] 6.3 冒烟：六类旧地址 + 顶栏徽章 + 下载 pill 全部落到正确新页
- [ ] 6.4 冒烟：全新环境首启自动唤起 onboarding；删 overview 后无控制台报错/悬挂引用
