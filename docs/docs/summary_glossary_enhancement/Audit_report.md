---
title: 摘要与任务词库增强：分支代码审计报告
description: feat/summary_glossary_enhancement 相对 main 的代码、契约、安全与验证审计。
draft: true
---

# 摘要与任务词库增强：分支代码审计报告

审计日期：2026-08-14
审计分支：`feat/summary_glossary_enhancement`
比较基准：`main@27459b3` → `HEAD@c0d6e86`
审计方法：按 `code-review-expert` 的 SOLID、安全、代码质量和删除计划四个维度，审阅 `main...HEAD` 全量差异及相关调用方，并运行项目内可用验证。

## Code Review Summary

**Files reviewed**: 47 个变更文件，6,293 行变更（6,227 additions / 66 deletions），另核对关联调用方、Docusaurus 配置与任务规格。
**Original assessment**: **REQUEST_CHANGES**
**Current disposition**: **ACCEPTED_WITH_USER_RISK（已完成用户批准的修复）**

本分支的核心设计整体清晰：任务词库三态（`undefined` / `[]` / 显式 ID）、摘要独立调用、失败降级、单次模板渲染、词库后摘要的注入顺序，以及 sidecar 透传均有相应实现和专项测试。原始审计发现如下；2026-08-14 用户逐项处置后，3、5、6、7 已通过 TDD 修复，1、2、4 明确接受现状，8 保持低优先级未改。

### Disposition Update — 2026-08-14

| Finding | Decision           | Current state                                                             |
| ------- | ------------------ | ------------------------------------------------------------------------- |
| 1       | 无需处理           | 风险接受；原始日志与历史保持不变                                          |
| 2       | 合理长度偏差可接受 | 不新增硬上限；`SUMMARY_MAX_CHARS` 只是审计建议的应用侧常量，不是 API 参数 |
| 3       | 同意修订           | 已用 last-write-wins debounce writer + unmount `flush()` 修复，并新增测试 |
| 4       | 无需处理           | 风险接受；Docusaurus 目录保持不变                                         |
| 5       | 同意修订           | 仅无路径/缺键回落；读盘或解析失败向 IPC 错误边界传播                      |
| 6       | 同意修订           | 摘要、校正、校对 context 均追加三态词库来源；摘要补冲突/命中日志          |
| 7       | 同意修订           | 显式判别 `settled.ok === false`；新增文件原有两条 `TS2339` 已清零         |
| 8       | 未要求修订         | 保持 P3 后续项                                                            |

| Severity | Count | Merge gate                       |
| -------- | ----: | -------------------------------- |
| P0       |     0 | 无                               |
| P1       |     3 | 合并前必须处理                   |
| P2       |     4 | 建议同批处理，至少建立明确后续项 |
| P3       |     1 | 可后续修复                       |

## P0 — Critical

未发现 P0。

## P1 — High Priority

### 1. [P1] 完整手测字幕与译文被提交到分支历史

**Location**: `docs/docs/summary_glossary_enhancement/summary_glossary_test.log:65`、`:164`、`:3262`
**Related evidence**: 同文件共 3,511 行 / 129,895 字节；日志从第 1 批持续到第 13 批，记录 647 条源字幕及模型译文；`HEAD` 与 `origin/feat/summary_glossary_enhancement` 同步。

**Problem**

`summary_glossary_test.log` 不是最小化的测试证据，而是一次真实剧集翻译的近完整请求/响应转储。它同时包含本机临时路径、服务商名称、模型、API endpoint、自定义参数和 system prompt。审计未发现未遮罩的密钥；`apiKey` 在 `:44` 显示为遮罩值，但这不消除字幕内容、环境元数据和仓库体积风险。

**Impact**

- 真实影视字幕及完整译文进入 Git 历史，存在版权、授权范围和内容外泄风险。
- 即使后续只删除工作树文件，内容仍保留在已有 commit 和远端分支历史中。
- 原始日志会放大后续审计、克隆、索引与意外发布的暴露面。

**Recommendation**

合并前从分支历史中移除该日志，而不是仅追加一个删除 commit。用合成字幕或严格脱敏的短样本替代，只保留批次数、cue 数、摘要长度、哈希、成功计数和必要的首尾结构证据；不要保留成集原文/译文、本机路径或服务商配置。若该分支已被其他人拉取或镜像，还需把远端历史清理边界和通知范围纳入处理。

### 2. [P1] “摘要不超过 400 字”只有提示词约束，真实输出已突破且会按批次重复注入

