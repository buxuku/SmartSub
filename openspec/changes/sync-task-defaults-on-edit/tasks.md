# Tasks: sync-task-defaults-on-edit

## 1. 共享规则与主进程

- [x] 1.1 `types/taskConfig.ts`：新增 `isTaskDefaultsKey`（逐任务键 `taskType`、`dub`、`compose`、`gates`、`cloudUploadConsent`、`manuscriptPath`、`manuscriptName` 之外的键都可记忆）与 `applyTaskDefaultsPatch(stored, patch)`（`undefined` 删键；过滤逐任务键与 `__proto__`；存储里残留的参考文稿键一并剔除；存储值不是普通对象时按补丁重建；补丁不是普通对象时抛 `INVALID_TASK_DEFAULTS`；不修改入参）；删除 `toRememberedTaskDefaults`
- [x] 1.2 `main/helpers/ipcStoreHandlers.ts`：`updateTaskDefaults` 取代 `rememberTaskDefaults`，把补丁合并进已存的 `userConfig`，写入失败向调用方抛错；`getUserConfig` 不变

## 2. 渲染进程

- [x] 2.1 新增 `renderer/lib/taskDefaultsSync.ts`（无 React 依赖，模块顶层不访问 `window`）：`diffTaskDefaults`（按顶层键 `isEqual` 差分，值拷贝，过滤逐任务键）与 `createTaskDefaultsSync({ send, delayMs, onError })`（`start` / `edit` / `correct` / `flush`）；防抖 400 ms；基线只在主进程确认保存后前进；发送串行、空闲时同步发出；换会话先冲刷旧会话；上一次保存失败的会话在下一次 `flush` / `start` 重试
- [x] 2.2 `renderer/hooks/useUnifiedTaskConfig.ts`：`syncDefaults` 选项（默认 `false`，向导不受影响，编辑时经 ref 读取）；`hydrateSnapshot` 开新会话；`form.watch` 把用户改动交给同步模块；`correctValue(name, value)`；`flushDefaults()`；卸载与 `beforeunload` 冲刷；`rememberTaskDefaults` 换成 `updateTaskDefaults`；更新文件头注释
- [x] 2.3 `renderer/pages/[locale]/tasks/[type].tsx`：`syncDefaults: !configSnapshot`；三处自动纠正（翻译服务商、转写引擎 / 模型 / `asrProviderId`、`sourceSrtSaveOption`）改用 `correctValue`；新建工程分支在 `readTaskDefaults()` 之前先 `await flushDefaults()`；去掉 `rememberDefaults` 属性；改掉 `taskType` effect 里过期的「同步到持久化配置」注释；用户点「采用建议服务商」的 `setValue` 属于用户操作，保持原样
- [x] 2.4 `renderer/components/TaskControls.tsx`：移除 `rememberDefaults` 属性与 `rememberConfig`；`rememberSelection`（`lastUsedTranscription`）保留

## 3. 测试

- [x] 3.1 `renderer/lib/__tests__/TaskDefaultsSync.test.ts`（新增，jest 假定时器）：连续改动合并成一次补丁、只含改动的键、逐任务键被忽略、改回基线值不发送、仅装载不发送、换会话先冲刷旧会话且不污染新基线、纠正不被记忆但之后用户改同一个键会被记住、失败后基线不前进并在下次修改或冲刷时重试（含重试中的重复冲刷）、串行（改了又改回，最终值正确）、`undefined` 表示删键
- [x] 3.2 `renderer/lib/__tests__/TaskDefaults.test.ts`：`toRememberedTaskDefaults` 的用例换成 `applyTaskDefaultsPatch`（合并、删键、过滤逐任务键与 `__proto__`、残留参考文稿键、非普通对象的补丁与存储值、不修改入参）与 `isTaskDefaultsKey`
- [x] 3.3 `renderer/hooks/__tests__/useUnifiedTaskConfig.test.tsx`：`rememberTaskDefaults` 部分重写为 `syncDefaults` 用例（补丁、合并、改回不写、装载与旧工程不写、卸载 / 窗口关闭 / 切换工程 / `flushDefaults` 冲刷、纠正、选项关闭、StrictMode、写入失败后重试）；默认模式永不写入、读取失败与装载取代等既有用例保留
- [x] 3.4 `renderer/components/__tests__/TaskControlsDefaults.test.tsx`：重写为「`TaskControls` 不再写默认值，仍记录 `lastUsedTranscription`，传入旧的 `rememberDefaults` 属性也无效」
- [x] 3.5 `scripts/test-task-defaults.cjs`（已在 `test:pro-baseline`）：用真实 handler 测 `updateTaskDefaults`——合并、删键、过滤、非法载荷不改存储、写入失败向调用方抛错、`getUserConfig` 叠加结果，旧的 `rememberTaskDefaults` 通道已不存在；`scripts/test-launchpad-import.cjs` 去掉 `rememberDefaults: true`
- [x] 3.6 变异检查：对同步模块、共享规则与 hook 的 17 处关键行为各做一处手工变异——基线在主进程确认之前就前进、纠正也被记忆、差分不再过滤逐任务键、换会话不先冲刷、失败的会话不重试、保存不串行、没有防抖、浅比较代替深比较、重试中的冲刷重复排队、主进程保留 `__proto__` 键、保留逐任务键、`undefined` 不删键、装载不开新会话、忽略 `syncDefaults` 选项、卸载不冲刷、`beforeunload` 不冲刷、`correctValue` 先改表单再移基线。16 处各有测试失败；最后一处与原顺序行为等价（保存在运行时才对基线做差分），仍保留「先移基线」的顺序

