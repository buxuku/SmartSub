# P3 启动台 + 任务页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页改为启动台（5 张任务卡 + 就绪横幅 + 最近任务），新增 `/tasks/[type]` 任务页 ×3（内联配置条 + 高级抽屉 + 任务行重设计 + 完成横幅 + 日志面板）。任务数据仍为会话级（getTasks/setTasks IPC），持久化留给 P5。

**上游设计:** 蓝图 §4 §5；线框 `launchpad-taskpage.html`。

## 代码事实（已核实）

- 配置通过 `useFormConfig`（RHF `form.watch` → `setUserConfig`）自动持久化；`form.setValue` 对未注册字段同样触发 watch 与持久化。
- 任务队列：`handleTask({files, formData})` / `pauseTask` / `resumeTask` / `cancelTask` / `getTaskStatus` / `taskComplete` 事件；任务列表 `getTasks` / `setTasks` / `clearTasks`。
- 文件事件：`file-selected`（openDialog 回调）、`taskStatusChange/taskProgressChange/taskErrorChange/taskFileChange`（由 `useIpcCommunication` 消费）。
- 阶段字段实为字符串 `undefined|'loading'|'done'|'error'`（IFiles 类型标 boolean 是已知债，P5 修）；进度在 `${key}Progress`，错误在 `${key}Error`，听写后端标签在 `whisperBackend`。
- 字幕文件输入（translateOnly 或拖入 srt）只走 `translateSubtitle` 阶段（`isSubtitleFile` 判定）。
- 打开所在文件夹可复用 `subtitleMerge:openOutputFolder`（`shell.showItemInFolder`）。
- 日志：`getLogs` / `newLog` / `clearLogs`。
- `ui/sheet.tsx` 不存在，需新增（radix dialog + cva 均已有依赖）。
- 动态路由静态导出：`getStaticPaths` 需自行枚举 locale × type。

## 类型映射（renderer/lib/taskTypes.ts 新建）

| slug               | taskType             | 输入     | 阶段           |
| ------------------ | -------------------- | -------- | -------------- |
| generate-translate | generateAndTranslate | media    | 提取→听写→翻译 |
| generate           | generateOnly         | media    | 提取→听写      |
| translate          | translateOnly        | subtitle | 翻译           |

```ts
export const TASK_TYPES = [
  {
    slug: 'generate-translate',
    taskType: 'generateAndTranslate',
    accepts: 'media',
    needsModel: true,
    hasTranslate: true,
  },
  {
    slug: 'generate',
    taskType: 'generateOnly',
    accepts: 'media',
    needsModel: true,
    hasTranslate: false,
  },
  {
    slug: 'translate',
    taskType: 'translateOnly',
    accepts: 'subtitle',
    needsModel: false,
    hasTranslate: true,
  },
] as const;
```

---

## Task 1: 地基（taskTypes + ui/sheet + i18n namespace）

**Files:**

- Create: `renderer/lib/taskTypes.ts`（上表 + `bySlug`/`byTaskType` 帮助函数）
- Create: `renderer/components/ui/sheet.tsx`（标准 shadcn sheet）
- Create: `renderer/public/locales/{zh,en}/launchpad.json`
- Create: `renderer/public/locales/{zh,en}/tasks.json`

launchpad.json（zh 核心 key）：title/subtitle、`card.generateTranslate(+Desc)`、`card.generate(+Desc)`、`card.translate(+Desc)`、`card.proofread(+Desc)`、`card.merge(+Desc)`（输入→输出句式）、`needsModelBadge`、`banner.noModel(+Cta)`、`banner.noProvider(+Cta)`、`recentTasks`、`noRecentTasks`、`dropHint`。

tasks.json（zh 核心 key）：`configBar.*`（model/sourceLanguage/targetLanguage/provider/style/format 标签）、`advanced`（高级选项）、`advancedDesc`、分区 `section.recognition/output/execution`、`configRemembered`（配置会自动记住）、`stage.extract/transcribe/translate`、`row.proofread/openFolder/retry/remove`、`completion.title`（{{done}} 个文件已完成）/`completion.failed`（{{failed}} 个失败）/`completion.retryFailed`/`completion.dismiss`、`logs.title/clear/expand/collapse`、`empty.dragMedia/dragSubtitle`（沿用 home 文案语义）、`goDownloadModel`。

