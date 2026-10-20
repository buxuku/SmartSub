# Tasks: redesign-task-settings

## 1. 偏离判定（先单独修，随后各步都依赖它）

- [x] 1.1 `renderer/lib/scenarioPresets.ts`：新增 `getPresetDeviations(formData, presetId?)`（返回偏离的键）；中性值规则为 `undefined / null / 空串 / false`，另加 `0` 仅对 `maxSubtitleChars`、`speakerDiarizationCount`；`subtitleOutcome` 缺省时按 `inferDisplayOutcome` 推断；`detectCurrentPreset` 改为基于它（显式 `custom` 与未知预设仍返回 `custom`）
- [x] 1.2 同文件新增键 → 人话分组的映射与 `groupPresetDeviations`（断句长度、断句精调、AI 校正、语气词处理、角色分离、识别策略、VAD 与抗重复、解码参数、翻译风格、字幕排版），并导出哪些分组属于专家页，供脚注、摘要条与专家 tab 圆点使用
- [x] 1.3 `types/subtitleOutcome.ts`：新增 `supportsOutcomeStrategy(engine)`（`cloud` / `localCli` 为 `false`，其余为 `true`），与 `supportsTaskVadField` 对这两个引擎的做法一致
- [x] 1.4 `scripts/test-scenario-presets.ts`：出厂默认配置（含两个 `0`）→ `balanced` 且无偏离；`maxSubtitleChars` 为 `40` / `-1` → 偏离；`subtitleMaxGap: 0` 仍是偏离；老快照缺 `subtitleOutcome` → 不偏离；分组与专家归属；显式 `custom` 行为不变；`supportsOutcomeStrategy`
- [x] 1.5 提交 `fix(tasks)`：全新用户默认显示「专家自定义」的判定 bug

## 2. 场景控件

- [x] 2.1 `renderer/components/tasks/ScenarioPresetControl.tsx`：按钮显示基础场景名；有偏离时加小圆点与屏幕阅读器文本"已调整"；仅显式 `custom` 显示「自定义」（沿用原来的虚线弱化样式）
- [x] 2.2 弹层：5 个场景（去掉「专家自定义」行）；每行以 `presets.<id>.scene`（适合什么视频）作主说明，原 `desc`（技术说明与前置条件）作次行
- [x] 2.3 脚注：有偏离时列出被调整的分组并提示切换场景会重置它们，提供「恢复为『X』」（`applyScenarioPreset(form, 基础场景)`）；`custom` 时说明"当前不再对应任何场景"；常驻「更多设置」「专家设置」两个链接
- [x] 2.4 入口回调 `onOpenAdvanced` 改为 `onOpenSettings(tab?)`：`InlineConfigBar` 的 prop 与向导、任务页的调用点同步
- [x] 2.5 `renderer/components/__tests__/ScenarioPresetControl.test.tsx`（新增）：全新默认配置 → 「通用均衡」无圆点；改一项 → 场景名不变且有圆点；弹层只有 5 个场景；脚注列出分组、恢复生效；`custom` 的显示；「更多设置」「专家设置」调用的 tab 参数
- [x] 2.6 `renderer/public/locales/{zh,en}/tasks.json`：`presets.<id>.scene`、脚注与圆点文案；`presets.custom.name` 改为「自定义」
- [x] 2.7 提交 `feat(tasks)`：场景控件

## 3. 更多设置面板

