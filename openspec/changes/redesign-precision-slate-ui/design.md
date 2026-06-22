## Context

应用现状：`renderer` 用 shadcn 默认主题（`--primary` indigo、`--radius` 0.5rem、`defaultTheme="system"`、仅 `system-ui` 正文字体）。设计目标来自 Stitch 项目 `Prism Subtitle Studio` 的「Precision Slate」设计系统（见 `docs/UI/Design Document.md` 与 `docs/UI/stitch/*.png`）：深色三层中性面、单一精密强调色、紧凑信息密度、等宽技术字段、克制的描边/层级。

关键约束与杠杆：

- **零字体打包**：不得引入 Inter/JetBrains Mono 等三方字体文件。
- **token 驱动**：渲染层约 95% 使用语义 token（`bg-background`/`text-muted-foreground`/`border`…），全仓硬编码调色板类仅 17 处。改 `globals.css` + `tailwind.config.js` 即可级联全局。
- **Electron + Next(nextron)**：运行时为 Chromium，`system-ui` 与系统等宽栈在目标平台均可用；`backdrop-filter` 可用但需控制使用范围以免影响低端机性能。
- **并行变更**：另有 8 个进行中的 OpenSpec change 触及引擎/模型/翻译页与共享 UI，存在合并冲突面。

## Goals / Non-Goals

**Goals:**

- 默认深色、保留浅色切换，两套均「精致」而非默认观感。
- 单一 Editing-Blue 强调色贯穿 CTA/选中/聚焦/链接，语义清晰。
- 通过集中式 token 让全局组件自动继承新外观，逐页改动最小化。
- 技术字段等宽化，建立 `label-caps` 分区标题，营造「剪辑控制台」质感。
- 以「蓝色声波」统一品牌信号，替换应用内与打包图标。

**Non-Goals:**

- 不改业务逻辑、IPC、数据结构、页面信息架构。
- 不做多套可切换皮肤（仅默认 + 浅色两态）。
- 不引入三方字体；不做「Pro」更名等品牌文案改动。
- 不重写各页面布局（仅在 token 级联之外做必要的「点」级打磨）。

## Decisions

### D1. 单一 Editing-Blue 主色（token 映射）

`--primary` 收敛为 Editing Blue（`#00A3FF`），承担 CTA + 选中 + 聚焦 + 链接；`--ring` 同源。indigo 不再是主色（保留为启动台卡片装饰色，见 D4）。

- **取舍**：放弃设计稿「双强调（蓝=选中 / 靛=CTA）」的双源方案。理由：shadcn 单 `--primary` 模型最简、跨组件零额外约定；用户已明确选「统一单一 Editing-Blue」。代价是 CTA 与选中态同色，靠形状/层级（实心填充 vs 描边/左条）区分而非靠色相。
- **填充对比度**：`#00A3FF` 上白字对比不足（~2.7:1）。故 `--primary-foreground` 取近黑深蓝（≈`#003354`，对齐 Stitch `on-primary`），保证实心按钮 AA。链接/激活态是「蓝字落深底」（`#00A3FF` on `#131313` ≈ 6.8:1，达标）。
- **浅色主色加深**：浅色下若主色仍用 `#00A3FF` + 白字会失败，故浅色 `--primary` 加深到 `#0077CC` 区间 + 白字（≥4.5:1）。

提议的**深色** token（HSL，落地时微调）：

| token                              | hex 近似              | HSL                   |
| ---------------------------------- | --------------------- | --------------------- |
| `--background`                     | `#131313`             | `0 0% 7.5%`           |
| `--card`                           | `#1b1b1c`             | `240 2% 11%`          |
| `--popover`                        | `#202022`             | `240 3% 13%`          |
| `--secondary`/`--muted`/`--accent` | `#2a2a2a`             | `0 0% 16.5%`          |
| `--border`/`--input`               | `#333333`             | `0 0% 20%`            |
| `--foreground`                     | `#e5e2e1`             | `20 6% 89%`           |
| `--muted-foreground`               | `#bec7d4`             | `214 17% 79%`         |
| `--primary`                        | `#00A3FF`             | `201 100% 50%`        |
| `--primary-foreground`             | `#003354`             | `205 100% 16%`        |
| `--ring`                           | `#00A3FF`             | `201 100% 50%`        |
| `--selection`（新增，可选）        | `rgba(0,163,255,.10)` | 选中底纹/侧栏激活填充 |

