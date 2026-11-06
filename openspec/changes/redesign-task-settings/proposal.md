## Why

任务配置对普通用户的理解成本很高，问题出在结构，而不是某一个控件：

- **两个"一键预设"并存。** 场景预设（`SCENARIO_PRESETS`）与「字幕效果」三档（`subtitleOutcome`）都在批量改同一批识别参数，用户面前同时有两个意图入口，分不清该选哪个、两者如何叠加。
- **「高级选项」是一列约 30 项的长表单。** 专家项（4 张字幕效果卡、上下文 / VAD / 抗重复、断句精调、解码参数）与常用项（参考文稿、角色分离、输出命名）混排；真正高频的反而在中后段，并发数垫底。
- **设置项重复。** 工具栏的「字幕格式」气泡已管格式与输出内容，侧栏里又放了一份「字幕输出格式」；侧栏顶部还重复了一条场景横幅。
- **没有"专家"概念，入口也不清。** 同一个面板在界面里叫「高级选项」、在提示与旧文案里叫「专家参数」、在文档里叫「高级设置」；新建任务向导里没有任何显式入口，只能经场景弹层里的「专家自定义」一行间接打开。
- **设了也无效的项照常显示。** 云端听写与本地命令行引擎不读取字幕效果档位，界面仍把它摆在最前面。

还有一个把这些问题放大的判定 bug：默认配置里 `maxSubtitleChars: 0`、`speakerDiarizationCount: 0`，而 `detectCurrentPreset` 把"不是 undefined / null / 空串 / false"的值都算作偏离，`0` 也被算上——全新用户一打开，场景按钮就写着「专家自定义」，"上次使用"记住的断句字数也会让下一个新任务从「专家自定义」开始。已用真实函数验证：默认值得到 `custom`，去掉这两个 `0` 就是 `balanced`。

## What Changes

- **场景是普通用户唯一的意图入口。** 场景按钮显示用户选的场景名；改过细项后在名字旁出现「已调整」小圆点，而不是切成「专家自定义」。场景弹层去掉「专家自定义」一行，每个场景用「适合什么视频」作主说明，技术说明与前置条件作次行；脚注列出被调整的项、提供「恢复为『X』」，并常驻「更多设置」「专家设置」两个入口。只有显式的 `scenarioPreset === 'custom'`（选了「手动调节」之后）才显示「自定义」。
- **「高级选项」改为「更多设置」，分「常用」「专家」两页。**
  - 常用：字幕来源（优先使用内封字幕）、识别辅助（参考文稿、提示词、角色分离）、翻译与润色（翻译风格；语气词处理仅在 AI 文本校正开启时出现）、输出与保存（源字幕保存、译文命名、字幕排版、去中文标点、保存提取的音频）、运行（最大并发任务数、翻译重试次数）。
  - 专家（只有媒体任务才有）：识别策略（原「字幕效果」，降级到这里）、断句精调、解码参数（faster-whisper 专用）。专家页里有被调整的项时，tab 上显示小圆点。
  - 纯翻译任务是单页，没有 tab。
  - 删除重复项：场景横幅与「字幕输出格式」；4 张大卡改为紧凑单选 + 当前档位的一句话说明；依赖项按需出现；云端听写与本地命令行引擎不显示识别策略，只留一行说明。
  - 顶部摘要条（仅媒体任务）：场景名 +「已调整 N 项」+「恢复场景默认」。
- **修正偏离判定。** 新增 `getPresetDeviations(formData)`，`detectCurrentPreset` 改为基于它；中性值规则为 `undefined / null / 空串 / false`，另加 `0` 仅对 `maxSubtitleChars`、`speakerDiarizationCount`（`0` = 智能 / 自动）；老快照缺 `subtitleOutcome` 时按 `inferDisplayOutcome` 推断，不算偏离；偏离的键按「人话分组」（断句长度、AI 校正、VAD 与抗重复、解码参数……）用于脚注与 tab 圆点。
- **工具栏按「听 → 译 → 出」重排。** 语音模型 → 视频语言 → 场景 → 断句与精修 ｜ 翻译成 → 翻译服务 → 词库 → 生成摘要 ｜ 输出；组间用 1px 分隔线（若 1024px 零换行测试不过，则只调顺序不加线）。「字幕格式」标签改为「输出」（该控件实际含格式与输出内容）。不新增、不合并控件。
- **入口统一。** 任务页头按钮与新建任务向导的配置面板头（新增）都叫「更多设置」；场景弹层脚注直达「更多设置」与「专家设置」（后者直接打开专家页）。入口回调由 `onOpenAdvanced` 改为 `onOpenSettings(tab?)`。
- **命名与引用修正。** 「字幕效果」→「识别策略」，档位里的「自定义」→「手动调节」，场景的「专家自定义」→「自定义」；就绪提示、内封字幕对话框与首页提示里的入口路径改指「更多设置 › 常用」；设置页里对「字幕效果」档位的引用同步更名；文档站里已经过时的描述（不存在的「快速草稿 / 均衡 / 精细」档位名、断句与输出格式仍指向高级设置）一并改写。
- **组件整理。** `AdvancedSheet.tsx` 改名 `TaskSettingsSheet.tsx`，按外壳 / 常用 / 专家拆分，共用 `SettingsGroup`、`SettingRow` 行式布局原语；删除不再使用的 `SubtitleFormatSelect.tsx`；`SavePathNotice` 的 600px 弹层改为不超出窗口的宽度。
- **向导与下载流水线创建「仅生成字幕」任务时，「不保存源字幕」按「文件名」处理。**（评审后补充）任务页一直这样做，这两个入口没有：向导里面板显示「文件名」，提交的却是出厂的 `noSave`；下载流水线直接用 `noSave`。结果都是字幕落成 `<视频名>_temp.srt`。规则收成 `types/sourceSrtSave.ts` 的 `correctedSourceSrtSaveOption`（渲染进程与主进程共用），任务页、设置面板、向导、下载流水线共用；向导与下载流水线只改提交的配置，不改表单（见 `design.md` 决策 15）。
- **从「手动调节」改选内置识别策略时，手动调节写进任务的值一并丢掉。**（评审后补充）此前这些值（VAD 灵敏度等）留在表单里，仍盖过所选档位自己的 VAD，档位名与实际参数对不上，还会被记成该任务页的默认值。新增 `leaveCustomOutcome`，与 `convertToCustomOutcome` 共用同一张旋钮表（见 `design.md` 决策 16）。
- 不做：合并「词库 + 生成摘要」、并发数挪到列表底部、语气词策略挪进「断句与精修」弹层（第二期）；任何任务字段、预设取值、`convertToCustomOutcome` 的行为与引擎逻辑的改动；版本号与 `Changelog/`（发版时写）。

