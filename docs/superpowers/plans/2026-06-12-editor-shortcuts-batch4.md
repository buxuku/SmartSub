# 编辑器专业化 · 批次 4「快捷键体系」实施计划

> 设计：`docs/superpowers/specs/2026-06-12-editor-shortcuts-batch4-design.md`
> 门禁同批次 1-3：主进程 tsc 对比 `/tmp/tsc-baseline-mainonly.txt` 无新增；渲染层非测试错误 0。

## Task 1: useHotkeys hook

- 新建 `renderer/hooks/useHotkeys.ts`：HotkeyBinding 接口、isMacPlatform、parseCombo、comboMatches、输入态守卫
- Commit: `feat(hotkeys): add useHotkeys hook with platform-aware mod key and input guards`

## Task 2: ShortcutsHelpDialog + Layout 全局接线

- 新建 `renderer/components/ShortcutsHelpDialog.tsx`（三分组、平台化 kbd）
- Layout.tsx：mod+, 跳设置、? 开面板、帮助菜单加「快捷键速查」
- i18n：common zh/en `shortcuts.*` + `help.shortcuts`
- Commit: `feat(hotkeys): shortcuts help dialog with global open-settings and help-menu entry`

## Task 3: 编辑器接线

- ProofreadEditor：mod+s/z/shift+z、space、arrowup/down、mod+f（searchOpenToken）、escape 失焦；底部提示条
- SubtitleList：textarea id + Tab/Shift+Tab 同行原译切换
- SubtitleEditToolbar：searchOpenToken prop 打开搜索并聚焦
- Commit: `feat(editor): keyboard shortcuts for save, undo, playback, row nav, search and tab routing`

## Task 4: 任务页接线

- TaskControls：mod+enter 开始任务（showStart 守卫）
- tasks/[type].tsx：mod+o 导入
- Commit: `feat(tasks): cmd+enter to start task and cmd+o to import files`

## Task 5: 门禁 + 冒烟 + 交接

- 双门禁、五路由 200、interactive_feedback 验收清单

## 执行记录（2026-06-12）

- Task 1-4 完成并按计划逐条提交（共 4 个提交）。
- 门禁：主进程对基线 0 新增；渲染层非测试错误 0；六路由（含 subtitleMerge）冒烟 200。
- 实现备注：
  - `?` 速查与 Cmd+, 设置入口挂在 Layout，全应用可用；帮助菜单同步加「快捷键速查」项。
  - Cmd+O 仅任务页生效（home 无直接导入入口，不强造）。
  - Escape 失焦使用 preventDefault:false，不干扰 radix 弹层自身的 Esc 关闭。
  - Cmd+Z/Shift+Cmd+Z 在输入框内也接管为快照撤销，保证撤销口径唯一。
