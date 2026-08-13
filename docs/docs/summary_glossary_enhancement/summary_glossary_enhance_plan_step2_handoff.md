---
unlisted: true
---

# 摘要 + 词库增强：Step 1 / Step 2 交接

**日期**：2026-08-13
**分支**：`feat/summary_glossary_enhancement`
**基线**：`27459b3`（v3.7.0 release notes）
**方案**：[`summary_glossary_enhance_plan.md`](./summary_glossary_enhance_plan.md) rev.5
**交付方式**：`/implement-opus-grok`（Opus 主控 + Grok 实施 + 全新 Claude 子代理终审）

---

## 进度

| 步骤 | 内容 | 状态 | commit |
| --- | --- | --- | --- |
| 1 | 词库任务选用 | ✅ 已合 | `34d00da` |
| 2 | 词库透传到校对 | ✅ 已合 | `4e2ee30` |
| 3 | 出厂摘要稿 + 翻译页编辑 | ⬜ 未开始 | — |
| 4 | 先立测试骨架（RED） | ⬜ 未开始 | — |
| 5 | 摘要阶段（GREEN） | ⬜ 未开始 | — |
| 6 | 摘要注入翻译（GREEN） | ⬜ 未开始 | — |
| 7 | 文档 | ⬜ 未开始 | — |
| 8 | 开 PR 回 `main` | ⬜ 未开始 | — |

两步都通过了双轴 `$code-review` 门禁（Standards / Spec 均 PASS、0 blocking）与全新 Claude 子代理终审（均 `ship`）。

---

## Step 1 已落地的接口（后续步骤直接用，不要重造）

```ts
// main/glossary/core.ts —— 纯函数，无 electron 依赖，是唯一自动化测试缝
export function resolveTaskGlossaryEntries(
  glossaries: Glossary[],
  glossaryIds?: string[],
): GlossaryResolution;

/** 词库来源标注：undefined → 「全局已启用」；数组 → 「任务词库 N 个」 */
export function describeGlossarySource(glossaryIds?: string[]): string;

// resolveEnabledGlossaryEntries 保留为 resolveTaskGlossaryEntries(g, undefined) 的薄封装

// main/helpers/glossaryManager.ts —— 耦合 electron store
export function getTaskGlossaryResolution(ids?: string[]): GlossaryResolution;
export function getActiveGlossaryResolution(): GlossaryResolution; // = getTaskGlossaryResolution(undefined)

// main/translate/services/translationProvider.ts —— 第 11 位是 options 对象
translateWithProvider(
  provider, subtitles, sourceLanguage, targetLanguage, translator,
  onProgress?, onTranslationResult?, maxRetries = 0, useGlossary = true,
  onResponseMeta?, options?: { glossaryIds?: string[] },
)

// main/translate/types/index.ts
TranslationConfig.glossarySourceLabel?: string   // 供 ai.ts 批次日志追加来源标注

// types/types.ts
IFormData.glossaryIds?: string[]
```

渲染层：`renderer/components/tasks/GlossarySelectControl.tsx`（配置条多选，已挂在 `InlineConfigBar` 的 `hasTranslate` 块内）。

## Step 2 已落地的接口

```ts
// types/proofreadData.ts —— dependency-free，是本步唯一自动化测试缝
ProofreadDataMeta.glossaryIds?: string[];
export function normalizeMetaGlossaryIds(value: unknown): string[] | undefined;
// 内部新增 normalizeProofreadMeta()；PROOFREAD_DATA_VERSION 仍为 2

// main/helpers/proofreadData.ts
writeProofreadDataFromFiles({ ..., glossaryIds?: string[] })  // 条件展开写入 meta

// main/helpers/subtitleCorrectionService.ts
CorrectionParams.glossaryIds?: string[]   // 内部走 getTaskGlossaryResolution

// main/helpers/ipcProofreadHandlers.ts
async function readSidecarGlossaryIds(proofreadDataFile?: string): Promise<string[] | undefined>
// optimizeSubtitle / batchOptimizeSubtitles / retranslate 三个 payload 均新增 proofreadDataFile?: string
```

渲染层透传链：`ProofreadEditor`（持有 `file.proofreadDataFile`）→ `SubtitleEditToolbar` → `BatchAiOptimizeDialog`，以及 `ProofreadEditor` → `useRetranslateFailed`。

---

## 最关键的不变量（改任何一步都别破坏）

