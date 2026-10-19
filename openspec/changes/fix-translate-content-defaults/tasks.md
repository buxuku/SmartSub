# Tasks: fix-translate-content-defaults

## 1. 出厂默认与共用模块

- [x] 1.1 新增 `types/translateContent.ts`（无依赖）：`TRANSLATE_CONTENT_VALUES`、`TranslateContent`、`DEFAULT_TRANSLATE_CONTENT = 'onlyTranslate'`、`isTranslateContent`、`normalizeTranslateContent`、`withValidTranslateContent`（补全缺失或无效的值；值有效时返回同一个对象；`generateOnly` 不动）
- [x] 1.2 `defaultUserConfig.translateContent` 取 `DEFAULT_TRANSLATE_CONTENT`；`types/types.ts` 改用 `TranslateContent` 类型；`types/subtitleOutput.ts` 的默认参数用该常量
- [x] 1.3 新增 `renderer/lib/translateContentLabel.ts`（`translateContentLabelKey`）；`OutputFormatControl` 的摘要、下拉选中值与排版示例都取归一化后的值
- [x] 1.4 `scripts/e2e/ux-phase-one.mjs` 的出厂默认断言改为 `onlyTranslate`

## 2. 新建任务沿用已保存的偏好

- [x] 2.1 `newTaskDefaults(preferences, taskType)` 返回 `{ ...preferences, taskType }`，已保存的偏好对所有任务类型生效
- [x] 2.2 `builtin-generate-translate` 不再携带 `translateContent`；用户自存配方的显式配置、`launchpadDraft` 与向导的合并逻辑不变
- [x] 2.3 `ux-phase-one.mjs`：依赖旧默认的「真实双语 SRT」场景改成显式选择 `sourceAndTranslate`，默认值相关的标签与截图名改为「仅译文」

## 3. 主进程加固

- [x] 3.1 `persistTaskSubmission` 用 `withValidTranslateContent` 归一化配置快照（含已固定的旧快照）；指纹仍取自原始输入，调用方传入的对象不被修改；`generateOnly` 不写该字段
- [x] 3.2 `translate()`：缺失或未知值按默认交付，非空未知值写警告日志；`results.forEach(async …)` 改成 `for…of`，渲染或后处理的错误沿调用链抛给任务
- [x] 3.3 新增 `main/helpers/subtitleOutputGuard.ts`（`assertOutputDoesNotOverwriteInput`：解析后路径相同、符号链接、硬链接、大小写不敏感文件系统；`bigint` stat），在 `createOrClearFile` 之前调用
- [x] 3.4 下载流水线 `main/helpers/videoDownload/pipeline.ts` 用 `normalizeTranslateContent`；自动化 `resolvePipelineForm` 返回 `withValidTranslateContent(form)`

## 4. 向导提示

- [x] 4.1 新增 `ComposeContentHint` 组件，`TaskWizard` 合成设置区引用它；`locales/{zh,en}/tasks.json` 新增 `wizard.composeContentHint`

## 5. 测试

- [x] 5.1 `renderer/lib/__tests__/TranslateContent.test.ts`（jest）：读真实 `defaultUserConfig` 断言出厂默认、类型守卫、归一化、`withValidTranslateContent`（补全、返回同一对象、`generateOnly` 不动、不修改入参）、标签键
- [x] 5.2 `renderer/components/__tests__/OutputFormatControl.test.tsx`（jest）：值缺失时摘要与排版示例按仅译文显示，三种取值各自的摘要
- [x] 5.3 `renderer/lib/__tests__/TaskDefaults.test.ts`（jest，重写）：已保存的三种取值对各任务类型都生效；启动台拖放沿用已保存值；内置配方不改写；守卫——没有任何 `BUILTIN_RECIPES` 带 `translateContent`；用户自存配方的显式配置优先
- [x] 5.4 `scripts/test-translate-content.cjs`（`test:translate-content`，并入 CI 的 `test:pro-baseline`）：驱动真实 `translate()` 与 `resolvePipelineForm`，假翻译服务——三种样式含纯译文临时文件；缺失值静默回落；未知值回落并告警；渲染出错使翻译失败并通知；目标与源字幕同名、符号链接、硬链接、大小写不敏感同名都在任何翻译请求之前被拒绝且源字幕不变；自动化补全、保留、对只转写免补
- [x] 5.5 `scripts/test-task-submission.cjs`（缺失、未知、有效值的存储与执行；入参不被修改；`generateOnly` 无该字段；旧快照补全）、`scripts/test-download-pipeline.cjs`（快照里的样式总是有效，已保存的选择优先于出厂默认）、`scripts/test-automation-regressions.cjs`（补全与只转写免补；harness 白名单加入 `types/translateContent.ts`）
- [x] 5.6 `renderer/components/__tests__/ComposeContentHint.test.tsx`（jest）：三种样式的烧录与软字幕提示、未设置的值、翻译关闭与「不带字幕」两种不显示的情形，以及 zh/en 文案的占位符与样式名都存在
- [x] 5.7 先写测试并确认在修复前失败再实现；对关键断言做过变异或还原检查（还原旧出厂默认、去掉自动化的补全调用、让提示忽略翻译开关 / 样式 / 字幕方式，各自都会使至少一个测试失败）

## 6. 验证

- [x] 6.1 `yarn typecheck`、`yarn check:i18n` 通过
- [x] 6.2 `yarn test:renderer`（jest `--runInBand`，与 CI 一致）：84 个套件、844 条用例全部通过
- [x] 6.3 `yarn test:pro-baseline`：43 条命令全部通过（含新增的 `test:translate-content`，以及 `test:task-submission`、`test:task-defaults`、`test:download-pipeline`、`test:recipes`、`test:task-draft`、`test:launchpad-import`）
- [x] 6.4 CI 的其余相关步骤：`test:parameter-persistence`、`test:subtitle-output`（374 项）、`test:untranslated-flow`（34 项）、`test:translation-proxy`（15 项）、`test:translation-cancel`、`test:free-translators`、`test:provider-test-flow`、`test:provider-fallback`、`test:qwen-mt`、`test:translate-parser`、`test:structured-output`、`test:glossary`、`test:custom-parameters`、`test:dubbing`（318 项加会话流程）、`test:crash`、`yarn build`（renderer + main + CLI/MCP 入口）、`check:jassub-guard`、`test:automation`（回归、MCP 配置与集成，111 次操作）通过
- [x] 6.5 复现脚本（真实 `translate()`、`processFile` 与导出阶段，只替换转写与翻译网络调用）：三种样式各自按所选排版交付；输出内容缺失或未知时按仅译文交付（修复前是空的交付文件）；源与目标字幕同名时以「Translated subtitle would overwrite the source subtitle」失败，源字幕内容完好
- [x] 6.6 `openspec validate fix-translate-content-defaults --strict` 通过

> 注：Electron 端到端（`ux-phase-one`、`task-defaults`）本次未运行：它们要在 8888 端口起 `nextron` 开发服务器并弹出 Electron 窗口，生产构建的主进程包不能直接用。`ux-phase-one.mjs` 中的断言已按新默认更新，同一逻辑由 jest 与 `scripts/` 下的 Node 测试覆盖；发版前建议在真机上跑一次。