- [ ] 写四个 json（zh/en 同步）+ taskTypes.ts + sheet.tsx
- [ ] tsc 非测试 0 错误，提交 `feat(tasks): add task type registry, sheet primitive and i18n namespaces`

## Task 2: 任务页组件群（先组件后页面）

**Files:**

- Create: `renderer/components/tasks/InlineConfigBar.tsx`
- Create: `renderer/components/tasks/AdvancedSheet.tsx`
- Create: `renderer/components/tasks/TaskRowList.tsx`
- Create: `renderer/components/tasks/CompletionBanner.tsx`
- Create: `renderer/components/tasks/LogPanel.tsx`

**InlineConfigBar**（props: form/formData/systemInfo/providers/typeDef）：

- 横向 flex-wrap 紧凑控件（label xs muted + Select h-8 w-auto），直接 `formData[name]` + `form.setValue(name, v)`。
- 按 typeDef 显示：generateAndTranslate → model/sourceLanguage/targetLanguage/translateProvider/translateContent；generateOnly → model/sourceLanguage/subtitleOutputFormat；translateOnly → sourceLanguage/targetLanguage/translateProvider/translateContent。
- model 控件复用 `Models` 组件；无已装模型且未用本地 whisper → 显示「去下载模型」链接按钮（→ `/{locale}/resources?tab=models`）。
- provider 列表为空 → 「去配置翻译服务」链接（→ providers tab）。

**AdvancedSheet**（props: form/formData/typeDef/open/onOpenChange）：

- shadcn Sheet right side，`<Form {...form}>` + FormField 沿用 TaskConfigForm 既有字段实现，按 typeDef 显隐：
  - 识别（仅 media 类）：prompt、maxContext、saveAudio
  - 输出与保存：sourceSrtSaveOption(+customSourceSrtFileName，media 类)、targetSrtSaveOption(+customTargetSrtFileName，hasTranslate)、subtitleOutputFormat（generateOnly 时已在配置条则不重复显示，其余类型放这里）
  - 执行：maxConcurrentTasks、translateRetryTimes（hasTranslate）
- 每项 FormDescription 人话说明（i18n 沿用 home namespace 既有 tip key，缺的在 tasks.json 补）。

**TaskRowList**（props: files/typeDef/formData/taskStatus/onProofread/onDelete/onRetry）：

- 行结构：文件名行（删除 ✕ hover 显示 + 名称 truncate + 路径 tooltip）→ 阶段指示条（`提取 › 听写 › 翻译` chips：done=绿勾，loading=蓝加粗+spinner，error=红，pending=muted；字幕输入只显示「翻译」）+ 单一进度条（当前阶段进度，整体 % = 完成阶段均摊 + 当前阶段进度/阶段数）+ 右侧 %；听写 loading 时显示 whisperBackend 徽标。
- 行动作（右侧）：[校对]（解锁条件沿用现逻辑：generateOnly 看 extractSubtitle done，否则 translateSubtitle done）、[📂]（invoke `subtitleMerge:openOutputFolder`，路径取 `translatedSrtFile || srtFile || filePath`，文件存在性不另检）、错误时 [重试]（onRetry(file)，仅 taskStatus 非 running/paused 时可用）。
- 错误行：阶段 chip 红 + 行下 truncate 错误文案 + tooltip 全文。
- 空状态：保留现 dropzone 视觉（FileUp + 拖拽提示，点击 openDialog）。

**CompletionBanner**（props: files/typeDef/formData/taskStatus/onProofread/onDismiss）：

- 显示条件：files 非空、所有文件各必需阶段均为 'done'|'error'（必需阶段按 typeDef + isSubtitleFile + translateProvider==='-1' 推导）、至少一个全 done、未被 dismiss。
- 绿色横幅：✓「{{done}} 个文件已完成」(+「{{failed}} 个失败」)；动作：[去校对]（首个完成文件 onProofread）、[打开文件夹]（首个完成文件 reveal）、failed>0 时 [重试失败项]（send handleTask({files: failedFiles, formData})）、右上 ✕ dismiss。

