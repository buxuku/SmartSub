# Tasks: embedded-subtitle-start-prompt

## 1. 共用类型与主进程

- [ ] 1.1 `types/embeddedSubtitle.ts`（新增）：探测请求 `{ filePaths }`、命中信息 `{ filePath, tracks: [{ language?, codec }] }`、结果 `{ status: 'found' | 'none' | 'unknown', hit?, checked, candidates, elapsedMs }`
- [ ] 1.2 `main/helpers/embeddedSubtitleProbe.ts`（新增）：从 `audioProcessor.ts` 搬出 `probeEmbeddedSubtitles`，只依赖 `ffmpeg-static` 与 `child_process`；新增可选 `AbortSignal`（已中止则不 spawn；中止即终止子进程并返回空，不记警告）与 `windowsHide: true`；行为与超时语义不变。`audioProcessor.ts` 原样再导出，`fileProcessor.ts` 不改
- [ ] 1.3 `main/helpers/embeddedSubtitleScan.ts`（新增，纯逻辑）：`scanForEmbeddedSubtitles(filePaths, { probe, concurrency = 4, budgetMs = 1000 })`——去重、按 `canHaveEmbeddedSubtitle` 过滤容器、固定大小的工作池、只把文本字幕轨算命中、首个命中即中止其余、预算到点即中止；返回 `found | none | unknown`；探测函数抛错按「该文件无结果」处理
- [ ] 1.4 `main/helpers/ipcEmbeddedSubtitleHandlers.ts`（新增）：`findEmbeddedSubtitles` 校验入参（字符串数组，去重并限量）、调用调度、记一条日志（检查数 / 候选数 / 用时）；`main/background.ts` 注册；`main/helpers/store/types.ts` 的 `settings` 新增可选 `embeddedSubtitlePrompt`（`false` 表示不再提示，缺省为提示）；不加进 `automation/catalog.ts`

## 2. 渲染进程

- [ ] 2.1 `renderer/lib/embeddedSubtitleScan.ts`（新增）：`findEmbeddedSubtitleHit({ typeDef, files, formData })`——在发出 IPC 之前先判断不探测的情形（翻译字幕类、`useEmbeddedSubtitles === false`、`embeddedSubtitlePrompt === false`、没有可探测的文件），再带 1500 ms 超时调用 `findEmbeddedSubtitles`；任何异常或超时返回 `null`（失败开放）
- [ ] 2.2 `renderer/hooks/useEmbeddedSubtitlePrompt.tsx`（新增）：`requestChoice(hit)` 返回 `'use' | 'asr' | 'cancel'`；对话框结构沿用 `useTaskCloudConsent`，含「记住我的选择，不再提示」复选框；勾选时在返回前写入 `settings.embeddedSubtitlePrompt = false` 与 `updateTaskDefaults({ useEmbeddedSubtitles })`，写入失败吞掉；取消 / Esc / 遮罩 / 卸载一律是 `'cancel'`，绝不记住
- [ ] 2.3 `renderer/hooks/useTaskSubmission.ts`：`submit(input, { promptEmbeddedSubtitles = true })`——与第一次 `validateTaskStart` 并行启动探测；校验通过后在 `confirming` 阶段、云端上传确认之前取探测结果并询问；`use` / `asr` 改写本次 `snapshot.formData.useEmbeddedSubtitles`，`cancel` 终止并回到 `idle`；`dialog` 同时渲染两个对话框。`renderer/pages/[locale]/tasks/[type].tsx` 的重试传 `promptEmbeddedSubtitles: false`
- [ ] 2.4 `renderer/components/tasks/EmbeddedSubtitleControl.tsx`（新增）：开关（任务级，`form.setValue('useEmbeddedSubtitles', …, { shouldDirty: true })`）与「开始前提示我选择」复选框（挂载时 `getSettings`，改动乐观更新并 `setSettings`，失败回滚；开关关闭时置灰）；`renderer/components/tasks/AdvancedSheet.tsx` 在「转写」分区顶部、需要转写的媒体任务渲染它；`renderer/components/tasks/OutputFormatControl.tsx` 删除开关与已不使用的 `Switch` 导入、以及引用不存在的 `configBar.embeddedSubtitlesTip`
- [ ] 2.5 `renderer/public/locales/{zh,en}/{home,tasks}.json`：对话框文案（`home:embeddedPrompt.*`）与高级设置控件文案；`configBar.embeddedSubtitles` 保留（只读快照栏仍在用）

## 3. 测试

- [ ] 3.1 `scripts/test-embedded-subtitle-scan.ts`（新增，`test:embedded-subtitle-scan`，加入 `test:pro-baseline`）：调度——命中即停并中止其余、并发上限、容器过滤与去重、位图轨不算命中、预算到点返回 `unknown` 且中止在途探测、外部中止、探测抛错按无结果、全部检查完才是 `none`、空输入；真实 ffmpeg——生成带文本字幕轨 / 无字幕轨 / 仅图像轨的小文件，验证探测、中止与 `found | none`
- [ ] 3.2 `scripts/test-task-submission-ui.tsx`：给 mock 补 `findEmbeddedSubtitles`；断言不弹窗的情形零探测（`useEmbeddedSubtitles: false`、提示已关闭、翻译类、重试、无可探测文件）、探测出错 / 返回 `none` / `unknown` 仍照常提交
- [ ] 3.3 `renderer/hooks/__tests__/useTaskSubmissionEmbeddedPrompt.test.tsx`（新增，jest + 真实对话框）：命中后弹窗且内容含文件名与轨道；使用 / 改用只改本次载荷且不写任何设置；取消不提交；勾选「记住」只写 `embeddedSubtitlePrompt` 与 `useEmbeddedSubtitles` 两项；勾选后取消不写；写入失败仍提交；校验失败不弹窗；弹窗在云端上传确认之前；探测与校验并行
- [ ] 3.4 `renderer/components/__tests__/EmbeddedSubtitleControl.test.tsx`（新增）：开关写表单、复选框写设置并可回滚、开关关闭时复选框置灰、读设置失败时的显示
- [ ] 3.5 `renderer/components/__tests__/OutputFormatControl.test.tsx`：气泡里不再有内封字幕开关
- [ ] 3.6 变异检查：对调度与提交流程的关键行为各做一处手工变异（不中止其余探测、不限并发、预算不生效、位图轨算命中、探测出错抛给调用方、校验前就弹窗、先上传确认后询问、取消也写入、未勾选也写入、只写一处、重试也询问、`useEmbeddedSubtitles === false` 仍探测），逐一确认有测试失败

## 4. 验证

- [ ] 4.1 `yarn typecheck`（renderer、main、automation、crash 四个 tsc 项目）、`yarn check:i18n` 通过；所有改动与新增文件 `prettier --check` 通过
- [ ] 4.2 `yarn test:renderer`（jest `--runInBand`，与 CI 一致）、`yarn test:parameter-persistence` 通过
- [ ] 4.3 `yarn test:pro-baseline`（含新增的 `test:embedded-subtitle-scan` 与 `test:task-submission`）、`yarn test:engines`、`yarn test:toolbox` 通过
- [ ] 4.4 `yarn build`（renderer + main + CLI/MCP 入口）、`yarn check:jassub-guard`、`yarn test:automation` 通过（改动触及 `main/**` 与 `types/**`）
- [ ] 4.5 Electron 端到端：在开发服务器上用真实的带内封字幕的视频，观察点击「开始」到弹窗的耗时、各出口、记住后不再弹窗、在高级设置里重新打开提示
- [ ] 4.6 `openspec validate embedded-subtitle-start-prompt --strict` 通过
