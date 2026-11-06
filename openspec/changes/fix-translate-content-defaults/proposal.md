## Why

用户反馈：3.9.0 起，选择「仅输出翻译结果」时，原文与译文仍被合并进同一个字幕文件，交付物还是「上原文下译文」。

根因是三层问题叠在一起，让「仅译文」几乎选不住：

1. **出厂默认被改了。** 3.9.0（`628d1cba`）把 `translateContent` 的出厂默认从 `onlyTranslate`（3.8.0 及之前）改成 `sourceAndTranslate`。
2. **新建任务会盖掉用户保存的偏好。** `newTaskDefaults` 对「生成并翻译」任务无条件改成双语；内置配方「视频 → 双语字幕」也把 `translateContent` 钉成 `sourceAndTranslate`。任务页打开时的值因此与用户上次保存的值不一致，这既违反 `task-recipes` 的「内置配方功能与旧卡片完全一致」，也违反向导的「配置默认值取用户上次使用值」。
3. **主进程没有任何兜底，出错还不可见。** `translateContent` 缺失或无法识别时，`CONTENT_TEMPLATES[undefined]` 抛出的 TypeError 发生在 `results.forEach(async …)` 里，被吞成未处理的 rejection：任务「成功」，交付字幕却是空文件。目标路径与源字幕相同时（如对 `clip.srt` 仅翻译并把目标命名选为「文件名」），目标会先被清空再写入，用户的源字幕被抹掉。

## What Changes

- 出厂默认回到 `onlyTranslate`。默认值与归一化函数放进无依赖的 `types/translateContent.ts`，主进程、渲染进程、自动化共用；配置栏对缺失的值也按默认显示。
- 新建任务不再改写已保存的偏好：`newTaskDefaults` 变为 `{ ...preferences, taskType }`；内置配方 `builtin-generate-translate` 不再携带 `translateContent`。用户自己保存的配方里的显式配置照旧生效。
- **不迁移**已保存的值：3.9.x/3.10.x 写入的 `sourceAndTranslate`（包括被强制改成的那份）一律视为用户偏好，改一次就会被记住（已知限制，见 design）。
- 主进程让输出内容「总是有效」：`persistTaskSubmission`（界面、自动化、下载流水线共用的提交入口）补全缺失或无法识别的值；`translate()` 再兜底一次并对非空的未知值写警告；`results.forEach(async …)` 改成 `for…of`，渲染/后处理的错误沿调用链抛给任务而不是留下空文件。
- 写入前守卫：目标字幕就是正在翻译的源字幕（同路径、符号链接、硬链接、大小写不敏感文件系统上的同名）时，在清空和写入之前拒绝并给出明确错误。
- 下载流水线与自动化在生成任务配置时同样补全输出内容。
- 新建任务向导的「成品视频设置」面板在开启翻译且成片带字幕时，说明成片字幕内容跟随「输出内容」设置并写明当前样式。
- 回归测试：`test:translate-content`（真实 `translate()`）并入 CI 的 `test:pro-baseline`；扩展提交、下载流水线、自动化回归的断言；补 jest 测试。
- 不做：迁移已保存的值；版本号与 `Changelog/`（发版时写）；卡片标题「视频 → 双语字幕」（3.0 起就有，早于本问题）；`translateProvider`、模型、语言等其它默认值。

## Capabilities

### New Capabilities

- `translation-output-style`: 「输出内容」的出厂默认与偏好优先、提交时补全、按样式交付且失败可见、目标字幕不得覆盖源字幕、界面对缺失值按默认显示。

### Modified Capabilities

- `task-recipes`: 「内置配方清单」要求补充——内置配方是任务页的无损别名，不得钉死用户可保存的任务配置（如输出内容）。
- `pipeline-task-wizard`: 「阶段芯片就地配置与就绪校验」要求补充——合成设置区说明成片字幕内容跟随「输出内容」设置。

## Impact

- 共用模块：`types/translateContent.ts`（新增）、`types/types.ts`、`types/subtitleOutput.ts`、`types/taskConfig.ts`。
- 主进程：`main/helpers/utils.ts`（出厂默认）、`main/helpers/taskSubmission.ts`、`main/translate/index.ts`、`main/helpers/subtitleOutputGuard.ts`（新增）、`main/helpers/videoDownload/pipeline.ts`、`main/automation/pipelineConfig.ts`。
- 渲染进程：`renderer/lib/recipes.ts`、`renderer/lib/translateContentLabel.ts`（新增）、`renderer/components/tasks/OutputFormatControl.tsx`、`renderer/components/tasks/wizard/ComposeContentHint.tsx`（新增）、`TaskWizard.tsx`、`locales/{zh,en}/tasks.json`（新增 `wizard.composeContentHint`）。
- 对外行为：全新安装与从未保存过偏好的用户，任务页、启动台、向导的输出内容都是「仅译文」；已保存的值被尊重；缺失或无法识别的值不再产生空文件；目标与源字幕同一文件时任务明确失败而不是抹掉源字幕。
- 无新依赖、无数据迁移、无 IPC 或存储结构变化；仅生成字幕（`generateOnly`）任务的快照逐项不变。
- 已知限制：3.9.x/3.10.x 期间已保存 `sourceAndTranslate` 的用户继续得到双语，直到自己改一次；这类值与「用户亲手选的双语」无法区分（`electron-store` 在首次启动时就把默认值写入存储）。
