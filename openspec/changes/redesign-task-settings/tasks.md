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

- [ ] 3.1 `git mv` `AdvancedSheet.tsx` → `TaskSettingsSheet.tsx`，组件与 props 类型改名；`renderer/components/tasks/settings/` 新增 `SettingsGroup`、`SettingRow`（左标签 + ⓘ、右控件；多行内容上下排）
- [ ] 3.2 外壳：标题「更多设置」与说明；媒体任务的摘要条（场景名、「已调整 N 项」、「恢复场景默认」）；`常用 | 专家` tab（专家 tab 仅媒体任务，有偏离时带圆点）；纯翻译任务单页无 tab；`tab` 状态可由外部指定（`initialTab`）并在会话内记住
- [ ] 3.3 常用页（`settings/CommonSettings.tsx`）：字幕来源、识别辅助、翻译与润色、输出与保存、运行五组，条件与规格一致；语气词处理仅在 `aiCorrection` 开启时出现；`translateRetryTimes` 放在「运行」；删除场景横幅与「字幕输出格式」
- [ ] 3.4 专家页（`settings/ExpertSettings.tsx`）：识别策略（紧凑单选 + 当前档位一句话说明；样例对比与手动调节展开区原样搬入；`supportsOutcomeStrategy` 为 `false` 时只显示一行说明）、断句精调、解码参数（`FasterWhisperAdvancedFields` 原样搬入，默认折叠）
- [ ] 3.5 `outcome.label` 改为「识别策略」，`outcome.custom.title` 改为「手动调节」，`outcome.custom.sectionTitle` 同步；`SavePathNotice` 的弹层宽度改为不超出窗口；删除 `SubtitleFormatSelect.tsx`
- [ ] 3.6 `renderer/components/__tests__/AdvancedSheetEmbeddedSubtitles.test.tsx` 改名为 `TaskSettingsSheetEmbeddedSubtitles.test.tsx`，断言开关在「字幕来源」组
- [ ] 3.7 `renderer/components/__tests__/TaskSettingsSheet.test.tsx`（新增，真实表单 + 真实面板）：tab 显隐（媒体任务有、纯翻译无）；没有「字幕输出格式」与场景横幅；常用页不含识别策略 / VAD / 断句精调；语气词处理与角色分离子项按需出现；`cloud` / `localCli` 不显示识别策略只有说明；专家 tab 圆点；切 tab 不丢值与脏标记；摘要条与「恢复场景默认」；`initialTab`
- [ ] 3.8 提交 `feat(tasks)`：更多设置面板（含入口与文案，见第 4 组，两者同属一个可运行的状态）

## 4. 入口与文案

- [ ] 4.1 `renderer/pages/[locale]/tasks/[type].tsx`：页头按钮改「更多设置」（有参考文稿时仍带提示点），`settingsTab` 状态，`onOpenSettings` 接到工具栏与面板；`renderer/components/tasks/wizard/TaskWizard.tsx`：配置面板 `PanelHeader` 新增同名 `actions` 按钮，同样的状态与接线
- [ ] 4.2 `renderer/public/locales/{zh,en}/tasks.json`：`advanced` / `advancedDesc` → `settings.*`（标题、说明、tab 名、分组名、摘要条、引擎说明）；删除 `advancedSettings` 与 `presets.customHint`；就绪提示（`translation_style_requires_ai`、`speaker_diarization_unavailable`）改指「更多设置 › 常用」
- [ ] 4.3 `renderer/public/locales/{zh,en}/home.json`：内封字幕提示改指「更多设置 › 常用」；`renderer/public/locales/{zh,en}/settings.json`：对「字幕效果」档位的引用改为「识别策略」；`renderer/components/tasks/AiRefineControl.tsx` 头注释同步
- [ ] 4.4 `npm run check:i18n` 通过（zh / en 键一致、无 `t() || '…'` 回退）

## 5. 工具栏

- [ ] 5.1 `renderer/components/tasks/InlineConfigBar.tsx`：按 听（语音模型、视频语言、场景、断句与精修）｜ 译（翻译成、翻译服务、词库、生成摘要）｜ 出（输出）重排；组间 1px 分隔线实现为现有项上的边框，不增加元素与宽度
- [ ] 5.2 输出控件的标签改用新增的 `configBar.output`（zh「输出」/ en），弹层内部小节标题保持 `configBar.format` / `configBar.style`
- [ ] 5.3 工具栏零换行由 `scripts/e2e/task-project-persistence.mjs`（英文长标签下 1024 / 1440 核心控件同一行、都在窗口内且可点击）与 `scripts/e2e/wizard-recovery.mjs`（向导里每个控件都在 inspector 内且可点击）把关；不通过则去掉分隔线只保留顺序，并在本文件与设计里记录
- [ ] 5.4 提交 `feat(tasks)`：工具栏按听 / 译 / 出排序

## 6. e2e 与文档

- [ ] 6.1 e2e 选择器：`task-defaults`（「高级选项」→「更多设置」，两处）、`embedded-subtitle-prompt`（按钮名与提示路径文案）、`scenario-presets`（场景标签、「专家自定义」→ 弹层脚注「专家设置」，VAD 滑块在专家页「手动调节」下；新增"全新状态显示通用均衡且无圆点"）、`scenario-language`、`speaker-pipeline`、`wizard-recovery`（点早已不存在的「专家参数」→「更多设置」）、`task-project-persistence`；不动 `dubbing-*`
- [ ] 6.2 文档站：`docs/docs/features/subtitle-generation.md`（「效果档位」一节改写为「场景与更多设置」，去掉不存在的档位名，补场景预设）、`docs/docs/faq.md`、`docs/docs/scenarios/podcast-to-text.md`、`docs/docs/guides/engines/whisper-cpp.md`、`docs/docs/features/subtitle-translation.md`（断句与输出格式指向工具栏）
- [ ] 6.3 提交 `test(e2e)` 与 `docs`；回填本文件的结果与决定

## 7. 验证

- [ ] 7.1 `npm run typecheck`、`npm run check:i18n`、`npm run test:renderer`、`npm run test:scenario-presets`、`npm run test:subtitle-output`、`npm run test:task-draft`、`npm run test:task-readiness`
- [ ] 7.2 本机 build 后运行相关 e2e：`test:e2e:task-defaults`、`test:e2e:embedded-subtitle-prompt`、`test:e2e:presets`、`test:e2e:scenario-language`、`test:e2e:wizard`、`test:e2e:task-project`（以及 `speaker-pipeline.mjs` 对应的脚本）
- [ ] 7.3 验收：全新安装场景按钮显示「通用均衡」且无圆点；1024×700 窗口下常用页首屏能看到前三组；纯翻译任务的设置页不再出现任何转写项；专家项与常用项不再混排