**Location**: `types/summaryPrompt.ts:15`、`main/helpers/episodeSummaryCore.ts:83-90`、`main/helpers/episodeSummary.ts:279-314`、`main/translate/services/ai.ts:270-278`
**Observed evidence**: `docs/docs/summary_glossary_enhancement/summary_glossary_test.log:62` 记录实际注入摘要为 **676 字**。

**Problem**

出厂 prompt 要求模型不超过 400 字，但 `settleSummaryText` 对剥离 `<think>` 后的任意非空文本直接返回成功，没有长度校验、截断或降级。随后该文本被持久化，并在每个翻译批次的 system prompt 中重复注入。恢复任务时，`main/helpers/episodeSummary.ts:133-149` 也会直接复用既有超长摘要。

**Impact**

- 已经出现明确的规格违例，说明仅依赖模型遵循 prompt 不可靠。
- 摘要长度会乘以翻译批次数，增加费用和上下文占用；极端响应可挤压字幕与输出协议的有效上下文，导致翻译失败或质量下降。
- 超长摘要写入任务/sidecar 后会跨恢复流程持续传播。

**Recommendation**

定义单一 `SUMMARY_MAX_CHARS = 400`，在 `<think>` 剥离后、持久化前执行 Unicode 安全的硬边界；对超限文本采用明确且可观测的策略（例如按码点截断并记录原长/截断事件），恢复既有摘要时也执行同一归一化。补充 400、401、超长数组响应、含 `<think>` 以及 resume 路径测试，确保写盘和每批注入都不会越界。

### 3. [P1] 摘要提示词的最后一次编辑会在 400ms 内离开页面时静默丢失

**Location**: `renderer/components/resources/SummaryPromptPanel.tsx:21-32`、`:42-48`
**Reference pattern**: `renderer/components/resources/ProvidersTab.tsx:281-325`

**Problem**

编辑器使用 400ms debounce，但卸载 cleanup 只清除定时器，没有保存挂起值。用户输入后立即切换页面、关闭窗口或组件因路由变化卸载时，最后一次修改会丢失。`persist()` 的失败也没有状态或提示。仓库内 `ProvidersTab` 已通过 `pendingProvidersRef` + unmount flush 处理同一类问题，当前新组件没有沿用该模式。

**Impact**

这是静默的用户配置丢失：界面先显示新内容，但下次进入又恢复旧值，且用户没有失败反馈。

**Recommendation**

保存 pending draft ref，在 debounce 到期、`blur`、恢复出厂和 unmount 时统一 flush；结构性操作应先取消旧 timer，避免旧值回写覆盖。为 IPC 失败提供最小可见反馈，并增加 fake-timer 组件测试，覆盖“输入后立即卸载”“连续输入只保存最后值”“恢复出厂不会被旧 timer 覆盖”。

## P2 — Medium Priority

### 4. [P2] 内部方案与证据位于 Docusaurus 内容根，`unlisted` 不是访问控制

**Location**: `docs/docusaurus.config.ts:76-86`、`docs/docs/summary_glossary_enhancement/summary_glossary_enhance_plan.md:1`、`docs/docs/summary_glossary_enhancement/evidence.md:1`

**Problem**

classic preset 使用默认 `docs` 内容目录并把 `routeBasePath` 设为 `/`，因此 `docs/docs/**` 下的 Markdown 属于文档构建输入。现有内部方案与证据只设置 `unlisted: true`；它能阻止侧栏/列表发现，但不是鉴权，也不应被当作“不会发布”的保证。

**Impact**

下一次文档站构建/部署可能为内部方案和证据生成可直接访问的路由。报告、日志索引或后续内部材料继续放在该目录，会重复扩大误发布风险。

**Recommendation**

把内部审计/方案/原始证据移出 Docusaurus 内容根，或在 docs plugin 中显式排除内部子树，并在发布流水线检查生成 route 清单。本报告因用户指定路径保存在此处，并设置 `draft: true`；这只降低生产构建风险，不替代仓库权限或内容脱敏。

### 5. [P2] sidecar 读取/解析失败会误回落到“全部全局已启用词库”

**Location**: `main/helpers/ipcProofreadHandlers.ts:64-78`
**Affected callers**: 同文件 `:569-597`、`:779-805`、`:927-956`

**Problem**

规格只把“独立校对无 sidecar”或“旧 sidecar 无 `glossaryIds` 键”定义为 `undefined` 回落。当前 helper 却把任何读取或解析异常都 catch 后返回 `undefined`。因此，一个原本明确保存 `[]`（禁用全部）或指定 IDs 的任务，只要 sidecar 损坏、权限异常或读取失败，就会静默切换成全部全局已启用词库。

