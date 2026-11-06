## Why

用户反馈：在任务页的「高级选项」里调整过参数，新建任务时又要重新配置一遍。

这个问题在两个版本里各出现了一次：

1. **3.9：不记忆。** 3.8 的 `useFormConfig` 在表单每次变化时把整份配置写进 `userConfig`（「上次用什么，下次默认什么」）。3.9 把任务页改成工程草稿，去掉了这条写入，调整过的参数不再进入新任务的默认值。
2. **3.10：只在开始任务时记忆。** 3.10 补上了 `rememberTaskDefaults`——任务被主进程确认之后，才把该任务的配置记为默认值。只调整、不运行的参数仍然不会保存：用户在高级面板里改好一个值，随后改主意不跑了，或者先建好几个任务再统一开始，下一个新任务看到的还是旧值。

从体验上看，「在高级面板选一次即被记忆」（见已归档的 `subtitle-outcome-presets` 的 D12）应当在调整的那一刻就成立，而不是等到任务运行。3.8 的整份覆盖也有它自己的问题——打开一个旧工程、只改一项，旧工程里所有陈旧的值都会整份冲掉默认配置，这正是 3.9 去掉它的原因。所以这次不是简单还原，而是只记忆用户改过的键。

## What Changes

- 任务页（`/tasks/[type]`）上用户调整的参数，停顿 400 ms 后以「补丁」写入默认配置 `userConfig`：连续输入合并成一次，只写改过的键，不整份覆盖，不需要运行任务。
- 每次装载表单（新任务、恢复已有工程）开一个会话，基线是装载时表单里的值，补丁是对基线的差分。所以仅打开或恢复工程零写入，在旧工程里只改一项只写这一项，改回原值不发送。
- 不记忆：代码做的自动纠正（`translateProvider`、转写引擎 / 模型 / `asrProviderId`、`sourceSrtSaveOption` 的自愈，只移动基线）；逐任务字段（`taskType`、`dub`、`compose`、`gates`、`cloudUploadConsent`、参考文稿）。其余的键不设白名单，以后新增的设置自然被记忆。
- 先冲刷再继续：切换工程、页面卸载、窗口关闭、任务页为新任务读取默认值之前，一定先写入还在防抖中的改动，所以「刚改完马上新建任务」也拿得到最新值。写入失败只记日志，不打断编辑；没写成的键在下一次修改或离开页面时重试。
- IPC：`updateTaskDefaults(patch)` 取代 `rememberTaskDefaults`。主进程用 `applyTaskDefaultsPatch` 把补丁合并进已存配置：`undefined` 表示删键（出厂默认重新生效），逐任务键被丢弃，非法载荷以 `INVALID_TASK_DEFAULTS` 拒绝，写入失败向调用方抛错。
- 删除 3.10 的「开始任务时记忆」，只保留这一套机制：`TaskControls` 的 `rememberDefaults` 与 `rememberConfig`、共享规则里的 `toRememberedTaskDefaults`、hook 里的 `rememberTaskDefaults`。`rememberSelection`（写 `lastUsedTranscription`）不动。
- 范围仅任务页（用户已确认）：新建任务向导继续只读取默认值、不写回，`pipeline-task-wizard` 的规格不变。
- 回归测试：`TaskDefaultsSync`（jest 假定时器）、`TaskDefaults`（共享规则）、`useUnifiedTaskConfig`、`TaskControlsDefaults`；`test:task-defaults`（真实 handler，已在 CI 的 `test:pro-baseline` 里）；Electron 端到端 `task-defaults`、`task-project-persistence`、`task-config-load`。
- 不做：向导实时写入、版本号与 `Changelog/`（发版时写）、新增界面文案、多窗口之间的广播、迁移已保存的值、场景预设标签的检测规则（见已知限制）。

## Capabilities

### New Capabilities

- `task-defaults-memory`: 任务页的「上次使用」记忆——用户调整的参数防抖后以补丁写入默认配置，只记忆用户改过的键，自动纠正与逐任务字段不记忆，离开页面或新建任务之前先冲刷，失败可重试，向导与只读快照页不写入。

### Modified Capabilities

（无。`pipeline-task-wizard` 里「配置默认值取用户上次使用值（转写/翻译沿用任务页记忆）」的要求原样成立，这里补上的是「任务页记忆」本身的行为。）

## Impact

- 共用模块：`types/taskConfig.ts`（新增 `isTaskDefaultsKey`、`applyTaskDefaultsPatch`，删除 `toRememberedTaskDefaults`）。
- 主进程：`main/helpers/ipcStoreHandlers.ts`（`updateTaskDefaults` 取代 `rememberTaskDefaults`）。
- 渲染进程：`renderer/lib/taskDefaultsSync.ts`（新增）、`renderer/hooks/useUnifiedTaskConfig.ts`（`syncDefaults`、`correctValue`、`flushDefaults`）、`renderer/pages/[locale]/tasks/[type].tsx`、`renderer/components/TaskControls.tsx`。
- 测试与脚本：`renderer/lib/__tests__/TaskDefaultsSync.test.ts`（新增）、`TaskDefaults.test.ts`、`renderer/hooks/__tests__/useUnifiedTaskConfig.test.tsx`、`renderer/components/__tests__/TaskControlsDefaults.test.tsx`、`scripts/test-task-defaults.cjs`、`scripts/test-launchpad-import.cjs`、`scripts/e2e/{task-defaults,task-project-persistence,task-config-load}.mjs`。
- 对外行为：在任务页调整的参数很快成为新任务的默认值，不必运行任务；仅打开旧工程、运行任务、使用向导都不改变默认值。无新依赖，无界面文案变化，存储结构不变（`userConfig` 仍是同一个键，值的形状不变）。
- 已知限制：
  - 「场景预设」按钮的标签：新任务继承了记住的预设（网课 / 影视 / 短剧 / 均衡）后，标签可能显示「专家自定义」。预设检测把出厂默认的 `maxSubtitleChars: 0`、`speakerDiarizationCount: 0` 当成用户改过的值，而预设本身会把这两项置为未设置，经「删键」后又由出厂默认补回 `0`。出厂默认的新任务（改动前同样）本来就显示「专家自定义」。参数值本身被正确继承，只是标签不同；本次不改检测规则。
  - `fix-translate-content-defaults` 把「在配置栏改一次，之后就被记住」写成了 3.9.x / 3.10.x 已保存 `sourceAndTranslate` 用户的出路；3.10 里这只在运行任务之后才成立，现在改完即成立。