## Capabilities

### New Capabilities

- `task-settings`: 任务配置的信息架构——工具栏 / 更多设置·常用 / 更多设置·专家三层与"一个设置项只在一处"的约束；场景作为唯一意图入口与「已调整」语义（含偏离判定的中性值规则）；更多设置的入口、分组与按需显示规则；专家页的引擎感知；工具栏的顺序与命名。

### Modified Capabilities

- `transcription-outcome-presets`: 「字幕效果意图档位」不再直接提供给普通用户，而是以「识别策略」为名放在「更多设置 › 专家」，普通用户经由场景间接获得合适的档位；第四档由「自定义」改称「手动调节」。「高级用户保留底层参数并安全迁移」中对应的折叠区同步改名，能力与迁移规则不变。

## Impact

- 渲染进程：
  - 逻辑：`renderer/lib/scenarioPresets.ts`（`getPresetDeviations`、偏离分组、`detectCurrentPreset` 改为基于它）、`types/scenarioPresets.ts`、`types/subtitleOutcome.ts`（引擎是否使用识别策略的判断）、`leaveCustomOutcome`（同在 `scenarioPresets.ts`）。
  - 组件：`renderer/components/tasks/AdvancedSheet.tsx` → `TaskSettingsSheet.tsx`（外壳）与新增 `renderer/components/tasks/settings/`（`SettingsGroup`、`SettingRow`、常用、专家）；`ScenarioPresetControl.tsx`、`InlineConfigBar.tsx`、`AiRefineControl.tsx`（注释）、`renderer/components/SavePathNotice.tsx`；删除 `SubtitleFormatSelect.tsx`。
  - 页面：`renderer/pages/[locale]/tasks/[type].tsx`（页头按钮、`settingsTab` 状态）、`renderer/components/tasks/wizard/TaskWizard.tsx`（配置面板头新增按钮）。
  - 文案：`renderer/public/locales/{zh,en}/{tasks,home,settings}.json`。
- 共享类型与主进程（评审后）：新增 `types/sourceSrtSave.ts`（`correctedSourceSrtSaveOption`，无运行时依赖）；`main/helpers/videoDownload/pipeline.ts` 的 `buildSubmission` 按同一规则修正，其余主进程代码不动。
- 文档与规格：`docs/docs/features/subtitle-generation.md`、`docs/docs/faq.md`、`docs/docs/scenarios/podcast-to-text.md`、`docs/docs/guides/engines/whisper-cpp.md`、`docs/docs/features/subtitle-translation.md`；本变更的 `task-settings` 规格与对 `transcription-outcome-presets` 的修改。
- 测试与脚本：`scripts/test-scenario-presets.ts`；`renderer/components/__tests__/AdvancedSheetEmbeddedSubtitles.test.tsx`（改名）、新增 `TaskSettingsSheet.test.tsx` 与 `ScenarioPresetControl.test.tsx`；e2e 选择器：`task-defaults`、`embedded-subtitle-prompt`、`scenario-presets`、`scenario-language`、`speaker-pipeline`、`wizard-recovery`、`task-project-persistence`（不动 `dubbing-*`：它们点的「高级选项」是配音面板自己的分组）。
- 对外行为：全新用户的场景按钮显示「通用均衡」且无圆点；面板与入口改名；专家项集中到「专家」页；新建任务向导第一次有了显式入口；工具栏顺序与一个标签改变；向导与下载流水线里只生成字幕的任务，字幕按视频名保存（`<视频名>.srt`），不再是 `<视频名>_temp.srt`；从「手动调节」改选内置识别策略后，任务按所选档位运行，不再带着手动调节留下的 VAD 值。任务字段、快照、配方、草稿与自动化的 schema 不变；`scenarioPreset` 只在渲染进程使用（`main/`、`types/` 里没有引用），无数据迁移。
- 已知限制：
  - `convertToCustomOutcome` 的行为保持原样：选「手动调节」会把场景置为「自定义」，不再对应任何场景；再选一个场景才会重置。从「手动调节」改选内置识别策略后，手动调节写进任务的值会被丢掉（决策 16），但场景按钮仍显示「自定义」（见 `design.md` 待办）。
  - 工具栏 1024px 最小宽度下已很紧，分隔线是否保留取决于零换行测试；不通过时只保留顺序调整。
  - e2e 脚本依赖本机素材路径与已构建的应用，需在本机运行。