- [x] 3.1 `git mv` `AdvancedSheet.tsx` → `TaskSettingsSheet.tsx`，组件与 props 类型改名；`renderer/components/tasks/settings/` 新增 `SettingsGroup`、`SettingRow`（左标签 + ⓘ、右控件；多行内容上下排）；ⓘ 提示抽成 `renderer/components/tasks/ConfigItemHint.tsx`，工具栏与面板共用（各用自己的 `testId`）
- [x] 3.2 外壳：标题「更多设置」与说明；媒体任务的摘要条（场景名、「已调整 N 项」、「恢复场景默认」）；`常用 | 专家` tab（专家 tab 仅媒体任务，有偏离时带圆点）；纯翻译任务单页无 tab；`tab` / `onTabChange` 受控：父组件持有 `settingsTab`，入口（场景脚注的「专家设置」、页头按钮）据此指定要打开的页，并在会话内记住用户翻到的页；不传则面板自管（取代原计划的 `initialTab`，一次关闭再打开不会丢掉用户翻到的页）
- [x] 3.3 常用页（`settings/CommonSettings.tsx`）：字幕来源、识别辅助、翻译与润色、输出与保存、运行五组，条件与规格一致；语气词处理仅在 `aiCorrection` 开启时出现；`translateRetryTimes` 放在「运行」；删除场景横幅与「字幕输出格式」；全局参考文稿由「标签 + 两行说明 + 通栏虚线按钮」改成一行（标签 + ⓘ + 选择按钮，说明收进提示，选定后换成文件卡片与「清除」），1024×700 下前两组才放得进首屏、第三组才能从首屏开始（实测见 7.3）
- [x] 3.4 专家页（`settings/ExpertSettings.tsx`）：识别策略（紧凑单选 + 当前档位一句话说明；样例对比与手动调节展开区原样搬入；`supportsOutcomeStrategy` 为 `false` 时只显示一行说明）、断句精调、解码参数（`FasterWhisperAdvancedFields` 原样搬入，默认折叠）
- [x] 3.5 `outcome.label` 改为「识别策略」，`outcome.custom.title` 改为「手动调节」，`outcome.custom.sectionTitle` 同步；`SavePathNotice` 的弹层宽度改为不超出窗口；删除 `SubtitleFormatSelect.tsx`
- [x] 3.6 `renderer/components/__tests__/AdvancedSheetEmbeddedSubtitles.test.tsx` 改名为 `TaskSettingsSheetEmbeddedSubtitles.test.tsx`，断言开关在「字幕来源」组
- [x] 3.7 `renderer/components/__tests__/TaskSettingsSheet.test.tsx`（新增，真实表单 + 真实面板）：tab 显隐（媒体任务有、纯翻译无）；没有「字幕输出格式」与场景横幅；常用页不含识别策略 / VAD / 断句精调；语气词处理与角色分离子项按需出现；`cloud` / `localCli` 不显示识别策略只有说明；专家 tab 圆点；切 tab 不丢值与脏标记；摘要条与「恢复场景默认」；受控 / 非受控的 tab
- [x] 3.8 提交 `feat(tasks)`：更多设置面板（含入口与文案，见第 4 组，两者同属一个可运行的状态）

## 4. 入口与文案

- [x] 4.1 `renderer/pages/[locale]/tasks/[type].tsx`：页头按钮改「更多设置」（有参考文稿时仍带提示点），`settingsTab` 状态，`onOpenSettings` 接到工具栏与面板；`renderer/components/tasks/wizard/TaskWizard.tsx`：配置面板 `PanelHeader` 新增同名 `actions` 按钮，同样的状态与接线
- [x] 4.2 `renderer/public/locales/{zh,en}/tasks.json`：`advanced` / `advancedDesc` → `settings.*`（标题、说明、tab 名、分组名、摘要条、引擎说明）；删除 `advancedSettings` 与 `presets.customHint`；就绪提示（`translation_style_requires_ai`、`speaker_diarization_unavailable`）改指「更多设置 › 常用」；空状态引导 `empty.step2Desc` 的「高级参数在右上角」改为「更多设置在右上角」
- [x] 4.3 `renderer/public/locales/{zh,en}/home.json`：内封字幕提示改指「更多设置 › 常用」；`renderer/public/locales/{zh,en}/settings.json`：对「字幕效果」档位的引用改为「识别策略」；`renderer/components/tasks/AiRefineControl.tsx` 头注释同步
- [x] 4.4 `npm run check:i18n` 通过（zh / en 键一致、无 `t() || '…'` 回退）

## 5. 工具栏

- [x] 5.1 `renderer/components/tasks/InlineConfigBar.tsx`：按 听（语音模型、视频语言、场景、断句与精修）｜ 译（翻译成、翻译服务、词库、生成摘要）｜ 出（输出）重排；组间 1px 分隔线实现为阶段首项上的左边框（`border-l pl-2.5`），不增加元素；只画在前面确实还有另一个阶段的地方——纯翻译任务没有「听」，源语言与翻译成之间不画线
- [x] 5.2 输出控件的标签改用新增的 `configBar.output`（zh「输出」/ en），弹层内部小节标题保持 `configBar.format` / `configBar.style`
- [x] 5.3 工具栏零换行由 `scripts/e2e/task-project-persistence.mjs`（英文长标签下 1024 / 1440 核心控件同一行、都在窗口内且可点击）与 `scripts/e2e/wizard-recovery.mjs`（向导里每个控件都在 inspector 内且可点击）把关；不通过则去掉分隔线只保留顺序，并在本文件与设计里记录。结果：两个 e2e 在 1024 / 1440 下都通过，分隔线保留（`wizard-recovery` 在 6.1 修正「专家参数」选择器之前，用只改了这一个选择器的临时副本跑过）；`scripts/test-subtitle-output-ui.cjs` 新增三种任务类型的标签顺序、分隔线位置与「输出」标签断言
- [x] 5.4 提交 `feat(tasks)`：工具栏按听 / 译 / 出排序