## 4. 端到端（Electron，开发服务器）

- [x] 4.1 `scripts/e2e/task-defaults.mjs`：改成「改完不运行任务也被记住（轮询默认配置）、改完立刻离开页面不丢（含未保存草稿的离开确认）、逐任务字段不被记住、新任务继承高级设置」
- [x] 4.2 `scripts/e2e/task-project-persistence.mjs`：翻转两处「任务编辑不改默认值」的断言；真实目录权限锁定下默认值的写入安静地失败、已保存的默认值不变，离开页面后补写成功
- [x] 4.3 `scripts/e2e/task-config-load.mjs`：给 `updateTaskDefaults` 计数（先以一次真实调用验证计数器有效），默认值读取失败时打开已有工程为零写入
- [x] 4.4 扫过其余读 `getUserConfig` 的 e2e（`provider-persistence`、`scenario-presets`、`scenario-language`、`builtin-recipes`、`wizard-recovery`、`ux-phase-one`、`task-activity`、`task-list-layout`）：它们要么在编辑前播种默认值、经 IPC 直接提交任务，要么只在新建任务向导里操作（向导不写默认值），不经过任务页的编辑，无需改动

## 5. 验证

- [x] 5.1 `yarn typecheck`（renderer、main、automation、crash 四个 tsc 项目）、`yarn check:i18n` 通过；所有改动与新增文件 `prettier --check` 通过
- [x] 5.2 `yarn test:renderer`（jest `--runInBand`，与 CI 一致）：85 个套件、907 条用例全部通过；`yarn test:parameter-persistence` 通过
- [x] 5.3 `yarn test:pro-baseline`：43 条命令全部通过（含 `test:task-defaults`、`test:launchpad-import`、`test:task-draft`、`test:task-submission`）
- [x] 5.4 `yarn build`（renderer + main + CLI/MCP 入口）、`yarn check:jassub-guard`、`yarn test:automation` 通过（改动触及 `main/**` 与 `types/**`，会触发 MCP 与 CLI 集成工作流）
- [x] 5.5 Electron 端到端（`nextron dev` 开发服务器、8888 端口、全新的临时配置目录）：`task-defaults`、`task-config-load`、`task-project-persistence` 全部通过。`task-project-persistence` 依赖本机固定路径的媒体夹具（`/Volumes/.../demo.mp4`），本机没有，用生成的 `demo.mp4` 临时副本跑通，仓库里的脚本没有改动该路径。`scenario-presets`、`scenario-language`、`builtin-recipes` 需要本机的真实媒体或 Whisper 模型，未运行，改按脚本内容静态核对（见 4.4）
- [x] 5.6 真机观察「场景预设」标签：全新配置目录里新任务显示「专家自定义」（改动前同样）；把影视预设的参数经 `updateTaskDefaults` 记为默认值后，磁盘上的默认配置保存着影视的参数值，`maxSubtitleChars`、`speakerDiarizationCount` 两个键被删除（出厂 `0` 在读取时补回），新任务的标签仍是「专家自定义」——见 proposal 的已知限制
- [x] 5.7 `openspec validate sync-task-defaults-on-edit --strict` 通过