**Impact**

校对台的单条优化、批量优化和重翻可能使用与原任务不同的术语集合，造成不可预期的译名变化；warning 日志不足以阻止错误结果继续产生。

**Recommendation**

把结果区分为 `absent` / `loaded` / `invalid`：仅 `absent` 或缺键允许回落；`invalid` 应返回用户可见失败或要求显式确认，不能伪装成 `undefined`。增加损坏 JSON、不可读文件、缺键、显式空数组和显式 IDs 的调用级测试。

### 6. [P2] 词库来源标注没有覆盖摘要和校对调用链

**Location**: `main/helpers/episodeSummary.ts:231-253`、`main/helpers/subtitleCorrectionService.ts:218-225`、`:295-309`、`main/helpers/ipcProofreadHandlers.ts:579-597`
**Correct reference**: `main/translate/services/translationProvider.ts:83-93`

**Problem**

规格要求 `logGlossaryConflicts` / `logGlossaryMatches` 的 context 带“任务词库 N 个”或“全局已启用”。翻译主链已经调用 `describeGlossarySource`，但摘要链只做匹配/筛选而不记录冲突、命中和来源；字幕校正与校对单条/批量优化仍使用固定的“AI 字幕校正”“校对页……”标签。

**Impact**

三态数据功能上虽能传播，但运行日志无法回答结果到底来自 `undefined` 回落、显式 `[]`，还是指定 IDs。出现漏命中或冲突时，手测和用户支持无法从证据链复原真实词库来源。

**Recommendation**

集中生成 glossary context，将 source label 传入摘要、管线校正、校对单条和批量路径；摘要也应记录 conflicts、included 和 omitted count。为三种 `glossaryIds` 状态分别断言各消费点的日志上下文，防止只测纯函数、不测调用方。

### 7. [P2] 新增主进程摘要编排未通过项目级 TypeScript 静态检查

**Location**: `main/helpers/episodeSummary.ts:279-291`

**Problem**

`yarn tsc --noEmit` 在新文件的 `settled.error` 两处报 `TS2339`。当前项目 `strict: false` 下，`if (!settled.ok)` 没有按预期把返回联合类型窄化到失败分支；改为显式 `settled.ok === false` 可使判别稳定。专项 `test:summary` 只编译纯函数测试入口，`yarn build` 也未把这两处主进程诊断作为失败门槛，因此两者均为绿时仍会遗漏该问题。

项目级 `tsc` 同时存在多项基线/配置错误，本次不能把整条命令的失败都归因于该分支；但上述两条诊断位于本分支新增运行时代码，属于可独立修复的增量问题。

**Impact**

摘要编排路径没有被现有绿色构建和专项测试完整静态覆盖，后续联合类型变化可能继续以“构建通过、主进程类型失败”的形式漏过。

**Recommendation**

先修复两处判别式并为 `runEpisodeSummaryStage` 增加可编译的编排测试/类型门槛；随后把项目基线类型错误单列清理，避免用已有噪声掩盖新增诊断。

## P3 — Low Priority

### 8. [P3] 摘要降级阶段仍显示绿色成功图标

**Location**: `renderer/components/tasks/TaskRowList.tsx:135-166`

**Problem**

代码计算了 `summarizeWarning` 并把它放进 tooltip，但 `done` 状态的颜色和图标只检查 `manuscriptWarning`。因此 `skipped-trivial`、provider 不可用、空响应或调用失败都会显示绿色 `CheckCircle2`；只有悬停标题能看到原因。

**Impact**

非阻断降级在阶段轨上看起来与“成功生成并注入摘要”相同，削弱了用户对费用、跳过和降级原因的判断。

**Recommendation**

抽出 `stageWarning = manuscriptWarning || summarizeWarning`，在保持阶段状态为 `done` 的同时显示 warning 颜色/图标；补一个渲染测试确保摘要失败不变成任务级 error，但也不显示绿色成功。

## Good Practices Observed

- `renderTranslationSystemPrompt` 在一趟模板渲染中同时处理 glossary/summary，并测试了占位符、追加顺序及 `${...}` 不递归展开。
- `glossaryIds` 的 `undefined` / `[]` / 显式 IDs 三态在核心解析、任务表单、配方和 sidecar 类型中得到保留，专项测试覆盖了主要纯函数与持久化边界。
- 摘要取消沿任务 signal 上抛，而普通 provider/空响应错误以稳定 error code 降级，不错误地把整项翻译任务标成失败。
- AI 翻译、Qwen-MT、结构化输出、取消、refine、recipe 和 pipeline 相关回归均保持通过。

