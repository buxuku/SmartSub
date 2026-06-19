## Context

资源中心现为单入口 + 四 Tab（overview / engines / providers / acceleration）。经 `fold-gpu-into-builtin`（加速并入 builtin）后只剩三 Tab，其中 overview 是仪表盘。本变更删除 overview 并把 engines / providers 提升为两个顶级菜单。

侧边栏现状（`Layout.tsx#NAV_ITEMS`）：任务 / 字幕校对 / 字幕合成 / 资源中心 / 设置（5 项）。

## Goals / Non-Goals

**Goals**

- 引擎与模型、翻译服务各为一个直达的顶级菜单，少一层 Tab 嵌套。
- 删除 overview，避免维护一个综合价值已弱化的仪表盘。
- 旧路由 / 深链接 / 书签平滑重定向，零功能回退。

**Non-Goals**

- 不改各页内部功能（引擎/模型/翻译的增删改下载）。
- 不重做新手引导（沿用 `OnboardingDialog`）。
- 不处理 GPU 折叠本身（前置 `fold-gpu-into-builtin`）。

## Decisions

### D1 — 两个顶级路由 + 薄重定向矩阵

- 新增 `/{locale}/engines` 与 `/{locale}/translation` 两个顶级页面，分别渲染既有 `EngineModelTab` / `ProvidersTab`（整体平移为整页，去掉外层 Tabs 容器）。
- 重定向矩阵（薄 `router.replace`）：

  | 旧地址                                   | 新目标                     |
  | ---------------------------------------- | -------------------------- |
  | `/resources`（无 tab / `?tab=overview`） | `/engines`                 |
  | `/resources?tab=engines`、`?tab=models`  | `/engines`                 |
  | `/resources?tab=providers`               | `/translation`             |
  | `/resources?tab=acceleration`            | `/engines`（选中 builtin） |
  | `/modelsControl`                         | `/engines`                 |
  | `/translateControl`                      | `/translation`             |

- **理由**：保住所有外部书签 / 历史深链接；新结构干净（无嵌套 Tab）。

### D2 — 删除 overview

- 删除 `OverviewTab.tsx` 与 `resources.tsx` 的 Tabs 容器。
- 首启就绪引导：沿用 `OnboardingDialog`（`Layout` 已在「无任何引擎模型」时自动唤起，逻辑 `hasAnyModelAnyEngine` 保留）。
- overview 中「下载推荐模型」「启用翻译服务」「GPU 状态」三入口的价值：分别由 `/engines` 页（推荐模型 + GPU 已在 builtin）与 `/translation` 页承接；onboarding 仍覆盖首启动线。

### D3 — 侧边栏与全局入口

- `NAV_ITEMS`：`资源中心`（1 项）→ `引擎与模型` + `翻译服务`（2 项），共 6 项；图标沿用 `Cpu`（引擎与模型）/ `Languages`（翻译服务）。
- 下载 pill：`resources?tab=engines` → `/engines`。
- 顶栏加速徽章：已由 `fold-gpu-into-builtin` 指向 builtin 引擎面板（即 `/engines` 选中 builtin），此处仅确认目标随新路由生效。

### D4 — 顺序与兼容

- 依赖 `fold-gpu-into-builtin` 先合并加速（否则删 acceleration Tab 会丢 GPU 管理）。
- 若 `merge-sherpa-engines-ui` 尚未落地，`/engines` 页仍可工作（只是引擎面尚未合并）；两者互不阻塞。

## Risks / Trade-offs

- **侧边栏回到 6 项**：与早前「降噪到 5 项」的方向相反。权衡：合并 + 折叠后两域已自洽，直达优于嵌套；6 项仍在可接受范围。
- **丢失单一「全景」就绪视图**：以 onboarding + 各页空态 CTA 兜底。若后续确需总览，可在任务页加一条轻量就绪条（非本期）。
- **重定向遗漏**：集中维护重定向矩阵 + 冒烟覆盖所有旧入口。

## Migration Plan

1. 新增 `/engines`、`/translation` 页（平移 `EngineModelTab` / `ProvidersTab`）。
2. `resources.tsx` / `modelsControl.tsx` / `translateControl.tsx` 改重定向。
3. `Layout` 更新 `NAV_ITEMS` + 下载 pill 跳转；确认顶栏徽章目标。
4. 删除 `OverviewTab.tsx` 与 Tabs 容器；清理 `resources.tab.overview` / `overview.*` 未引用文案。
5. 冒烟：六类旧地址重定向正确；两新菜单可达；首启 onboarding 正常；删 overview 无悬挂引用。

## Open Questions

- 新路由命名：`/engines` + `/translation`（本设计采用）vs 复用 `/modelsControl` + `/translateControl` 文件名作为新主页。倾向新语义化路由 + 旧名重定向。
- 是否在任务页补一条轻量「就绪条」以部分替代 overview（暂列为后续，非本期）。
