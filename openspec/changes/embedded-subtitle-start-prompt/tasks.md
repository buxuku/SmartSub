# Tasks: embedded-subtitle-start-prompt

## 1. 共用类型与主进程

- [x] 1.1 `types/embeddedSubtitle.ts`（新增）：探测请求 `{ filePaths }`、命中信息 `{ filePath, tracks: [{ language?, codec }] }`、结果 `{ status: 'found' | 'none' | 'unknown', hit?, checked, candidates, elapsedMs }`
- [x] 1.2 `main/helpers/embeddedSubtitleProbe.ts`（新增）：从 `audioProcessor.ts` 搬出 `probeEmbeddedSubtitles`，只依赖 `ffmpeg-static` 与 `child_process`；新增可选 `AbortSignal`（已中止则不 spawn；中止即终止子进程并返回空，不记警告）与 `windowsHide: true`；行为与超时语义不变。`audioProcessor.ts` 原样再导出，`fileProcessor.ts` 不改
- [x] 1.3 `main/helpers/embeddedSubtitleScan.ts`（新增，纯逻辑）：`scanForEmbeddedSubtitles(filePaths, { probe, concurrency = 4, budgetMs = 1000 })`——去重、按 `canHaveEmbeddedSubtitle` 过滤容器、固定大小的工作池、只把文本字幕轨算命中、首个命中即中止其余、预算到点即中止；返回 `found | none | unknown`；探测函数抛错按「该文件无结果」处理
- [x] 1.4 `main/helpers/ipcEmbeddedSubtitleHandlers.ts`（新增）：`findEmbeddedSubtitles` 校验入参（字符串数组，去重并限量）、调用调度、记一条日志（检查数 / 候选数 / 用时）；`main/background.ts` 注册；`main/helpers/store/types.ts` 的 `settings` 新增可选 `embeddedSubtitlePrompt`（`false` 表示不再提示，缺省为提示）；不加进 `automation/catalog.ts`

## 2. 渲染进程

- [x] 2.1 `renderer/lib/embeddedSubtitleScan.ts`（新增）：`findEmbeddedSubtitleHit({ typeDef, files, formData })`——在发出 IPC 之前先判断不探测的情形（翻译字幕类、`useEmbeddedSubtitles === false`、`embeddedSubtitlePrompt === false`、没有可探测的文件），再带 1500 ms 超时调用 `findEmbeddedSubtitles`；任何异常、超时或格式不对的回答都返回 `null`（失败开放）。同文件导出纯函数 `embeddedSubtitleProbeFiles`（与 `needsTranscription` 同一个谓词）、`describeEmbeddedTrack`（`语言 · 编码`，语言用 `Intl.DisplayNames`）、`embeddedSubtitleFileName`
- [x] 2.2 `renderer/hooks/useEmbeddedSubtitlePrompt.tsx`（新增）：`requestChoice(hit)` 返回 `'use' | 'asr' | 'cancel'`；对话框结构沿用 `useTaskCloudConsent`，含「记住我的选择，不再提示」复选框；勾选时先写 `updateTaskDefaults({ useEmbeddedSubtitles })`、再写 `settings.embeddedSubtitlePrompt = false`（前者失败就不写后者，提示保持开启），写入失败吞掉；取消 / Esc / 卸载一律是 `'cancel'`，绝不记住；选择落实期间按钮与复选框置灰，Esc 与重复点击不再生效
- [x] 2.3 `renderer/hooks/useTaskSubmission.ts`：`submit(input, { promptEmbeddedSubtitles = true })`——与第一次 `validateTaskStart` 并行启动探测；校验通过后在 `confirming` 阶段、云端上传确认之前取探测结果并询问；`use` / `asr` 改写本次 `snapshot.formData.useEmbeddedSubtitles`，`cancel` 终止并回到 `idle`；`dialog` 同时渲染两个对话框。`renderer/pages/[locale]/tasks/[type].tsx` 的重试传 `promptEmbeddedSubtitles: false`；`renderer/components/TaskControls.tsx` 新增 `promptEmbeddedSubtitles`（默认 `true`）原样交给 `submit`，任务页在固定快照页（`configSnapshot`）上传 `false`
- [x] 2.4 `renderer/components/tasks/EmbeddedSubtitleControl.tsx`（新增）：由 `enabled` / `onEnabledChange` 受控的开关，与「开始前提示我选择」复选框（挂载时 `getSettings`，读不到按「提示」处理；改动乐观更新并 `setSettings`，失败回滚，较新的改动不被较早的失败覆盖；开关关闭或尚未读到设置时置灰）；`renderer/components/tasks/AdvancedSheet.tsx` 在「转写」分区顶部、`typeDef.needsModel && hasMediaInput` 时渲染它，并把 `onEnabledChange` 接到 `form.setValue('useEmbeddedSubtitles', …, { shouldDirty: true })`；`renderer/components/tasks/OutputFormatControl.tsx` 删除开关与已不使用的 `Switch` 导入、以及引用不存在的 `configBar.embeddedSubtitlesTip`
- [x] 2.5 `renderer/public/locales/{zh,en}/{home,tasks}.json`：对话框文案（`home:embeddedPrompt.*`，提示里的入口名与界面一致，写作「高级选项 › 转写」）与高级选项控件文案（`tasks:embeddedSubtitleSetting.*`）；`configBar.embeddedSubtitles` 保留（新控件与只读快照栏都在用），中文由「优先内封字幕」改为「优先使用内封字幕」

