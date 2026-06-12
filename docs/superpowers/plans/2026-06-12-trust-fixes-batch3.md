# 信任修复 · 批次 3「平台与交互兼容」实施计划

> 设计：`docs/superpowers/specs/2026-06-12-trust-fixes-batch3-design.md`
> 门禁同批次 1/2：主进程 tsc 对比 `/tmp/tsc-baseline-mainonly.txt` 无新增；渲染层非测试错误 0。

## Task 1: P0#9 ProvidersTab 默认选中（最小）

- `ProvidersTab.tsx` loadProviders：`storedProviders[0].type` → `storedProviders[0].id`
- Commit: `fix(resources): select first provider by id so custom-first lists render a panel`

## Task 2: P0#8 webUtils 迁移

- `main/preload.ts`：import webUtils + handler.getPathForFile
- `home.tsx` / `tasks/[type].tsx` 拖拽循环：`window?.ipc?.getPathForFile?.(f) ?? (f as any).path`，移除 @ts-ignore
- Commit: `fix(drag-drop): migrate File.path to webUtils.getPathForFile for Electron 32+`

## Task 3: P0#10 macOS 关窗保活 + Dock 进度

- `background.ts`：isQuitting/before-quit、close→hide(darwin)、activate→show、window-all-closed 仅非 darwin 退出
- `taskProcessor.ts`：runtime.total/completed、updateTaskbarProgress 聚合 setProgressBar；handleTask/finally/cancel/finalize 接点
- Commit: `feat(platform): keep app alive on macOS window close and show dock task progress`

## Task 4: P1#23 保存降噪

- `settings.tsx`：handleVADSettingChange → 本地即时 + pendingVadRef 500ms 批量静默保存，失败才 toast
- `ProvidersTab.tsx`：handleInputChange → setProviders 即时 + setTranslationProviders 500ms debounce + 卸载 flush
- Commit: `fix(settings): debounce auto-save and silence success toasts for VAD and provider inputs`

## Task 5: P1#22 useConfirmOrUndo

- 新 `renderer/hooks/useConfirmOrUndo.ts`（toast + 撤销 action）
- 接入：tasks/[type].tsx 清空列表；ProvidersTab 删服务商；proofread.tsx 删行/重置
- i18n：common.undo、tasks.listCleared、translateControl.providerRemoved、home.fileRemoved/importReset（zh/en）
- Commit: `feat(ux): undoable destructive actions for clear list, provider delete and proofread rows`

## Task 6: 门禁 + 冒烟 + 汇报

- 双门禁；dev 实例首页/任务页/资源中心/校对页 200；13:05 interactive_feedback 汇总验收清单

## 执行记录（2026-06-12）

- Task 1-6 全部完成并按计划逐条提交（54eb5ca → 33f1db7）。
- 追加收尾提交 3018661：P1#14 编辑态隐藏顶层「新建任务/历史任务」切换器；ProvidersTab 添加服务商对话框描述 i18n 化（原硬编码英文）。
- 门禁结果：主进程对基线 0 新增；渲染层非测试错误 0。
- 冒烟：home/tasks/resources/settings/proofread 路由均 200。
- 偏差说明：proofread 删行撤销采用「先删 + toast 撤销」而非确认弹窗，与 P1#22 双轨方案一致；恢复时按原 index 插回。
