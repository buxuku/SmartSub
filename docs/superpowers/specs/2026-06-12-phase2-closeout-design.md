# 批次 8 设计：Phase 2 收尾（任务页守卫 + 编辑器尾巴）

日期：2026-06-12
范围：UX_ANALYSIS_REPORT P1#24/#25/#26/#27 + Phase 2 行动项「合并改列表多选；搜索替换加逐条确认与高亮；AI 优化支持纯转写模式」
前置：批次 1-7 已完成（P0 全部 + P1#11/12/13/14/15/20/22/23/28/29/31）

## 背景与现状

| #         | 问题                                                                 | 现状代码                                                                                                   |
| --------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P1#25     | 重复导入不去重                                                       | `useIpcCommunication.tsx` L9（file-selected append）、`tasks/[type].tsx` handleDrop L278（dropped append） |
| P1#26     | 运行中可删行/清空                                                    | `TaskRowList.tsx` L171 行内 X 无 queueBusy 约束；`tasks/[type].tsx` L421 清空只查 files.length             |
| P1#27     | 翻译服务下拉不过滤未配置项；无「不翻译」                             | `InlineConfigBar.tsx` L148 全量列出；主进程 `fileProcessor.ts` L276 与 `stageUtils.ts` L25 已支持 `'-1'`   |
| P1#24     | CompletionBanner 只服务第一个文件                                    | `CompletionBanner.tsx` L74 firstDone = doneFiles[0]，去校对/去合成/打开文件夹全部用它                      |
| 多选合并  | 手填 1-based 序号                                                    | `SubtitleEditToolbar.tsx` L644-708 Dialog；hook `handleMergeSubtitles(start, end)` 已支持区间              |
| 搜索替换  | 无逐条确认/定位；matchCount 统计条数而非次数                         | `SubtitleEditToolbar.tsx` L161-225                                                                         |
| AI 纯转写 | 单条/批量 AI 优化都包在 shouldShowTranslation 内，只写 targetContent | `SubtitleEditToolbar.tsx` L774/L950、`BatchAiOptimizeDialog.tsx`                                           |

## Task 1 — 任务页四守卫

### #25 导入去重

- `tasks/[type].tsx` 新增 `appendFiles(incoming: IFiles[])`：按 `filePath` 对既有 files 与本批内部去重；全部重复时 toast「已跳过 N 个重复文件」，部分重复时 toast 同样提示。
- `useIpcCommunication(setFiles, appendFiles?)`：file-selected 分支改调 appendFiles（缺省回退原 append 行为，避免影响其他调用方——实际只有任务页一个调用方，直接改签名）。
- handleDrop 的 `getDroppedFiles.then` 改调 appendFiles。

### #26 运行中守卫

- `TaskRowList`：行内 X 按钮 `queueBusy` 时 `disabled`（沿用现有 queueBusy 定义：running/paused/cancelling）。
- 任务页「清空列表」按钮：`disabled={!files.length || queueBusy}`，页面用 taskStatus 推导同样的 queueBusy。

### #27 翻译服务下拉

- `InlineConfigBar` 服务商 Select：
  - 顶部恒加「不翻译」项（value `'-1'`），任何 provider 数量下都显示（providers 为空时也能选不翻译——但保留现有「去配置服务商」按钮分支：providers.length === 0 时仍显示按钮 + 一个「不翻译」快捷？简化：providers 为空时保持现状按钮；非空时下拉含不翻译项）。
  - 未配置判定：新增 `renderer/lib/providerUtils.ts` 导出 `isProviderConfigured(provider): boolean` —— 从 `types/provider.ts` 的 `PROVIDER_TYPES` 找到对应 type 模板，检查全部 `required: true` 字段在实例上非空；无模板（理论不存在）视为已配置。
  - 未配置项 `disabled` + 文案后缀「（未配置）」。
- 阶段链 `stageUtils.getFileStages` 已处理 `'-1'`，无需改动。

### #24 CompletionBanner 多文件

- `doneFiles.length === 1`：现状不变。
- `> 1`：「去校对」「去合成」改为 DropdownMenu，列出每个 done 文件（文件名截断 24ch），点击对该文件执行原有动作；「打开文件夹」保持开第一个文件目录。
- 去合成菜单项仅对 `accepts === 'media'` 且有字幕产物的文件显示。

## Task 2 — 合并改列表多选

- 选区状态在 `SubtitleList` 内部：`selectionRange: [number, number] | null`（实际存 anchor/focus 两个 index，渲染时归一化 min/max）。
- 交互：
  - 普通点击：现状（设当前行）+ 清除选区。
  - Shift+点击：anchor = currentSubtitleIndex（若无则该行），focus = 点击行；选区 = [min, max] 连续区间。在 onRowClick 增加 event 参数获取 shiftKey；紧凑行 div 的 onClick 已有 event。
  - Esc：清除选区（列表容器 keydown 或 useHotkeys 编辑器级）。
  - failedOnly 过滤态下禁用多选（选区语义为连续区间，过滤视图不连续）：Shift+点击退化为普通点击。