## 3. 测试

- [x] 3.1 `scripts/test-embedded-subtitle-scan.cjs`（新增，`test:embedded-subtitle-scan`，加入 `test:pro-baseline`）：调度——命中即停并中止其余、并发上限、容器过滤与去重、位图轨不算命中、预算到点返回 `unknown` 且中止在途探测、外部中止、探测抛错按无结果、全部检查完才是 `none`、空输入；真实 ffmpeg——生成带文本字幕轨 / 无字幕轨 / 仅图像轨的小文件，验证探测、中止与 `found | none`
- [x] 3.2 `scripts/test-task-submission-ui.tsx`：给 mock 补 `findEmbeddedSubtitles`（默认 `none`）；断言开始会探测且只探测媒体文件；慢探测会让开始停在 `confirming`，此时卸载页面、探测再返回也不会提交任务。（不弹窗各情形的零探测、出错 / `none` / `unknown` 仍照常提交，在下面 3.3 的 jest 测试里用真实对话框覆盖；react-test-renderer 渲染不出 Radix 的 portal）
- [x] 3.3 `renderer/hooks/__tests__/useTaskSubmissionEmbeddedPrompt.test.tsx`（新增，jest + 真实对话框）：命中后弹窗且内容含文件名与轨道（过长时概括、无语言时注明）；使用 / 改用只改本次载荷且不写任何设置、不改调用方的入参；取消 / Esc / 页面关闭都不提交；勾选「记住」只写 `useEmbeddedSubtitles` 默认值与 `embeddedSubtitlePrompt` 两项且顺序在提交之前；勾选后取消不写、下次对话框复选框重新不勾；默认值写入失败不写提示开关、任务仍提交；写入期间 Esc 不取消、连点只写一次；校验失败不弹窗；弹窗在云端上传确认之前，选了「使用内封字幕」仍要确认上传，在对话框里取消则不出现上传确认；探测与校验并行；不弹窗的各种情形零探测且仍照常提交；主进程不响应时不卡住开始；同一选择复用 `requestId`、不同选择换新的
- [x] 3.4 `renderer/components/__tests__/EmbeddedSubtitleControl.test.tsx`（新增）：开关由入参决定并只回调、不写设置；复选框反映已存的偏好、读到之前置灰、读设置失败按「提示」处理；改动写 `setSettings` 且只写自己的键；写入抛错 / 被拒回滚；较晚的失败不覆盖较新的改动；开关关闭时置灰且不写
- [x] 3.5 `renderer/components/__tests__/OutputFormatControl.test.tsx`：气泡里不再有内封字幕开关（并入已有的「打开气泡」用例：在 jsdom 里打开 Radix 气泡要几秒，不再多开一次）
- [x] 3.6 `renderer/lib/__tests__/EmbeddedSubtitleScan.test.ts`（新增）：哪些文件值得探测（字幕与已配对的不探、强制识别与翻译类不探、无路径条目忽略）、轨道命名（编码标签、按界面语言命名语言、认不出的代码原样显示、无语言）、文件名取法（两种平台分隔符）、向主进程询问（只发探测文件、各种「无结果」回答、提示关闭时只读设置、没有可探测文件时一个 IPC 都不发、预算外再多等不到 1.5 s）
- [x] 3.7 `renderer/components/__tests__/AdvancedSheetEmbeddedSubtitles.test.tsx`（新增，真实表单 + 真实 `AdvancedSheet`，Radix 的对话框与滚动区换成普通元素）：开关出现在「转写」标题之后、按任务值显示；切换写进表单并标记为脏（默认配置随之跟进）；翻译字幕类任务与向导里仅有字幕输入时没有开关
- [x] 3.8 `renderer/components/__tests__/TaskControlsDefaults.test.tsx`：开始默认允许询问；固定快照页传 `promptEmbeddedSubtitles: false` 时原样交给提交
- [x] 3.9 `scripts/e2e/embedded-subtitle-prompt.mjs`（新增，`test:e2e:embedded-subtitle-prompt`）：真实 Electron、真实主进程探测与真实流水线，云端转写用本机假服务，所以「有没有上传音频」可观察。覆盖：无内封字幕的视频不弹窗；有则弹窗、内容含文件名与轨道、取消不提交；「使用内封字幕」提交 `useEmbeddedSubtitles: true`、流水线抽出内封字幕且零上传；「改用语音识别」提交 `false`、走转写；这两种选择都不动默认配置；配置已固定的任务页再次开始时不探测、不询问；勾选「记住」写入默认配置并关闭提示，之后不再探测；高级选项里的开关反映默认值，重新勾上「开始前提示我选择」写回设置；全新安装一步：默认配置里 `useEmbeddedSubtitles` 为 `true`、`embeddedSubtitlePrompt` 未写入，高级选项里开关为开、「开始前提示我选择」勾选且可用，对话框里「记住我的选择，不再提示」第一次出现时未勾选，只是打开任务页与高级选项不写任何一项
- [x] 3.10 变异检查：对调度、探测入口、提交流程、对话框、高级选项控件与开始入口共 43 处做手工变异（不中止其余探测、不限并发、预算不生效、位图轨算命中、探测出错抛给调用方、不去重、不过滤容器；强制识别 / 翻译类 / 提示关闭 / 已配对字幕仍探测、不设响应超时、探测错误抛出、空轨道的命中被接受；校验前就弹窗、先上传确认后询问、取消也提交、回答不生效、重试也探测、校验后才探测、回答漏到调用方入参；未勾选也记住、不写默认值、不关提示、取消也记住、写入期间响应 Esc、连点写两次、默认值写失败仍关提示、勾选跨次保留、列出全部轨道、关页后开始悬挂；较早的失败覆盖较新的改动、失败不回滚、开关关闭时复选框仍可用、读不到设置当作不提示、被拒绝的写入当作成功；开关出现在仅字幕输入 / 不转写的任务；固定快照页的入参不转发、开始默认不询问、重试也询问、开始流程无视探测结果）外加一次整文件回退（开关回到「字幕格式」气泡），逐一确认有测试失败，并抽查失败的确是预期的断言。最初漏网两处并已补强：「较早的失败不覆盖较新的改动」原先只翻两次、回滚值恰好等于最新值，改为翻三次；开关的 `needsModel` 条件被外层 `isMediaTask` 遮住，补了一个不转写的媒体任务用例。页面里的 `promptEmbeddedSubtitles={!configSnapshot}` 没有单元测试，由端到端把关：去掉它重新构建后，端到端在固定快照一步失败