## Removal / Iteration Plan

| Item                                                      | Evidence                                                                                  | Recommendation                                    | Timing                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------- |
| `summary_glossary_test.log`                               | 完整 647 cue 请求/响应；3,511 行；只用于手测证据                                          | 用户明确无需处理；保留风险记录                    | **Keep by decision**       |
| `normalizeSummaryResponse`                                | `main/helpers/episodeSummaryCore.ts:79-81`；仓库仅定义、无调用                            | 删除，避免与 `settleSummaryText` 形成两套归一入口 | **Remove now**             |
| 两个摘要 heading 常量                                     | `types/summaryPrompt.ts:59` 与 `main/glossary/core.ts:369` 文本重复；测试和运行时各用一份 | 选一个公共常量作为单一来源并让测试覆盖运行时值    | **Consolidate now**        |
| `SummaryProviderResolution.source`                        | `main/helpers/episodeSummary.ts:40-43` 返回但无消费者                                     | 若用于来源日志则实际消费；否则删除字段            | Remove later / consume now |
| `renderGlossarySystemPrompt`、`injectGlossaryPromptBlock` | 仍有兼容调用方，方案也明确保留                                                            | 保持薄封装，不为本次摘要改造强行迁移无关路径      | **Keep**                   |

## Verification Evidence

| Check                          | Result        | Notes                                                                                                            |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `yarn test:glossary`           | PASS          | 90/90；新增三态来源 context                                                                                      |
| `yarn test:summary`            | PASS          | 38/38；新增 debounce 最后值与 lifecycle flush                                                                    |
| `yarn test:proofread-data`     | PASS          | 37/37；新增缺路径、缺键、显式空数组和损坏 sidecar 边界                                                           |
| `yarn test:refine`             | PASS          | 60/60                                                                                                            |
| `yarn test:translation-cancel` | PASS          | 6/6                                                                                                              |
| `yarn test:qwen-mt`            | PASS          | 19/19                                                                                                            |
| `yarn test:structured-output`  | PASS          | 23/23                                                                                                            |
| `yarn test:untranslated-flow`  | PASS          | 18/18                                                                                                            |
| `yarn test:recipes`            | PASS          | 配方回归通过                                                                                                     |
| `yarn test:pipeline`           | PASS          | 管线脚本回归通过                                                                                                 |
| `yarn check:i18n`              | PASS          | locale key 对齐                                                                                                  |
| `yarn build`                   | PASS          | renderer lint/type/static pages 与 main webpack 完成；仅见既有 chunk、Browserslist、page-data 和 i18next warning |
| `yarn tsc --noEmit`            | BASELINE FAIL | 项目仍有既存诊断；本次变更的 main 文件无诊断，renderer 自身配置下本次变更文件无诊断，原两条 `TS2339` 已修复      |
| `git diff --check main...HEAD` | FAIL          | 原始 `.log` 多处行尾空格；与 P1 原始日志应移除项重合                                                             |
| Docusaurus production build    | NOT RUN       | `docs/node_modules/.bin/docusaurus` 不存在；发布 route 尚未独立验证                                              |

## Coverage Gaps and Residual Risk

- 本次没有调用真实外部 LLM，也没有重跑分支记录的 S01E06 手测；只审阅了其代码、日志和持久化证据。
- 没有执行浏览器/打包应用内的交互回归；debounce writer 的 lifecycle 行为已有纯测试且 renderer build 通过，但组件卸载仍建议人工 UI 复核。阶段图标保持未修。
- 方案明确接受“整份字幕一次摘要、不自动切块”的第一版边界；超长字幕仍可能因 provider context/timeout 而降级。该项不是本次偏离，但发布说明应保留。
- `unlisted`/`draft` 不是仓库权限。任何必须保密或受版权约束的原始证据都不应仅靠文档 front matter 保护。

## Recommended Next Steps

1. 若需要，单独决定是否处理 P3 阶段图标；它不在本轮批准范围内。
2. 1、2、4 已按用户决定记录为风险接受，不在当前修复 frontier。
3. 提交前保持本报告与业务改动同一处置状态，并复核工作区只包含授权范围。

本轮后续按用户授权修改 4 条行为，并新增相应测试；未修改原始手测日志、摘要长度策略、Docusaurus 发布结构或 P3 阶段图标。
