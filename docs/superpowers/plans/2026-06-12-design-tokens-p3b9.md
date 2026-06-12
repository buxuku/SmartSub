# 批次 9 实施计划：设计 token 与状态色语义

对应设计：`docs/superpowers/specs/2026-06-12-design-tokens-p3b9-design.md`

## Task 1：Token 地基

**文件**：`renderer/styles/globals.css`、`renderer/tailwind.config.js`

1. `:root` 中 `--primary: 243 75% 59%`、`--ring: 243 75% 59%`；`.dark` 中 `--primary: 234 89% 74%`、`--primary-foreground: 222.2 47.4% 11.2%`、`--ring: 234 89% 74%`。
2. `:root` 与 `.dark` 各新增：`--success/--success-foreground`、`--warning/--warning-foreground`、`--info/--info-foreground`（值见设计文档表）。
3. `tailwind.config.js` colors 增加 success/warning/info（DEFAULT+foreground 映射 hsl var）。

**验证**：tsc 无影响；`yarn dev` 主按钮变 indigo。

## Task 2：状态色语义接入

**文件**：`TaskRowList.tsx`、`CompletionBanner.tsx`、`MergeButton.tsx`、`FileSelector.tsx`、`GpuAccelerationCard.tsx`、`BatchAiOptimizeDialog.tsx`、`SubtitleList.tsx`、`CustomParameterEditor.tsx` + grep 扫描补漏

按设计文档替换表执行；装饰性用色（启动台 chip、引导插画）不动。每文件改完跑 lints。

**验证**：grep 状态语义处无残留 `text-green-600`/`text-red-500`（容许装饰性与对比区特例）；视觉冒烟。

## Task 3：危险操作降权

**文件**：`ModelsTab.tsx`、`settings.tsx`、`LogDialog.tsx`、`BatchAiOptimizeDialog.tsx`

审查每个 `variant="destructive"`：

- 列表项/卡片/页面常驻入口 → `variant="ghost"` + `text-muted-foreground hover:text-destructive`
- AlertDialog/Dialog 内终极确认 → 保留 destructive

**验证**：资源中心模型卡删除按钮静默化；确认弹窗仍红。

## Task 4：暗色破损 + 紧凑 hack 移除 + logo

1. grep `bg-white|text-black|bg-gray-|bg-blue-50|bg-yellow-50`（renderer/components + pages），状态/容器语义处补 `dark:` 或换 token。
2. `globals.css` 删除紧凑模式中覆盖原子类的规则，保留 `--spacing-*` 变量紧凑值。
3. `Layout.tsx` logo 容器 `bg-card` → `bg-primary text-primary-foreground`（去 border）。

**验证**：暗色模式冒烟主要页面；常规窗口无布局回归。

## Task 5：门禁 + 验收交接

1. `cd renderer && npx tsc --noEmit`：非测试 0 错误。
2. 根 `npx tsc --noEmit` 过滤 `^main/`：= 95 基线。
3. 提交（每 Task 一个 commit）；调用 interactive_feedback 交接，附验证建议。
