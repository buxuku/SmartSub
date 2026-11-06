## Context

输出内容（`translateContent`）决定交付字幕的排版：`onlyTranslate`（仅译文）、`sourceAndTranslate`（原文在上、译文在下）、`translateAndSource`（译文在上、原文在下）。`translate()` 用 `CONTENT_TEMPLATES[translateContent]` 渲染交付文件，并且始终另写一份纯译文的临时文件（`tempTranslatedSrtFile`）供后续阶段使用，所以样式只影响交付字幕。

这个值的流向：出厂默认（`defaultUserConfig`）→ 已保存的 userConfig（上次使用值）→ 新任务的初值（任务页 `newTaskDefaults`、启动台拖放草稿、向导）→ 表单 → `submitTask` → `persistTaskSubmission`（写入配置快照）→ `translate()`。

3.9.0 在这条链上动了三处：出厂默认改成 `sourceAndTranslate`；`newTaskDefaults` 对「生成并翻译」无条件改成双语；内置配方 `builtin-generate-translate` 把 `translateContent` 钉成 `sourceAndTranslate`。同时主进程对缺失或未知的值没有兜底：模板查找得到 `undefined`，TypeError 被 `forEach(async …)` 吞掉，留下空的交付文件。

`electron-store` 在首次启动时就把 `defaults` 写入存储文件。所以升级到 3.9.x/3.10.x 的用户，存储里的 `sourceAndTranslate` 与「用户亲手选的双语」无法区分。

## Goals / Non-Goals

**Goals:**

- 出厂默认回到仅译文；已保存的偏好在所有入口都被尊重，不被任务类型或内置配方改写。
- 主进程对输出内容「总是有效」：缺失或未知时按默认交付，不再产生空文件；渲染出错时任务失败而不是静默。
- 翻译不会抹掉用户的源字幕。
- 让用户在合成面板里看见成片字幕的内容来源。

**Non-Goals:**

- 迁移已保存的值（决策 3）。
- 版本号与 `Changelog/`（发版时写）。
- 卡片标题「视频 → 双语字幕」：3.0 起就有，早于本问题。
- `translateProvider: 'autoFree'`、模型、语言等其它默认值。
- 另外几处输出内容字面量（`useStandaloneSubtitles`、`subtitleExportStage`、`dubTextSource`、`subtitleDeliverables.ts` 的回退）：它们与默认值一致，或只会看到归一化之后的值。

## Decisions

**1. 默认值与归一化放在无依赖的 `types/translateContent.ts`。**
导出 `DEFAULT_TRANSLATE_CONTENT`、`isTranslateContent`、`normalizeTranslateContent` 和 `withValidTranslateContent(config)`。后者为翻译类任务补全缺失或无效的值；值本来有效时返回同一个对象；`generateOnly` 任务不动。主进程、渲染进程、自动化都从这里取，类型文件保持无依赖（与 `types/taskConfig.ts` 一致）。
备选：各处各写 `|| 'onlyTranslate'`——否决。下载流水线里原有的那一处兜底其实是死代码（值总是存在），零散的兜底各管一段，补不到真正出问题的情形：`undefined` 一路传到模板查找。

**2. 偏好优先：`newTaskDefaults` = `{ ...preferences, taskType }`。**
已保存的偏好对所有任务类型生效。内置配方是任务页的无损别名（`task-recipes` 本来就这么要求），所以不再携带 `translateContent`；用户自己保存的配方里的显式配置照旧生效；`launchpadDraft` 与向导的合并逻辑不变。
备选：保留「生成并翻译默认双语」，只在没保存过偏好时生效——否决。出厂默认就是要回到仅译文，没有理由让某个任务类型另有一套默认；而且「是否保存过」本身在存储里区分不出来（见决策 3）。

**3. 不迁移已保存的值（用户已确认）。**
3.9.x/3.10.x 期间写入的 `sourceAndTranslate`，包括被强制改成的那份，一律视为用户偏好；这些用户在配置栏改一次，之后就被记住。记录为已知限制。
备选：一次性把 `sourceAndTranslate` 迁回 `onlyTranslate`——否决：会把确实想要双语的用户的选择悄悄改掉，而存储里无法区分两者。

