# 字体兜底与字体选择器增强 设计

## 背景

字幕预览/导出在字幕含韩文（及其他脚本）而所选字体与写死的兜底列表都不含对应字形时，
`fallbackFontForText` 直接抛出 `No installed subtitle font contains glyphs: U+...`，
导致整个预览和导出失败。兜底列表缺少韩文/日文系统字体（Apple SD Gothic Neo、
Malgun Gothic、Yu Gothic、Meiryo 等）。另外字体选择器只按「可用 → 字母序」排序，
没有常用排序、分组和中文名/拼音搜索。

## 决策

- 范围：兜底修复 + 提示 + 选择器增强全做。
- 无字体可覆盖时：**降级继续**——缺字保留原字体（显示方块），预览/导出照常进行并给出警告，不阻断。

## A. 字体兜底（`main/helpers/fontResolver.ts`、`assFonts.ts`）

- **尽量不自动采用兜底字体**：自动兜底只使用内嵌字体和预置列表（补充韩/日/繁中/泰等
  系统字体及各平台路径），**不会**在已安装字体里随意挑一个，避免出现用户预期之外的效果。
- 先找能覆盖**全部**缺失字符的单一字体，找不到再按字符逐个从预置列表选字体。
- 仍然没有的字符：保留主字体，记录到 `missingGlyphs`，**不再抛错**。
- 零宽/格式控制字符不计入缺字。
- 逐码位结果缓存（仅无内嵌字体上下文时），扫描刷新时清空。
- `fontTextRuns` / `resolveAssFonts` 接受可选的 `FontFallbackReport` 收集器。

## B. 提示（IPC → 渲染层）

- `buildAssForSubtitle` 返回 `fontReport: { fallbacks: {from,to,sample}[]; missingGlyphs: string[] }`。
- `subtitleMerge:buildPreviewAss` 透传；`useJassubPreview` 暴露 `fontReport`；
  `VideoPreview` 的提示条显示「已自动用 X 渲染 …」以及「N 个字符无可用字体，将显示为方块，建议安装思源黑体 / Noto Sans CJK」。
- 导出（`composeRunner`）把同样的信息写入日志（warning）。
- **推荐字体**：新增 IPC `subtitleMerge:recommendFonts`（`recommendFontsForText`）。
  只要出现兜底或缺字，提示条就异步查询「无需任何兜底即可完整显示整份字幕」的已安装字体
  （常用字体优先，最多 5 个，默认 2.5s 预算，超时不写缓存），以按钮展示，点击后通过
  `onUpdateStyle` 切换字体。查询与预览/导出使用同一套 `resolveFace`，保证推荐结果确实无需兜底。
- 没有任何推荐字体时给出安装思源黑体（Noto Sans CJK）的建议。
- 新增中英文 i18n 文案。

## C. 字体选择器（`listSubtitleFonts` + `FontSelector.tsx`）

- 选项增加 `displayName`（本地化 family 名）、`group`（`common` | `other`）、`rank`。
- 分组：最近使用 → 常用 → 全部（未安装的字体沉底）。常用按平台权重表排序，最近使用存 localStorage。
- 搜索匹配英文名、本地化名、拼音全拼与首字母。
- 提高字体扫描文件上限（现有扫描已缓存、分批让出事件循环）。
- 保持实时样例渲染、虚拟滚动、键盘导航。

## D. 测试

- `scripts/compose/test-font-fallback.ts`：兜底选择、缺字降级、报告。
- 更新 `scripts/test-subtitle-appearance.ts`（原先断言抛错）。
- `FontSelector.test.tsx`：分组、排序、本地化/拼音搜索。
