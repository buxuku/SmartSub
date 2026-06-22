## Why

当前 UI 直接沿用 shadcn 默认主题（indigo 主色、8px 圆角、`defaultTheme="system"`、仅系统字体），视觉上「框架感」明显，缺少专业字幕创作台应有的精密、克制、可长时间编辑的质感。我们已在 Stitch（项目 `Prism Subtitle Studio`）产出一套面向视频/字幕专业工作流的设计系统「Precision Slate」（深色三层中性面 + Editing Blue 强调色 + 紧凑信息密度 + 等宽技术字段），并已有一枚新的「蓝色声波」品牌符号。本次将该设计系统落地为应用的默认外观，让软件「像一台高端剪辑控制台」。

借力点：渲染层约 95% 已是 token 驱动（全仓硬编码调色板类仅 17 处，其中 15 处是启动台刻意的多彩卡片），因此「换肤」主要是**集中式主题改造**（CSS 变量 + tailwind 配置），而非逐屏重写。

## What Changes

- **默认深色 + 保留浅色**：`_app.tsx` 默认主题由 `system` 改为 `dark`，浅色切换保留；`ThemeToggle` 行为不变。
- **统一单一 Editing-Blue 主色**：`--primary` 由 indigo 改为 Editing Blue（`#00A3FF` 区间），承担主 CTA / 选中 / 聚焦 / 链接；indigo 退出主色（如需保留则降级为装饰/次级语义，不再是 `--primary`）。
- **Precision Slate 深色调色板**：背景/卡片/弹层改为三层中性面（`#131313` → `#1b1b1c`/`#202020` → `#2a2a2a`），1px 描边（`#333` 区间），聚焦态描边转主色。
- **推导精致浅色（Precision Slate Light）**：基于同一语义重新校准浅色 token（Stitch 仅定义了深色），保证浅色同样精致、而非沿用现状默认。
- **字体系统（零打包成本）**：不引入三方字体；正文用 `system-ui` sans 栈，**技术字段（时间码 / 文件路径 / 尺寸 / API Key / 版本号）改用系统等宽栈**，新增 `label-caps`（小号、加粗、字距）用于面板/分区标题。
- **形状与密度**：默认圆角收紧（控件 4px / 容器 8px），间距贴近 4px 基线、紧凑 12–16px，卡片去重投影、强化描边与层级。
- **品牌/Logo 替换**：以「蓝色声波」为主品牌信号（整体偏蓝），替换侧边栏 `logo-mark.png` 与打包图标 `resources/icon.{png,icns,ico}`，更新品牌设计说明。
- **启动台多彩卡片保留**：home 启动台 5 张功能卡保留差异化彩色（indigo/sky/emerald/amber/rose），仅与新中性底/圆角/描边语言对齐。
- **非目标（Non-goals）**：不改任何业务功能/IPC/数据结构；不做「Pro」更名等品牌文案变更；不引入多套可切换皮肤（本次只产出一套默认外观 + 浅色）。

## Capabilities

### New Capabilities

- `appearance-theming`: 应用外观与主题契约——默认色彩模式、深/浅色 token 语义、强调色单源、字体（正文/等宽/标题分区）、形状与密度基线、品牌标识资产，以及这些如何通过集中式 token 驱动全局组件。

### Modified Capabilities

<!-- 无：本次为纯视觉/外观层，不改变 engine-model-management 等既有能力的需求行为。 -->

## Impact

- **主题与配置**：`renderer/styles/globals.css`（`:root` / `.dark` 全量 token 重定义、新增 `--selection`/`--font-*` 等）、`renderer/tailwind.config.js`（`--radius`、`fontFamily.mono`/`sans`、`label-caps` 等扩展）、`renderer/pages/_app.tsx`（默认深色）。
- **基础组件**：`components/ui/{button,card,input,badge,...}.tsx` 的圆角/描边/聚焦态微调（影响面广但集中）。
- **外壳**：`components/Layout.tsx`（侧边栏激活态左条 + 主色填充、头部、品牌名）、`ThemeToggle.tsx`（沿用）。
- **少量硬编码点**：`pages/[locale]/home.tsx`（启动台卡片，仅对齐语言）、`components/resources/ProvidersTab.tsx`、`components/subtitle/VideoPlayer.tsx`。
- **品牌资产**：`renderer/public/images/brand/logo-mark.png`、`app/images/brand/logo-mark.png`、`resources/icon.{png,icns,ico}`、`docs/brand/logo-design-notes.md`。
- **依赖关系**：触及共享 UI 基元（button/card/input/badge），与进行中的引擎/模型/翻译类变更存在合并冲突面；建议先落「主题 token + 基元 + 外壳」一层，再逐页打磨。
- **参考资产**：`docs/UI/Design Document.md`、`docs/UI/stitch/{engines-models,translation,app-icon}.png`（Stitch 设计稿）。