## 6. e2e 与文档

- [x] 6.1 e2e 选择器：`task-defaults`（「高级选项」→「更多设置」，两处）、`embedded-subtitle-prompt`（按钮名与提示路径文案）、`scenario-presets`（场景标签、「专家自定义」→ 弹层脚注「专家设置」，VAD 滑块在专家页「手动调节」下；新增"全新状态显示通用均衡且无圆点"）、`scenario-language`、`speaker-pipeline`、`wizard-recovery`（点早已不存在的「专家参数」→「更多设置」）、`task-project-persistence`；不动 `dubbing-*`。结果：七个脚本都已更新；`scenario-presets` 与 `task-project-persistence` 还顺带锁定了 7.3 的验收项（见 7.3）。`wizard-recovery` 点的「专家参数」早在本次之前就不存在了（5.3 里记过），这里一并改正
- [x] 6.2 文档站：`docs/docs/features/subtitle-generation.md`（「效果档位」一节改写为「场景与更多设置」，去掉不存在的档位名，补场景预设）、`docs/docs/faq.md`、`docs/docs/scenarios/podcast-to-text.md`、`docs/docs/guides/engines/whisper-cpp.md`、`docs/docs/features/subtitle-translation.md`（断句与输出格式指向工具栏）。结果：除计划里的五页，`docs/docs/advanced/recipes.md` 里还有一处「高级设置」，一并改成「更多设置」，共六页。`docs/docs/changelog.md` 是历史记录，不改；其余页面里的「高级选项 / 高级设置」说的是翻译服务商面板自己的分组，与本次无关。`docusaurus build` 通过（`onBrokenLinks` 为 `throw`，链接都在）
- [x] 6.3 提交 `test(e2e)` 与 `docs`；回填本文件的结果与决定。结果：`test(e2e)`、`docs(site)` 与本次回填的 `docs(openspec)` 三个提交；回填同时在 `design.md` 里补了决策 13、14、第 6 条的实测，以及「待办」
- [x] 6.4 e2e 实跑时发现的两个面板缺陷，各自单独 `fix(tasks)`，排在 6.3 的提交之前：① 两页共用一个滚动视口，在专家页滚动后切回常用，视口停在旧的偏移上，常用页的第一组被卷到上方 → `ScrollArea` 以当前 tab 为 `key`，切页即回到顶部；② 无 tab 的单页上，Radix 打开面板时聚焦第一个可 Tab 的元素，那是标签旁的 ⓘ，聚焦 ⓘ 会弹出它的提示，压在首行上，并吞掉第一次 Esc（`speaker-pipeline` 里切完开关马上 Esc，面板没关、「开始」仍是灰的）→ `onOpenAutoFocus` 把焦点停在面板自身；面板不是控件，另加 `focus:outline-none`（键盘打开时 Chrome 会给整块面板画一圈外框，Electron 里实测为 `outline-style: auto`，加上后是透明）。新增 `TaskSettingsSheetFocus.test.tsx`（真实的 Radix 对话框 + 聚焦即打开的 Tooltip 替身，修复前红、修复后绿）；外框与切页回顶由 `scenario-presets` 把关，并做过反向验证：去掉 `focus:outline-none` 或 `key={activeTab}` 后，该 e2e 分别在「键盘打开：面板不画外框」与「1024：常用从第一组开始」这两步失败，恢复后通过

## 7. 验证

