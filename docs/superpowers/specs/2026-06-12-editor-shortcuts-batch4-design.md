# 编辑器专业化 · 批次 4「快捷键体系」设计

> 来源：UX_ANALYSIS_REPORT §4.3（键盘与可访问性）、§8 Phase 2、§11 v2.18.0 beta.1。
> 用户决策：覆盖范围选 A（编辑器 7 条 + 全局 2 条 + 任务页 Cmd+Enter，不做 Delete 删行）；实现路线选自研轻量 hook（零依赖）。

## 目标

全应用从「零快捷键」升级到报告 4.3 清单的 90% 覆盖，并提供快捷键速查面板与编辑器底部提示条。

## 架构

### 新组件

1. **`renderer/hooks/useHotkeys.ts`** — 通用快捷键 hook

   - API：`useHotkeys(bindings: HotkeyBinding[])`；binding = `{ combo, handler, allowInInput?, preventDefault? }`
   - combo 语法：`'mod+s'`、`'shift+mod+z'`、`'space'`、`'arrowup'`、`'?'`、`'escape'`
   - `mod` = macOS metaKey / 其他平台 ctrlKey（`isMacPlatform()` 导出供 UI 显示 ⌘/Ctrl）
   - 输入态守卫：target 为 input/textarea/select/contentEditable 时默认跳过，`allowInInput: true` 豁免（用于带修饰键的组合）
   - `?` 键按 e.key 匹配、忽略 shift 校验（shift 是输入它的必要条件）
   - 绑定表经 ref 读取，handler 闭包最新 state；单 window keydown 监听，卸载清理

2. **`renderer/components/ShortcutsHelpDialog.tsx`** — 速查面板
   - 受控 Dialog，三分组（全局 / 任务页 / 校对编辑器），kbd 样式按平台渲染 ⌘ 或 Ctrl
   - i18n：common 命名空间 `shortcuts.*`

### 接线点

3. **Layout.tsx（全局）**

   - `mod+,` → 跳设置页（allowInInput）
   - `?` → 打开速查面板（非输入态）
   - 帮助下拉菜单新增「快捷键速查」项；渲染 ShortcutsHelpDialog

4. **ProofreadEditor.tsx（编辑器 7 条）**

   - `mod+s` 保存、`mod+z` 撤销、`shift+mod+z` 重做（均 allowInInput，接管 textarea 原生撤销，保证撤销口径唯一走快照历史）
   - `space` 播放/暂停（非输入态，hasVideo 守卫）
   - `arrowup/arrowdown` 上/下一条（非输入态，复用 goToPrevious/NextSubtitle，无视频时仅切行）
   - `mod+f` 递增 searchOpenToken 传给工具栏展开搜索替换并聚焦
   - `escape`（allowInInput）输入框失焦回到浏览态
   - 底部新增常驻提示条：Space 播放 · ↑↓ 切行 · Tab 原⇄译 · ⌘S 保存 · ? 全部快捷键

5. **SubtitleList.tsx（Tab 路由）**

   - 原文/译文 textarea 加 id（`subtitle-src-{i}` / `subtitle-tgt-{i}`）与 onKeyDown：
     原文框 Tab→同行译文框；译文框 Shift+Tab→同行原文框（preventDefault 阻断默认乱跳）

6. **SubtitleEditToolbar.tsx**

   - 新增可选 prop `searchOpenToken?: number`；token 变化时打开搜索 Popover 并聚焦搜索输入框

7. **TaskControls.tsx（任务页）**
   - `mod+enter`（allowInInput）→ showStart 且有文件时等价点击「开始任务」
   - tasks/[type].tsx：`mod+o`（allowInInput）→ handleImport 打开文件选择

### 范围修正（相对最初口头方案）

- Cmd+O 仅任务页生效：home 页没有直接导入入口（卡片是导航），不强造。
- 速查面板入口：帮助菜单 + ? 键全局可用（不只编辑器内）。

## 错误处理

- 快捷键 handler 全部复用既有按钮的 onClick 逻辑与守卫（disabled 状态对应提前 return），不新增执行路径。
- 修饰键互斥：要求 mod 的组合不响应 mod+ctrl 同按；非 ? 键校验 shift 精确匹配。

## 测试与门禁

- 门禁同前三批：主进程 tsc 基线对比 0 新增；渲染层非测试错误 0；五路由冒烟 200。
- 手动验收清单见交接消息（保存/撤销/重做/播放/切行/Tab/搜索/速查/设置/导入/开始任务）。

## i18n

common.json（zh/en）新增 `shortcuts.*` 组键；菜单项 `help.shortcuts`。