- 渲染：选中行加 `bg-accent`（紧凑行）；SubtitleRow 增加 `isSelected` prop（memo 保持稳定，仅选区边界变化的行重渲染）。
- 操作条：选区 ≥2 时列表顶栏（失败导航条同一行或其下）出现「合并 N 条」+「取消选择」按钮；合并调用 `onMergeRange(start, end)`（新 prop，上抛到 ProofreadEditor 调 `handleMergeSubtitles(start, end + 1)`——hook 的 end 为 exclusive，按现签名 slice(startIndex, endIndex)）。
- 合并后：清选区，currentSubtitleIndex 由 hook 内部逻辑落到合并行。
- 工具栏原「合并」Dialog 保留；打开时不自动填充选区（选区在 SubtitleList 内部，不增加跨组件耦合——有选区时用户直接用列表按钮，无需 Dialog）。设计调整：原呈现说"自动填充序号"，实现取消该联动以保持组件边界，Dialog 仅作无选区时的后备。

## Task 3 — 搜索替换强化

- 状态扩展：`caseSensitive: boolean`、`matches: Array<{ index: number; field: 'source' | 'target' }>`（按条+字段去重的匹配位置列表）、`matchPointer: number`。
- 统计修正：`matchCount` = 出现次数（`split(needle).length - 1` 按字段累加，大小写开关生效）。
- 逐条模式：
  - 「下一处 / 上一处」：matchPointer 循环移动，跳转到 `matches[pointer].index` 行——通过新 prop `onLocateSubtitle(index)` 上抛 ProofreadEditor 调 `setCurrentSubtitleIndex`（列表已有 currentSubtitleIndex 自动滚动逻辑，复用）。
  - 「替换当前」：只替换 `matches[pointer]` 对应条对应字段的所有出现（条内全部出现一次替换，不做字符级 pointer——粒度为"条"），替换后重算 matches，pointer 停留原位（夹紧）。
  - 「全部替换」：保留现状逻辑 + caseSensitive 支持。
- 大小写不敏感实现：统一用 `indexOf` on lowercase / 正则转义后 `RegExp(escaped, 'gi')`——选择字符串 split 方案避免正则转义陷阱：不敏感时 source.toLowerCase().split(needle.toLowerCase()) 无法直接重组原文，改用循环 indexOf 重组。实现时封装 `replaceAllInsensitive(text, needle, replacement, caseSensitive)` 工具函数。
- Popover 保持，底部按钮区改为：搜索 | 上一处 | 下一处 | 替换当前 | 全部替换。

## Task 4 — AI 优化纯转写模式

- 模式推导：`mode = shouldShowTranslation ? 'translation' : 'transcription'`（generateOnly 任务即纯转写）。
- `SubtitleEditToolbar`：
  - 单条 AI 优化与批量优化按钮移出 `shouldShowTranslation` 守卫，恒显示。
  - 单条对话框：transcription 模式下标题「AI 修正转写」，隐藏「当前翻译」区块，默认提示词换为转写修正模板（修正错别字/标点/断句，保持原意，仅返回修正后文本），采纳时写 `sourceContent`。
  - 提示词缓存 key 按模式分开（`ai_optimize_custom_prompt` / `ai_optimize_transcription_prompt`）。
- `BatchAiOptimizeDialog`：新增 `mode` prop：
  - transcription：默认提示词换转写修正模板；构建 payload 时 target 传空；结果写回经 `onApplyOptimizations` 的 payload 改为 `{ index, content }` + mode 由父组件落到对应字段——简化：回调签名改 `Array<{ index, content }>`，父组件按 mode 写 sourceContent 或 targetContent。
  - review 对比列：transcription 显示原文 vs 修正文。
- 主进程 `optimizeSubtitle` / 批量 IPC：无需改动（提示词模板驱动，返回文本）。
- 失败行守卫：transcription 模式不涉及 isTranslationFailed 逻辑，批量优化跳过空 sourceContent 条目。

## Task 5 — i18n + 门禁 + 验收交接

- zh/en：tasks（去重 toast、未配置后缀、不翻译、横幅下拉）、home（多选合并、搜索替换新按钮、AI 转写模式文案）。
- 门禁：renderer 非测试 TS 错误 0；main 95 基线；JSON 有效。
- 验收路径见交接消息。

## 错误处理

- 去重：filePath 一致即重复（不做内容 hash——同路径即同文件，符合用户心智）。
- 多选合并越界：onMergeRange 入口夹紧 [0, length)；选区包含当前展开行时正常合并（hook 已处理 currentIndex 落点）。
- 替换当前后 matches 重算可能为空：pointer 归零，UI 显示 0/0。
- AI 转写模式空原文：单条禁用按钮；批量构建时过滤。

## 测试与验证

- 门禁：tsc 两端基线比对。
- 冒烟（手动）：导入同一文件两次 → toast 跳过；运行中 X/清空置灰；下拉见「不翻译」与置灰未配置项；两文件完成 → 横幅下拉；Shift+点选 3 行 → 合并；搜索「the」→ 次数统计 → 下一处跳行 → 替换当前；纯转写任务 → AI 修正转写写回原文。
