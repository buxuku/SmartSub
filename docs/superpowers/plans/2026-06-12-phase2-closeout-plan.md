# 批次 8 实施计划：Phase 2 收尾

设计：`docs/superpowers/specs/2026-06-12-phase2-closeout-design.md`
门禁：每任务后 lints + 批次末两端 tsc 基线（main 95 / renderer 非测试 0）；每任务一个提交。

## Task 1 — 任务页四守卫（P1#24/25/26/27）

文件：

- `renderer/pages/[locale]/tasks/[type].tsx`
  - 新增 `appendFiles` useCallback：filePath 去重（对既有 + 本批内），toast `t('skippedDuplicates', { count })`；传给 useIpcCommunication 与 handleDrop。
  - `queueBusy` 推导（taskStatus running/paused/cancelling），清空按钮 disabled 加 queueBusy。
- `renderer/hooks/useIpcCommunication.tsx`：签名 `(setFiles, appendFiles)`；file-selected 分支调 appendFiles ?? 原逻辑。
- `renderer/components/tasks/TaskRowList.tsx`：行内 X `disabled={queueBusy}` + 样式（disabled:opacity-30）。
- `renderer/lib/providerUtils.ts`（新）：`isProviderConfigured(provider)` 基于 PROVIDER_TYPES required 字段。
- `renderer/components/tasks/InlineConfigBar.tsx`：下拉加「不翻译」（'-1'）首项；未配置项 disabled + 「（未配置）」后缀。
- `renderer/components/tasks/CompletionBanner.tsx`：doneFiles>1 时去校对/去合成改 DropdownMenu（shadcn dropdown-menu 已有则复用，确认 components/ui/dropdown-menu.tsx 存在）。

验证：lints + 手动逻辑走查。提交 `feat(tasks): import dedupe, busy guards, no-translate option and multi-file banner`。

## Task 2 — 列表多选合并

文件：

- `renderer/components/subtitle/SubtitleList.tsx`
  - state：`selAnchor/selFocus: number | -1`；派生 `selRange: [lo, hi] | null`（≥2 才有效）。
  - SubtitleRow 加 `isSelected` prop；紧凑行 onClick 传 event，shiftKey 时走 onRowShiftClick。
  - failedOnly 时 Shift 点击退化普通点击。
  - 顶栏选区操作条：「合并 N 条」「取消选择」；Esc 清选区。
  - props 新增 `onMergeRange?: (start: number, endExclusive: number) => void`。
- `renderer/components/proofread/ProofreadEditor.tsx`：传 `onMergeRange={(s, e) => handleMergeSubtitles(s, e)}`。

验证：lints；选区高亮与合并语义走查（hook slice(start, endExclusive)）。提交 `feat(proofread): shift-click range selection with one-click merge`。

## Task 3 — 搜索替换强化

文件：

- `renderer/components/subtitle/SubtitleEditToolbar.tsx`
  - 工具函数 `countOccurrences` / `replaceAllCase`（caseSensitive 开关，循环 indexOf 实现不敏感替换）。
  - state：caseSensitive、matches（[{index, field}] 含该字段至少一次出现的条目）、pointer。
  - handleSearch 重写：构建 matches + 次数统计。
  - 「上一处/下一处」：pointer 循环 + `onLocateSubtitle(matches[p].index)`。
  - 「替换当前」：替换该条该字段全部出现 → onSubtitlesChange → 重算 matches（夹紧 pointer）。
  - 「全部替换」：用 replaceAllCase。
  - props 新增 `onLocateSubtitle?: (index: number) => void`。
- `renderer/components/proofread/ProofreadEditor.tsx`：传 `onLocateSubtitle={setCurrentSubtitleIndex}`（确认现有 setter 名）。
- Checkbox「区分大小写」用现有 ui/checkbox。

验证：lints + 替换语义走查（搜索词为空/替换词含搜索词等边界）。提交 `feat(proofread): stepwise search-replace with occurrence count and case toggle`。

## Task 4 — AI 优化纯转写模式

文件：

- `renderer/components/subtitle/SubtitleEditToolbar.tsx`
  - `optimizeMode = shouldShowTranslation ? 'translation' : 'transcription'`。
  - 单条/批量按钮移出 shouldShowTranslation 守卫。
  - transcription：标题/描述换文案；隐藏当前翻译块；默认提示词 `defaultTranscriptionPrompt`（修正错别字/标点/断句模板）；缓存 key `ai_optimize_transcription_prompt`；采纳写 sourceContent。
- `renderer/components/subtitle/BatchAiOptimizeDialog.tsx`
  - props 加 `mode: 'translation' | 'transcription'`。
  - 默认提示词按 mode；payload target 传空（transcription）；结果回调改 `Array<{ index, content }>`。
  - review 列：transcription 显示 sourceContent vs 修正文。
- `renderer/components/proofread/ProofreadEditor.tsx` 或工具栏内：`handleApplyBatchOptimizations` 按 mode 写对应字段。

验证：lints + 两模式下提示词与写回字段走查。提交 `feat(proofread): AI correction for transcription-only mode`。

## Task 5 — i18n + 门禁 + 交接

- zh/en `tasks.json`：skippedDuplicates、noTranslate、notConfigured、banner 下拉相关。
- zh/en `home.json`：mergeSelected、clearSelection、caseSensitive、prevMatch/nextMatch、replaceCurrent、transcription AI 文案组。
- JSON 校验 + 两端 tsc 门禁。
- 提交 `chore(i18n): batch 8 keys (zh/en)`；interactive_feedback 交接。

## 风险与回退

- SubtitleList 改动保持 SubtitleRow memo props 最小增量（isSelected boolean）。
- useIpcCommunication 签名变更只影响唯一调用方任务页。
- BatchAiOptimizeDialog 回调签名变更同步更新唯一调用方工具栏。