**4. 在唯一的提交入口归一化。**
`persistTaskSubmission` 是界面、自动化、下载流水线共用的提交入口，在这里归一化同时让配置快照与校对 sidecar 保持一致。已固定的旧快照（文件重试时）按同样规则补全。快照指纹仍取自原始 `input.formData`，调用方传入的对象不被修改。
`generateOnly` 不写这个字段：它不翻译，且 `scripts/test-task-submission.cjs` 断言它的快照与表单逐字相等。
下载流水线与自动化在构造配置时各自再补全一次（纵深防御：已保存的偏好可能早于该选项）。

**5. `translate()` 对未知值兜底，并让失败可见。**
值缺失或未知时按默认交付；非空的未知值写一条警告日志（空值静默，避免日志噪声）。`results.forEach(async …)` 改成 `for…of`：循环体里没有 `await`，处理顺序不变，但后处理或渲染的错误现在沿调用链抛给 `translateSubtitle` / `onError`，不再是未处理的 rejection 加一个空文件。

**6. 写入前守卫：目标不能是正在翻译的源字幕。**
`assertOutputDoesNotOverwriteInput(output, [srtFile])`：解析后的路径相同，或两个已存在的文件 `dev:ino` 相同（覆盖符号链接、硬链接、大小写不敏感文件系统）时抛错。它放在 `createOrClearFile` 之前，所以不会清空文件，也不会花翻译额度。stat 用 `bigint`，避免 NTFS 64 位文件号转成 number 后的误判。
不复用 `createSubtitlePathIdentity`：它要读目录判断大小写，需要目录非空，在自动化的全新输出目录上会抛错。
导出阶段的 `writeSubtitleDeliverables` 本来就会以「Source and translated subtitle paths overlap」拒绝这种配置，但那发生在翻译已经把源字幕清空并覆盖之后；守卫只是把拒绝提前到损坏发生之前。
备选：撞名时自动改名——否决：会悄悄改掉用户选的文件名，并掩盖配置错误。

**7. 自动化不合并整个 `defaultUserConfig`。**
那会连带改变 `model`、`translateProvider`、语言等自动化调用方没有传的默认值，超出本修复的范围。自动化只经 `withValidTranslateContent` 补全输出内容。

**8. 合成面板提示成片字幕内容，提示做成独立的小组件。**
成品视频取字幕的优先级是「顺延版 → 译文交付物 → 源字幕」（`pickComposeSubtitle`），所以开启翻译后，烧进或封装进成片的文字就是输出内容样式；硬字幕压进画面后无法再改回，值得在面板上直说（与 `pipeline-dub-stage` 中「合成阶段烧进成片的字幕与用户选择的输出内容一致」相呼应）。
`ComposeContentHint` 只在「翻译开启且成片带字幕」时显示，未设置的值按默认显示；抽成组件是为了不用挂载两千八百行的向导就能测试这些条件。文案复用 `home` 里已有的三个样式名，不会与选择器脱节。

## Risks / Trade-offs

- [3.9.x/3.10.x 期间已保存 `sourceAndTranslate` 的用户继续得到双语] → 已知限制；改一次就被记住；配置栏摘要和合成面板提示让当前值始终可见。
- [守卫把原本「碰巧能跑」的配置变成明确的错误] → 只在目标就是源字幕时触发，例如对 `clip.srt` 仅翻译并把目标命名选为「文件名」，此前的结果是源字幕被译文覆盖；常规流程（如 `clip.srt` → `clip.fr.srt`）不受影响；导出阶段本来就会拒绝同一配置。
- [归一化可能给旧快照多写一个键] → `TASK_CONFIG_BUSY` 的相等比较只对「已固定的旧快照，且同一工程正在运行」有意义，暴露面与说话人分离边界已有的处理相同。
- [`for…of` 改变错误传播] → 这正是目的；此前这些错误被吞掉并留下空文件。
- [提示文案里写死了「输出内容」] → 它对应 `tasks.json` 的 `configBar.style`；该标签改名时需要同步这条提示。