**`glossaryIds` 三态是承重的**，全链路（类型 / 表单 / IPC / JSON 持久化 / 配方快照）都不得让三者互相塌缩：

| 值 | 语义 |
| --- | --- |
| `undefined` | 回落「全部已启用」——旧配方、旧 sidecar、独立校对模式都走这条 |
| `[]` | 明确不用词库 |
| `['a','b']` | 只用这两个库，**忽略** `enabled` 开关（关掉的库仍可被显式勾上） |

配套规则：

- 畸形输入（非数组）一律按 **`undefined`**（旧行为）处理，**不是** `[]`。
- 冲突判定按全局 `order`，**不随**勾选顺序或 id 数组顺序变化；「同原文首个胜出」语义不变。
- `PROOFREAD_DATA_VERSION` 保持 `2`。sidecar `meta` 是展开合并、未知字段原样保留，加字段不需要 bump——step 5 加 `meta.episodeSummary` 时同理。
- 旧 sidecar 归一化后 **不得**写出显式 `glossaryIds: undefined` 键（用 `hasOwnProperty` 断言守住）。

---

## 验证基线（每步都要复跑并对齐数字）

本仓**没有 jest**。测试是 `tsc` 编译到 `node_modules/.cache/<name>/` 再用 `node` 跑的独立脚本。

```bash
yarn test:glossary          # 87 passed, 0 failed
yarn test:proofread-data    # 32 passed, 0 failed   （step 2 新增）
yarn test:proofread-speakers# 31 passed, 0 failed   （也走 normalizeProofreadData，改 sidecar 必跑）
yarn test:refine            # 60 passed, 0 failed
yarn test:structured-output # 23 passed, 0 failed
yarn test:recipes           # all passed
node scripts/check-i18n.mjs # exit 0

./node_modules/.bin/tsc --noEmit -p renderer/tsconfig.json
# 184 errors，且必须全部落在这 4 个既有文件（数量或文件集合变化都算回归）：
#   renderer/components/__tests__/CustomParameterEditor.test.tsx
#   renderer/components/__tests__/DynamicParameterInput.test.tsx
#   renderer/hooks/__tests__/useParameterConfig.test.ts
#   renderer/lib/__tests__/parameterValueUtils.test.ts
```

**环境坑**：

- 根目录 `tsc --noEmit -p tsconfig.json` **不能**当门禁——它不带 renderer 路径别名，会报一堆 `TS2307: Cannot find module '@/components/...'`。用 `renderer/tsconfig.json`。没有 `main/tsconfig.json`。
- `node_modules` 是用 `yarn install --ignore-scripts` 装的（跳过了 electron-builder / ensure-native 的下载），因此 **`yarn test:qwen-mt` 跑不起来**（"Electron failed to install correctly"）。已在固定点上复现，确认是环境问题，不要去修。
- `main/helpers/**`、`main/translate/**` 全部间接依赖 electron，**无法**被 tsc+node 脚本测到。写测试只能挑无 electron 依赖的缝：`main/glossary/core.ts`、`types/proofreadData.ts`。不要尝试 mock electron。
- `scripts/test-glossary.ts` 已 754 行（本仓上限 800），别再往里加，新行为开新脚本。

---

## 下一步（Step 3）要点

方案原文：出厂摘要稿 + 翻译页编辑。

- 新建 `types/summaryPrompt.ts` 的 `defaultSummaryPrompt`，`settings.summaryPrompt` 存用户改写版。
- `renderer/pages/[locale]/translation.tsx` 目前只有 25 行、body 就是 `<ProvidersTab />`，需要改成两段式布局 + 「恢复出厂」按钮 + i18n。
- 改完 i18n 记得跑 `node scripts/check-i18n.mjs`（zh / en 两个 locale 必须对称）。

后续步骤的既有约束（来自方案 rev.5 与踩坑记录）：

- 有效 batchSize = `min(normalizeBatchSize(provider.batchSize, 10), BATCH_SCHEMA_MAX_PROPERTIES=100)`，**不是** 200、也不是整集。
- `<think>` 剥离只发生在 JSON 批次解析路径；**纯文本摘要必须显式调 `stripAIThinkingContent`**，否则未闭合标签会把正文清空（触发降级）。
- `TRANSLATOR_MAP` 的值可能是 `string | string[]`，要归一化。
- 摘要走词库时：对全文做**一次** `matchGlossaryEntries` + `selectGlossaryPromptEntries`，附录标题与翻译侧不同。
- `getFileStages` 的摘要槽位需要 `typeDef.hasTranslate && translateProvider !== '-1'` 双重守卫。
- `injectGlossaryPromptBlock` 另有 3 个校对 / AI 校正调用点（`subtitleCorrectionService.ts:340`、`:414`、`ipcProofreadHandlers.ts:638`），保持原样不动。