- [x] 7.1 `npm run typecheck`、`npm run check:i18n`、`npm run test:renderer`、`npm run test:scenario-presets`、`npm run test:subtitle-output`、`npm run test:task-draft`、`npm run test:task-readiness`。结果：全部通过——`typecheck`；`check:i18n`（zh / en 键一致、无回退写法）；`test:renderer`（94 个套件 / 1042 个用例）；`test:scenario-presets`；`test:subtitle-output`（输出里的 `style jsx` 警告来自提交 3ce55ddb 起就有的 `InlineConfigBar` 写法，与本次无关）；`test:task-draft`（输出里的堆栈是它有意模拟的失败）；`test:task-readiness`
- [x] 7.2 本机 build 后运行相关 e2e：`test:e2e:task-defaults`、`test:e2e:embedded-subtitle-prompt`、`test:e2e:presets`、`test:e2e:scenario-language`、`test:e2e:wizard`、`test:e2e:task-project`（以及 `speaker-pipeline.mjs` 对应的脚本）。结果：没有先 `yarn build`——本次主进程只改了一行注释，e2e 对着开发服务器（8888，直接服务工作树）运行。脚本里写死的媒体目录是作者机器上的路径，本机没有，所以用只把该目录换成 `/tmp/smartsub-media/`（生成的小媒体）的临时副本运行，脚本本身没改：`test:e2e:task-defaults`、`test:e2e:embedded-subtitle-prompt`、`test:e2e:presets`、`test:e2e:scenario-language`、`test:e2e:wizard`、`test:e2e:task-project` 全部通过；另跑 `test:e2e:task-list-layout`（53/53 项），确认工具栏重排没有动列表布局。`test:e2e:speakers` 的后半段需要真实的角色分离模型，本机没有，只验证到「缺模型」一步（就绪提示的新路径、「开始」置灰、在「更多设置」里关掉角色分离后「开始」可用、再打开又置灰、截图）；之后的聚类与下游门禁部分没有在本机跑过
- [x] 7.3 验收：全新安装场景按钮显示「通用均衡」且无圆点；1024×700 窗口下常用页首屏能看到前三组；纯翻译任务的设置页不再出现任何转写项；专家项与常用项不再混排。结果：① 全新安装：`scenario-presets` 断言场景按钮的可访问名是「通用均衡」、没有「已调整」圆点、弹层只有 5 个场景且没有「专家自定义」，`ScenarioPresetsDefaults.test.ts` 与 `scripts/test-scenario-presets.ts` 用出厂默认配置锁定同一件事。② 首屏：1024×700 下前两组整组在首屏，第三组的标题与首行也在、其余一次短滚动可达（实测「输出与保存」约 58% 可见，英文的「翻译与润色」约 71%），所以断言是前两组整组 + 第三组至少一半（`scenario-presets` 的中文生成任务、`task-project-persistence` 的英文生成并翻译任务），没有为了塞进第三组去缩小字号或内边距。③ 纯翻译任务：`TaskSettingsSheet.test.tsx`「a task that only translates is one page: no tabs, no scenario, nothing to transcribe」。④ 专家项不再混排：同一文件的「the common page is the five groups in the order a task runs, with no expert setting in it」与「groups the recognition strategy, the segmentation tuning and, for faster-whisper only, the decoding」

## 8. 评审后续