提议的**浅色**（Precision Slate Light，推导）：近白偏冷底（`0 0% 99%`）、卡片纯白、`--border` `220 13% 91%`、`--foreground` `222 18% 12%`、`--primary` `204 100% 40%`(#0077CC) + 白字、`--ring` 同主色。状态色（success/warning/info/destructive）沿用现有语义、按明暗各调一档。

### D2. 字体系统（零打包）

- 正文 `--font-sans`：`system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`（贴近 Inter 的中性观感，CJK 回退完善）。
- 等宽 `--font-mono`：`ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`（若用户机装有 JetBrains Mono 则自然命中，否则系统等宽，零成本）。
- **等宽应用范围（关键体验点）**：时间码、文件/模型路径、文件尺寸（MB/GB）、API Key/Base URL、版本号。通过对相应组件加 `font-mono`（或 `tabular-nums`）实现，使数值/路径纵向对齐、滚动不跳动。
- 新增 `label-caps` 工具样式（11px / 700 / `tracking-wide` / uppercase）用于面板与分区标题（如 `ENGINE LIST` / `FREE TIER`）。
- **取舍**：不本地内嵌 woff2（即便能像素级还原 Inter）——用户明确不增打包体积；等宽带来的「技术对齐感」才是性价比最高的一步。

### D3. 形状与密度

- `--radius` 由 0.5rem 降到 **0.375rem**：shadcn 派生 `lg=radius / md=radius-2px / sm=radius-4px`，使容器≈6px、控件≈2–4px，贴近设计稿「控件 4px / 容器 8px」的克制硬朗感（落地时可将 Card 显式用 `rounded-lg`≈8px）。
- 卡片去除 `shadow-sm`，改为 1px 描边 + 必要处极轻投影；分区用 1px `--border` 分隔。
- 输入/分段控件「下沉感」：新增内阴影工具类（`inset 0 1px 2px rgba(0,0,0,.4)`，仅深色）。
- 浮层（popover/dropdown/context-menu）可选 `backdrop-blur` + 半透明，营造高级感（性能兜底见风险）。
- 侧边栏激活态：左侧 3px 主色竖条 + `bg-primary/10` 填充（替换当前 `bg-muted`）。

### D4. 启动台多彩卡片保留

`home.tsx` 的 5 张功能卡（indigo/sky/emerald/amber/rose 渐变 chip + 角标）**保留差异化彩色**，仅与新中性底/圆角/描边对齐。理由：启动台是「功能选择」场景，色彩差异化有助快速区分；这是全局单色强调语言里**唯一刻意的例外**。

### D5. 品牌 / Logo

以「蓝色声波」符号为主品牌信号，整体识别偏蓝（与新主色一致）。替换：

- 应用内 `renderer/public/images/brand/logo-mark.png` 与 `app/images/brand/logo-mark.png`；
- 打包源图 `resources/icon.png`（1024²）并据此重生成 `icon.icns` / `icon.ico`；
- 更新 `docs/brand/logo-design-notes.md` 的设计概念（由 indigo ∞ 环改为蓝色声波）。
- **取舍**：新符号与旧 indigo ∞ 环是不同概念；与「单一蓝色主色」一致，故顺势把品牌整体调蓝，而非维持 indigo 品牌色与蓝色 UI 主色的割裂。

### D6. 范围与排期（落地分层）

1. **第一层（本变更核心）**：主题 token（`globals.css`）+ tailwind 配置 + `_app.tsx` 默认深色 + 共享基元（button/card/input/badge）+ 外壳（Layout/侧栏激活态）。一次成型，全局级联。
2. **第二层**：等宽/`label-caps` 在目标组件落点（时间码/路径/尺寸/Key/版本/分区标题）。
3. **第三层**：品牌资产替换（logo + 打包图标 + 文档）。
4. **第四层**：逐页/「点」级打磨（启动台卡片对齐、ProvidersTab/VideoPlayer 硬编码点）。

- **与既有 change 的关系**：不复用空的 `add-appearance-skins`（语义偏「多皮肤」，与本次单一外观不符），新建本 change。建议在引擎/模型/翻译类 change 合并后再落第一层，以减少共享基元的冲突。

## Risks / Trade-offs

- [CTA 与选中同色，信息层级靠形状区分] → 实心填充用于唯一主操作、描边/左条用于选中/次级；按钮密集处避免多个实心主色。
- [`#00A3FF` 上文字对比] → 实心填充用深蓝近黑前景（D1）；蓝色仅作前景时只落于深底/浅底达标场景。
- [浅色为推导、缺设计稿背书] → 以同语义校准 + 截图自查对比度；浅色作为「次要默认」（默认深色），风险可控。
- [`backdrop-filter` 在低端/老机器掉帧] → 仅用于少量浮层；提供降级（无 blur 时退为不透明面）。必要时本次先不启用 blur，仅保留为可选。
- [触碰共享基元与并行 change 冲突] → 排期置后/分支隔离；基元改动尽量「加类不改结构」。
- [系统字体≠Inter，观感有差] → 接受（用户约束优先）；靠等宽 + 字号/字距/层级补偿「精致感」。
- [深色默认改变老用户习惯] → 保留浅色切换且记忆选择（`next-themes` 已持久化）。

## Migration Plan

- 纯前端外观变更，无数据迁移。`next-themes` 已持久化用户选择：仅改 `defaultTheme`，已选浅色的用户不受影响；未显式选择者首启呈现深色。
- 回滚：还原 `globals.css` / `tailwind.config.js` / `_app.tsx` 三文件即可整体回退（基元/外壳改动为增量类，单独可逆）。
- 图标回滚：保留旧 `logo-mark.png` / `resources/icon.*` 于 git 历史，可还原。

## Open Questions

- `--selection` 是否真的需要独立 token，还是统一用 `bg-primary/10` 原子类即可？（倾向后者，少一个 token）。
- 浮层 `backdrop-blur` 本次启用还是延后到打磨层？（倾向延后，先稳对比度与层级）。
- 浅色主色具体取值（`#0077CC` vs `#0A84FF`）以实测 AA 为准。