**LogPanel**：

- 底部固定条：终端 icon + 「运行日志」+ 最新一条摘要（折叠时）+ chevron；展开 max-h-44 mono 滚动区（自动滚底）+ 清空按钮；数据源 getLogs/newLog/clearLogs（沿 LogDialog 实现）。

- [ ] 实现五组件，tsc 非测试 0 错误
- [ ] 提交 `feat(tasks): add task page building blocks (config bar, advanced sheet, row list, completion banner, log panel)`

## Task 3: 任务页 `/tasks/[type]`

**Files:**

- Create: `renderer/pages/[locale]/tasks/[type].tsx`

- getStaticPaths：locale × slug 全枚举（fallback:false）；getStaticProps = makeStaticProperties(['common','home','tasks'])。
- 页面状态沿 home.tsx：files/getTasks/setTasks、useIpcCommunication、useSystemInfo、useFormConfig、providers 加载、拖拽到列表区（fileType 按 typeDef.accepts）、ProofreadEditor 内嵌切换（pendingFileForProofread 逻辑整体平移）。
- mount 后：formData 加载完且 taskType ≠ 映射值时 `form.setValue('taskType', mapped)`（带 guard 防循环）。
- 布局（上→下）：页头（标题 + 「配置会自动记住」hint + 右侧 [导入][清空][高级选项]）→ InlineConfigBar → CompletionBanner → 列表区（TaskRowList in ScrollArea，整块 dropzone）→ 底部行（TaskControls 右对齐）→ LogPanel。
- taskStatus：页面持有（getTaskStatus + taskComplete 监听），传给 TaskRowList/CompletionBanner；TaskControls 内部仍自管（不动）。
- onRetry(file)：send `handleTask({files:[file], formData})` 并置 taskStatus running。

- [ ] 实现页面，tsc + 提交 `feat(tasks): add dedicated task pages with inline config and redesigned task rows`

## Task 4: 启动台（home 重写）+ Layout 高亮

**Files:**

- Rewrite: `renderer/pages/[locale]/home.tsx`
- Modify: `renderer/components/Layout.tsx`（home 高亮条件加 `/tasks/`）

- 启动台：页头（标题 + 副标题）→ 就绪横幅（黄：无已装模型 → 「下载推荐模型」CTA → resources?tab=models；模型 OK 但无已配置 provider → 提示去配置；都 OK 不显示；数据：getSystemInfo + getTranslationProviders + isProviderConfigured）→ 任务卡 5 张（3 张 → `/tasks/[slug]`，需要模型的卡右上「需要模型」小标（未就绪时）；校对 → `/proofread`；合成 → `/subtitleMerge`）→ 最近任务（getTasks 末 5 条倒序：文件名 + 派生状态点 + 点击 → 当前 taskType 对应任务页；空则一句提示）。
- 拖文件到生成/翻译卡：onDrop → getDroppedFiles({files, taskType: accepts==='subtitle'?'translate':'media'}) → getTasks 合并 → setTasks → form.setValue('taskType', mapped) → router.push 任务页。
- getStaticProps namespaces: ['common','launchpad']。

- [ ] 实现 + tsc + 提交 `feat(launchpad): replace home with task launchpad and readiness banner`

## Task 5: 终验

- [ ] `npx tsc --noEmit -p renderer/tsconfig.json` 非测试 0 错误（基线 362 不增）
- [ ] `yarn build` 成功，确认 `/[locale]/tasks/[type]` 6 条路径生成
- [ ] interactive_feedback 请用户冒烟（三任务页全流程、启动台拖拽、横幅、日志面板、zh/en、暗色）

## 明确不做（P5/P6 承接）

- WorkItem 落库/重启恢复/校对编辑器路由化/合成预填/系统通知（P5）
- VAD 迁入高级抽屉、TaskConfigForm/TaskList/TaskListControl/TaskStatus 旧组件删除、`useIpcCommunication` 泄漏修复（P6；本期旧组件保留不引用）
