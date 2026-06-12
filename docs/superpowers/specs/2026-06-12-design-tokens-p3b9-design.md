# 批次 9 设计：设计 token 与状态色语义（Phase 3 第一刀）

日期：2026-06-12
范围：UX_ANALYSIS_REPORT.md P1#16（状态无色彩语义）、P1#33（无品牌主色）、P1#17（裸红删除）、P2 紧凑模式 hack 移除、暗色破损补齐。

## 背景与现状

- `renderer/styles/globals.css` 为 shadcn 默认 slate 主题（HSL token）：`--primary: 222.2 47.4% 11.2%`（近黑），无品牌色、无状态色 token。
- 文件底部存在「紧凑模式 hack」：`@media (max-height: 800px)` 内覆盖 `.text-sm`/`.text-xs`/`.gap-4/6/8`/`.space-y-6` 等 Tailwind 原子类语义。
- 状态色硬编码散落 8+ 组件 30+ 处（`green-600`/`red-500`/`amber-600`/`blue-*`）。
- 4 个文件存在 `variant="destructive"` 大红按钮；列表项内删除属「操作权重倒挂」。
- 侧边栏 logo 为 lucide `FileVideo2` 灰色占位（`Layout.tsx` L361）。
- 启动台「生成+翻译」核心卡已使用 indigo 渐变（`home.tsx` L62）——品牌色取 indigo 的出处。

## 决策

### 品牌主色：indigo

用户已确认。依据：① 报告建议「从启动台色系中提」，核心功能卡已用 indigo；② 与 slate 冷灰基底（222°）同域，迁移成本最小；③ 与四态状态色（绿/红/琥珀/蓝 info）在色环上均拉开距离，「运行中=品牌色」不撞语义。

Token 值（HSL，沿用现有格式，不迁移 oklch 以控制风险）：

| token                  | light                               | dark                                |
| ---------------------- | ----------------------------------- | ----------------------------------- |
| `--primary`            | `243 75% 59%`（indigo-600 #4f46e5） | `234 89% 74%`（indigo-400 #818cf8） |
| `--primary-foreground` | `210 40% 98%`（不变）               | `222.2 47.4% 11.2%`                 |
| `--ring`               | 跟随 primary：`243 75% 59%`         | `234 89% 74%`                       |

### 四态状态色 token

新增三组语义色（destructive 已有），light 取 600 系、dark 取 400/500 系，foreground 均为近白/近黑：

| token       | light                      | dark                       | 用途             |
| ----------- | -------------------------- | -------------------------- | ---------------- |
| `--success` | `142 76% 36%`（green-600） | `142 71% 45%`（green-500） | 完成态、成功提示 |
| `--warning` | `38 92% 50%`（amber-500）  | `38 92% 50%`               | 取消中、警告     |
| `--info`    | `217 91% 60%`(blue-500)    | `217 91% 60%`              | 信息提示         |

`tailwind.config.js` 的 `colors` 扩展 `success/warning/info`（DEFAULT + foreground），用法 `text-success`、`bg-success/10`、`border-warning/30`。

「运行中」不设独立 token——直接用品牌色 `primary`（报告 5.3：运行态=品牌色+动效）。

### 状态色接入（替换规则）

机械替换，不改布局/结构：

| 旧                                                  | 新                      |
| --------------------------------------------------- | ----------------------- |
| `text-green-600 dark:text-green-400`（状态语义处）  | `text-success`          |
| `text-red-500`/`text-red-600`（错误语义处）         | `text-destructive`      |
| `border-red-500/30`                                 | `border-destructive/30` |
| `text-amber-600 dark:text-amber-500`（取消中/警告） | `text-warning`          |
| `bg-green-50 dark:bg-green-950/30`（成功浅底）      | `bg-success/10`         |
| `border-green-200 dark:border-green-800`            | `border-success/30`     |

例外（不替换）：装饰性用色（启动台卡片 chip 渐变、引导页插画色）保持原样——那是品类标识不是状态语义。

涉及文件：`TaskRowList.tsx`、`CompletionBanner.tsx`、`MergeButton.tsx`、`FileSelector.tsx`、`GpuAccelerationCard.tsx`、`BatchAiOptimizeDialog.tsx`、`SubtitleList.tsx`、`CustomParameterEditor.tsx` 及扫描出的其余状态语义处。

### 危险操作降权

规则：**列表项/卡片内的删除入口降权为 ghost + hover 显红；确认对话框内的终极确认按钮保留 destructive**。

- `ModelsTab.tsx`：模型卡删除按钮 `variant="destructive"` → `variant="ghost"` + `text-muted-foreground hover:text-destructive`。
- `settings.tsx`、`LogDialog.tsx`、`BatchAiOptimizeDialog.tsx` 中的 destructive 按钮逐一审查：属「页面常驻入口」的降权，属「对话框终极确认」的保留。

### 紧凑模式 hack 移除

移除 `@media (max-height: 800px)` 中覆盖 Tailwind 原子类的部分（`.text-sm`/`.text-xs`/`.gap-*`/`.space-y-6`/`button,input` min-height/header 高度），保留 CSS 变量（`--spacing-form-gap` 等）的紧凑值——变量是正当机制，原子类覆盖是 hack。

风险：小屏（≤800px 高）上设置页等表单密度回弹。接受：B3 后设置页已重构为紧凑布局，依赖该 hack 的页面已减少。

### 暗色破损补齐

扫描无 `dark:` 配对的硬编码浅色（`bg-white`、`bg-gray-*`、`text-black`、`bg-blue-50` 等状态语义处），逐一补 `dark:` 变体或换语义 token。装饰性除外。

### Logo 品牌底（顺手项）

`Layout.tsx` L361 logo 容器：`border bg-card` → 品牌色底 + 白图标（`bg-primary text-primary-foreground`），一处改动。

## 任务划分

1. **Task1 Token 地基**：globals.css（品牌色/ring/状态色 token 双模式）+ tailwind.config.js 扩展。
2. **Task2 状态色语义接入**：按替换规则全局替换。
3. **Task3 危险操作降权**：4 文件审查改造。
4. **Task4 暗色破损 + 紧凑 hack + logo**。
5. **Task5 门禁 + 验收交接**：renderer tsc 0 新增、main 95 基线、视觉冒烟（亮/暗 × 主要页面）。

## 验收标准

1. 主按钮/激活态/focus ring 呈 indigo 品牌色，亮暗双模式正常。
2. 任务行阶段链、完成横幅、合成状态的成功/失败/警告色全部来自语义 token。
3. 资源中心模型删除不再是大红按钮；删除确认对话框确认按钮仍为红。
4. 紧凑模式 hack 移除后，常规窗口尺寸下视觉无回归。
5. tsc 门禁：renderer 非测试 0 错误、main = 95 基线。