- [x] 3.11 `renderer/lib/__tests__/EmbeddedSubtitleDefaults.test.ts`（新增）：直接读真实的出厂默认（`defaultUserConfig` 与 `main/helpers/store` 构造 `electron-store` 时传入的 `defaults`，后者在测试里被替换成记录参数的桩），而不是在测试里重写一遍——新安装的 `useEmbeddedSubtitles` 为 `true`、出厂设置没有记住任何回答（`embeddedSubtitlePrompt` 不是 `false`），所以带内封字幕的视频第一次开始就会询问。变异检查：把出厂 `useEmbeddedSubtitles` 改成 `false`、把 `embeddedSubtitlePrompt: false` 写进出厂设置，各有两个用例失败

## 4. 验证

- [x] 4.1 `yarn typecheck`（renderer、main、automation、crash 四个 tsc 项目）、`yarn check:i18n` 通过；所有改动与新增文件 `prettier --check` 通过
- [x] 4.2 `yarn test:renderer`（jest `--runInBand`，与 CI 一致）、`yarn test:parameter-persistence` 通过
- [x] 4.3 `yarn test:pro-baseline`（含新增的 `test:embedded-subtitle-scan` 与 `test:task-submission`）、`yarn test:engines`、`yarn test:toolbox` 通过
- [x] 4.4 `yarn build`（renderer + main + CLI/MCP 入口）、`yarn check:jassub-guard`、`yarn test:automation` 通过（改动触及 `main/**` 与 `types/**`）
- [x] 4.5 Electron 端到端：`yarn test:e2e:embedded-subtitle-prompt`（对 `yarn build` 的产物运行，开发服务器同样可用），真实的带内封字幕的视频与真实流水线；各出口、记住后不再弹窗与探测、在高级选项里重新打开提示都通过；本机实测按下「开始」到对话框出现 55–81 ms（探测本身 14–18 ms，3 次）。对话框与高级选项的截图已查看，对话框里两个选项的说明改成一块两行的说明面板，避免看起来像两张可点击的卡片
- [x] 4.6 `openspec validate embedded-subtitle-start-prompt --strict` 通过