- [x] 8.1 评审（Bugbot，对 `main` 的分支改动）报了三条，都在 `main` 与 v3.10.1 里就有，不是本分支引入的。逐条实测后：① 向导里「仅生成字幕」任务的源字幕保存方式（两条，同一根因）——真实，中等，已修（8.2）；修它时查到下载流水线有同样的问题，一并修了（8.3）；② 从「手动调节」切回内置识别策略后任务级 VAD 残留——真实，影响小，起初没修、记入 `design.md` 的待办，随后按要求修了（8.4）
- [x] 8.2 `fix(tasks)`：任务页一直把「仅生成字幕」任务的 `noSave` 读成 `fileName`（出厂默认是 `noSave`），向导没有——面板显示「文件名」，提交的却是 `noSave`，字幕落成 `<视频名>_temp.srt`。实测：向导里不改任何设置走「视频 → 原文字幕」，完成后视频旁边只有 `pauses_temp.srt`，五秒后仍在（显式设成 `fileName` 的对照组是 `pauses.srt`）。规则收成 `correctedSourceSrtSaveOption`（最初放在 `renderer/lib/taskTypes.ts`，8.3 搬到 `types/sourceSrtSave.ts`），任务页（改表单）、设置面板（改显示）、向导（改提交的配置）共用，见 `design.md` 决策 15。测试：`SourceSrtSave.test.ts`（规则的真值表，原名 `TaskTypes.test.ts`）；`scenario-presets` e2e 不再显式设 `fileName`，断言 `pauses.srt`、没有 `pauses_temp.srt`、快照里是 `fileName`，并做过反向验证（去掉向导里那一行，该 e2e 以 `pauses_temp.srt` 失败，恢复后通过）。同时通过：`typecheck`、`check:i18n`、`test:renderer`（95 个套件 / 1053 个用例）、`test:task-submission`、`test:task-draft`、`test:task-readiness`、`test:scenario-presets`、`test:subtitle-output`、`test:task-defaults`，以及 `wizard-recovery`、`task-defaults`、`task-project-persistence`、`embedded-subtitle-prompt` 四个 e2e
- [x] 8.3 `fix(download)`：下载流水线（下载完成后自动听写）创建「仅生成字幕」任务时有同样的问题：配置来自 `defaultUserConfig` + 用户配置 + 配方，出厂的 `noSave` 没人改，字幕同样落成 `<视频名>_temp.srt`。`correctedSourceSrtSaveOption` 搬到 `types/sourceSrtSave.ts`（渲染进程与主进程共用，无运行时依赖），`buildSubmission` 在每个条目创建任务时按它修正，而不是批次创建时——批次里已存下的 `noSave` 快照一并修正，用户确认的配置指纹不变，见 `design.md` 决策 15。测试：`scripts/test-download-pipeline.cjs` 新增一条（共 21 个场景，走真实的 `persistTaskSubmission`，读的是批次实际创建的子任务快照）：出厂默认、`noSave`、空值、缺省都得 `fileName`，显式选择（`fileName` / `fileNameWithLang` / `custom`）原样保留，带翻译的配方仍是 `noSave`；先写红（`noSave` 原样提交）再实现，并做过反向验证。真 Electron e2e：`download-pipeline` 的「只听写」配方不再显式设 `fileName`，断言快照里是 `fileName`、视频旁边是 `<视频名>.srt` 且没有 `_temp.srt`；去掉修正后该 e2e 在这条断言上失败（实际值 `noSave`），恢复后完整通过（7 项）。该 e2e 用官方 yt-dlp 2026.08.19（已按 `SHA2-256SUMS` 校验）与本地假 ASR；脚本里读的 `profile/config.json` 只在 `--production` 下成立，开发模式的用户目录带 `-dev` 后缀，而生产模式需要先 `yarn build`，所以本机用只换这一处路径的临时副本在开发模式跑，脚本本身没改
- [x] 8.4 `fix(tasks)`：从「手动调节」改选内置识别策略时，丢掉它写进任务的值。`convertToCustomOutcome` 进入「手动调节」时写入的 `maxContext`、`useVAD`、`reduceRepetition` 与六个任务级 VAD 字段，此前在改选内置档位后原样留在表单里，仍盖过档位自己的 VAD（`withTaskVad`），还被记成该任务页的默认值。实测：whisper 系拖过滑块后切回「文字最准」是 0.2 / 600（该档位本是 0.35 / 100）；sherpa 系点开过一次「手动调节」、什么都没动，再改选「最干净最稳」仍是均衡的 0.5 / 250 / 100（本是 0.65 / 400 / 150）。新增 `leaveCustomOutcome`，与 `convertToCustomOutcome` 共用 `CUSTOM_OUTCOME_KNOB_KEYS`，`ExpertSettings` 只在当前显示「手动调节」时调用；档位之间切换、场景写进来的 VAD 值、`scenarioPreset` 都不动，见 `design.md` 决策 16。测试：`scripts/test-scenario-presets.ts`（6 个引擎 × 起点档位 × 目标档位，离开后的生效设置与直接选该档的新任务逐字段相同，旋钮为空，其它字段不变）；`TaskSettingsSheet.test.tsx` 新增四条（funasr 打开不动、fasterWhisper 拖滑块、只靠旋钮反推出「手动调节」的老快照、档位之间切换不动场景值），先写红再实现，反向验证（关掉清理后前三条失败、第四条仍通过）；`scenario-presets` e2e 新增一步（改选「最干净最稳」后草稿里 `subtitleOutcome` 为 `clean`，VAD、上下文、减少重复都为空，滑块消失），旧行为下以残留的 0.36 失败，修后通过
- [x] 8.5 验收（8.3、8.4 完成后的整棵树）：`typecheck`、`check:i18n`、`test:scenario-presets`、`test:task-submission`、`test:task-draft`、`test:task-readiness`、`test:task-defaults`、`test:subtitle-output`、`test:download-pipeline`、`test:video-download` 全部通过；`test:renderer` 95 个套件 / 1057 个用例（比 8.2 时多 4 个）；e2e 在最终代码上重跑：`download-pipeline`（7 项）、`scenario-presets`、`task-defaults`、`wizard-recovery`
- [x] 8.6 提交 `fix(download)`、`fix(tasks)` 与本次回填的 `docs(openspec)`
