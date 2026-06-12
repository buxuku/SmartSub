# 批次 12 实施计划：可达性兜底、任务行元信息与服务商分组导购

设计：`docs/superpowers/specs/2026-06-12-a11y-meta-providers-b12-design.md`（用户已确认）。
门禁基线：renderer TSC 0（非测试）；main TSC 95；`node scripts/check-i18n.mjs` 通过。每 task 一 commit。

## T1 可达性兜底

**文件**：`renderer/components/tasks/TaskRowList.tsx`、`renderer/pages/[locale]/home.tsx`、`renderer/components/resources/ProvidersTab.tsx`。
**改动**：

1. TaskRowList 删除 X：类名追加 `focus-visible:opacity-100`；「校对」「打开文件夹」Button 加 `aria-label`。
2. home 最近任务操作容器 span：追加 `focus-within:opacity-100`（容器）——按钮已有 aria-label。
3. ProvidersTab 自定义删除 span → button：`aria-label={t('removeProvider', { name })}`、`focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded`。注意外层是 button，需把行容器从 button 改 div（避免嵌套 button）+ role/onClick 保持（或内层用 span tabIndex？不可——改外层为 div + cursor-pointer + onClick + onKeyDown Enter）。
   **验证**：键盘 Tab 依次可见三处控件；renderer TSC 0。

## T2 任务行元信息 + ETA

**文件**：`main/helpers/fileUtils.ts`（fileSize）、`main/helpers/audioProcessor.ts`（duration 写入 file 后随既有 taskFileChange 发送）、`renderer/components/tasks/TaskRowList.tsx`（展示 + ETA ref）、`renderer/public/locales/{zh,en}/tasks.json`。
**改动**：

1. wrapFileObject：`fileSize: statSync 安全取 size`。
2. extractAudio：codecData 后 `file.duration = totalDurationSec`（extractAudioFromVideo 内在 done 事件前赋值——extractAudio 函数签名已接收 file）。
3. TaskRowList：`formatBytes`/`formatDuration` 小工具（组件内）；文件名 tooltip 行下不动，行内文件名右侧灰字 `1.2 GB · 42:15`。
4. ETA：`etaRef = useRef<Record<string, { stage: string; t0: number; p0: number }>>`；渲染时对 loading 阶段计算；显示 `t('meta.eta', { min })` 或 `meta.etaLessMin`；终态/阶段变化重置条目。
   **验证**：新导入文件显示大小；转写开始后出现时长与「剩约」；历史工程行不显示（无字段）；门禁。

## T3 服务商分组导购 + 测试修缮

**文件**：`types/provider.ts`（group 字段）、`renderer/components/resources/ProvidersTab.tsx`（分组渲染/推荐卡/搜索/测试语向/结果常驻卡）、`renderer/public/locales/{zh,en}/translateControl.json`、`renderer/public/locales/{zh,en}/common.json`（如需）。
**改动**：

1. ProviderType 加 `group?: 'free' | 'ai' | 'mt'`；为 17 个内置项标注（free: deeplx/ollama/google）。
2. 左列结构：搜索 Input → 推荐卡（两行可点）→ 三个分组段（标题 + 项）→ 自定义段 → 添加按钮（移至自定义段尾或保持顶部——保持现位）。
3. 过滤逻辑：query 非空时各组 filter 后空组隐藏。
4. 测试：`getUserConfig` 读语向（state 缓存一次性加载）；样本文本 zh→'你好' 否则 'Hello'；`testResult` state（success/error/translation/elapsed/langPair/model）渲染常驻卡。
5. 文案：addCustomProvider 系列改「自定义 AI 服务（OpenAI 兼容）」。
   **验证**：三组渲染顺序与归组正确；推荐卡点击选中；搜索过滤即时；测试语向跟随配置、结果常驻；门禁。

## T4 i18n + 门禁 + 交接

`node scripts/check-i18n.mjs` 通过；renderer TSC 0；main ≤95；三个 commit 完成后 interactive_feedback 交接附实机验证清单。