---

## 遗留风险 / 已知缺口（都不阻塞，记录备查）

1. **来源标注只覆盖了翻译链路。** 方案要求 `logGlossaryConflicts` / `logGlossaryMatches` 的 context 都带「任务词库 N 个」/「全局已启用」，目前 `describeGlossarySource` 只接进 `translationProvider.ts` 与 `ai.ts`。校对侧三处（`ipcProofreadHandlers.ts:580,594`、`subtitleCorrectionService.ts:215`）仍是裸标签——恰恰是 sidecar 间接寻址后最难排查的地方。属于诊断信息缺口，建议在 step 7 之前补上。
2. **`describeGlossarySource` 数的是原始数组长度**，而解析器会过滤非字符串成员，所以 `['a', 1, null]` 会打成「任务词库 3 个」但实际只解析出 1 个库。仅影响日志文案。
3. **`retranslate` 恒传 options 对象**，即使 `ids` 是 `undefined`，因此该路径的批次日志新增了「，全局已启用」后缀（此前没有）。仅日志文案。
4. **sidecar 读取失败 → 回落全局已启用。** 一个明确选了 `[]`（不用词库）的任务，若 sidecar 读不出来，校对时会静默拿到全部已启用词库。这是设计上的降级选择，会记 warning，但值得知道。
5. **`readSidecarGlossaryIds` 每次单条优化都全量 parse 一遍 sidecar**（2000 条字幕约 1MB），无缓存；且 transcript 模式下读完就丢弃。长文件上可能被感知为变慢。
6. **resume 重跑保留旧 sidecar 的 `glossaryIds`。** 翻译已 `done` 的文件改了词库选择后重跑，`fileProcessor.ts:431` 的 resume 分支在 `:748` 的 sidecar 重写之前就返回了。这是既有的陈旧性形状（`sourceLanguage`、`translateContent` 同样如此），非本次引入。
7. **写入点没有自动化缝。** `writeProofreadDataFromFiles` 的条件展开与 `updateProofreadDataFromSubtitles` 的保留行为都只靠人工读代码确认（两者都耦合 electron）。
8. **`ipcProofreadHandlers.ts` 已 987 行**，超过本仓 800 行软上限。改动前就是 956 行，属既有债，未在本步拆分。
9. **`useGlossaries` 只有 `try/finally` 没有 `catch`**，IPC 失败会在配置条上表现为肯定的「还没有词库」空状态。根因在未改动的 hook 里。
10. **`testTaskGlossarySelection` 142 行**，超过 <50 行的函数指引。

## 交付过程偏差（契约层面，已如实记录）

详见 [`docs/grok-build-issues.md`](../../docs/grok-build-issues.md)（**未提交**，工作区文件）：

1. **`--resume` 无法续接线程**：桥接的 job record 台账始终为空，resume 静默回退成全新 `run`。契约要求「修正必须回到同一 Grok 线程」，本环境下不可用。
2. **修正轮 / Step 2 返回摘要而非 Grok 原文，且无 per-behaviour Red 证据**。契约要求逐字返回 + Red 强制。**未用主会话实现替代**（契约禁止），改为逐行审查 diff + 独立复跑全部验证 + 在此显式标注证据缺口。两轮终审都在明确知晓该缺口的前提下判 `ship`，并逐条复核了「若实现写错，测试是否真会失败」。

---

## 工作区状态

已提交：step 1 (`34d00da`)、step 2 (`4e2ee30`)。

**未提交的工作区文件**（有意留着，未纳入任何 commit）：

- `docs/docs/summary_glossary_enhance_plan.md` —— 方案原文。`docs/docs/` 是 Docusaurus 内容根目录，提交即会发布成站点页面；虽带 `unlisted: true`，仍建议决定后再落库。**本交接文档同样落在该目录，存在同样的发布风险。**
- `docs/grok-build-issues.md` —— 桥接问题记录，属过程产物。

**尚未获得用户授权的动作**：push、开 PR（方案 step 8）。
