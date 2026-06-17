## 1. 后端：引擎逐任务透传（additive，全程编译绿、向后兼容）

> 顺序原则：单 TS 工程下渲染层仍在读全局字段，故本组只做**新增式**改动（任务引擎优先、缺省回退全局），全局字段的删除统一放到第 7 组（消费方迁移后）。

- [x] 1.1 `store/types.ts` 新增 `lastUsedTranscription?: { engine; model? }`（过渡期保留 `transcriptionEngine`，标注 @deprecated）
- [x] 1.2 `transcriptionRouter.ts`：`routeTranscription` 改用 `getEngineAdapterForTask(ctx.formData)` 按任务引擎解析（缺省回退全局）
- [x] 1.3 `engines/registry.ts`：新增 `resolveEngineIdForTask` / `getEngineAdapterForTask`（`getActiveEngineAdapter` 暂留给 cancel/ping，第 7 组清理）
- [x] 1.4 `taskProcessor.ts`：批次预热改用 `getEngineAdapterForTask(formData)`（`requiresRuntime && pyEngineId` 才启 sidecar）
- [x] 1.5 `taskProcessor.ts`：并发钳制改为按"执行中受限引擎计数 + 待派发队列引擎"判定，含 faster-whisper/funasr 时 `effectiveMax = 1`，纯 builtin 用 `maxConcurrentTasks`
- [x] 1.6 验证：`yarn test:engines` 通过（99/0）、改动文件 `tsc --noEmit` 零错误

## 2. 任务页：引擎▸模型 分组选择 + 跨引擎就绪

- [x] 2.1 `lib/engineModels.ts`：新增"跨引擎"辅助——`getEngineModelGroups`（聚合各引擎已装模型为分组，funasr 需 VAD+ASR；`includeLocalCli` 时附内置规范模型名）、`hasAnyModelAnyEngine`（localCli 不计入）、`encode/decodeEngineModel`、`pickDefaultEngineModel`
- [x] 2.2 `Models.tsx`：从扁平下拉改为「引擎 ▸ 模型」分组下拉（`SelectGroup`/`SelectLabel`，组标题用 `common:engineBadge.*`），选项 value 编码 (engine, model)，`onChange` 同时回传二者；trigger 显示「引擎 · 模型」；localCli 作为独立分组列出内置规范模型名（保 `${whisperModel}` 替换）
- [x] 2.3 `InlineConfigBar.tsx`：模型选择改用分组组件；`hasModels` 改用 `hasAnyModelAnyEngine(systemInfo) || includeLocalCli`；选中后写入 `form` 的 `transcriptionEngine` 与 `model`（`includeLocalCli` 过渡期取 `useLocalWhisper`）
- [x] 2.4 `tasks/[type].tsx`：默认选择逻辑改为读 `lastUsedTranscription`（缺省 builtin + 该引擎首个可用模型，`pickDefaultEngineModel`），并校验 (引擎,模型) 在分组选项中存在，否则回退
- [x] 2.5 任务执行（`TaskControls.handleTask`，仅 `needsModel`）写回 `lastUsedTranscription`（engine+model 整体）
- [x] 2.6 `defaultUserConfig` 新增 `transcriptionEngine: 'builtin'`，确保 `handleTask` 载荷始终携带；`getUserConfig` 合并默认值后旧配置也含该字段
- [x] 2.7 验证：改动文件 `tsc -p renderer/tsconfig.json` 零错误（剩余 190 行报错均在既有 `__tests__`）、`yarn test:engines` 99/0

## 3. 统一「引擎与模型」主从双栏视图

- [x] 3.1 新建统一组件 `components/resources/EngineModelTab.tsx`：左栏引擎列表（状态点，无启用开关）+ 右栏选中引擎详情，选中态为本地 state
- [x] 3.2 右栏运行时区：内联复用 `engines/panels/*`（faster-whisper 安装/修复/升级/卸载/参数、funasr、localCli 命令、builtin 说明），去掉 `EngineManageDrawer` 弹窗
- [x] 3.3 右栏模型区：抽出 `ModelLibrarySection`（ggml 档位 / ct2 档位 / FunasrModelSection），按左栏选中引擎渲染，**不依赖全局引擎**
- [x] 3.4 移除"设为当前/启用"相关逻辑：`handleSelectEngine`、`set-transcription-engine` 调用、`pendingActivate` 等（新组件不含这些）
- [x] 3.5 模型下载入口在引擎未安装时仍可用（`FunasrModelSection` 改为非阻断提示；`ModelLibrarySection` 不按引擎安装态门禁）
- [x] 3.6 移除 `ModelsTab` 的 `EngineContextBar`（"当前引擎"上下文条）——`ModelsTab` 收敛为薄壳复用 `ModelLibrarySection`

## 4. 全局指示移除 / 基座迁移 / Tab 收敛

- [x] 4.1 `Layout.tsx`：移除顶栏"当前转写引擎"徽章及其 `engine` state、`transcription-engine-changed` 监听；新手引导就绪判断改用 `hasAnyModelAnyEngine`（下载 pill 跳转改指 `engines`）
- [x] 4.2 `resources.tsx`：`RESOURCE_TABS` 收敛为 4 项（全景/引擎与模型/翻译服务/加速）；规范键用 `engines`，`?tab=models` 别名重定向到 `engines`；挂载 `EngineModelTab`
- [x] 4.3 `OverviewTab.tsx`：引擎卡与模型卡合并为「引擎与模型」单卡（跳统一 Tab）；就绪改用 `hasAnyModelAnyEngine`；移除"当前引擎"展示
- [x] 4.4 `BaseRuntimePanel` 迁入设置页（独立卡片，检查更新/升级）；统一引擎视图左栏不含 Python 基座条目
- [x] 4.5 校正其它跳转：`InlineConfigBar`/`home`/`modelsControl`/`OnboardingDialog`/下载 pill 的 `?tab=models` 均改指 `engines`；`home` 就绪改用 `hasAnyModelAnyEngine`
- [x] 4.6 删除被取代的死组件：`EnginesTab`/`ModelsTab`/`EngineManageDrawer`/`EngineWorkbenchCard`

## 5. i18n 与文案清扫

- [x] 5.1 i18n（zh/en）：`resources` 新增 `overview.engineModelTitle`、`tab.engines` 改为「引擎与模型」并删除 `tab.models`；删除废弃 `engines.title/description/active/setActive/switchBlocked/tags.*` 与 `overview.engine*`/`nextInstallEngine`；`common.engineBadge` 删除 `tip/manage/aria`（保留 4 引擎名供分组选择器用）
- [x] 5.2 `scripts/check-i18n.mjs` 通过（zh/en 键对等、无兜底模式）

## 6. 终验

- [x] 6.1 `openspec validate unify-engine-model-management --strict` 通过
- [x] 6.2 typecheck（改动文件零新增错误，剩余报错均为既有 `__tests__`/`service` 既存问题）+ `yarn build` 通过（exit 0，webpack compiled successfully）
- [~] 6.3 冒烟（代码走查确认链路；建议发布前人工跑一遍 GUI）：未装引擎可下模型（`ModelLibrarySection` 不门禁、`FunasrModelSection` 非阻断）；逐任务引擎执行（`routeTranscription→getEngineAdapterForTask(formData)`，并发钳制含 fw/funasr 时 =1）；默认=上次使用（`pickDefaultEngineModel`+`TaskControls` 写回）；跨引擎就绪（`hasAnyModelAnyEngine`）；顶栏无引擎徽章（`Layout` 已删）；旧深链接 `?tab=models→engines`（`resources` 别名）
- [~] 6.4 回归（代码走查确认未触及）：模型下载/删除/导入/换路径、加速、翻译服务 IPC 与处理器未改（`systemInfoManager` 仅删 `transcriptionEngine` 输出字段）；建议发布前人工回归

## 7. 全局字段下线（最后做：消费方全部迁移后）

> 必须等第 2–4 组把所有 `transcriptionEngine` / `useLocalWhisper` 运行时读取点迁走后再做，确保删除后仍编译绿。

- [x] 7.1 `store/types.ts`：删除 `settings.transcriptionEngine`（`store/index.ts` 默认值同步删除）；`useLocalWhisper` 保留为 localCli 配置开关，仅移除其"解析当前引擎"的运行时语义
- [x] 7.2 `ipcEngineHandlers.ts`：移除 `get-transcription-engine`/`set-transcription-engine`；`python-engine:ping` 改为按显式 engineId（`coerceEngineId(payload?.engineId)`，不再依赖 `getActiveEngineAdapter`）
- [x] 7.3 `engines/registry.ts`：删除 `getActiveEngineAdapter`；`resolveEngineIdForTask` 缺省回退 `builtin`（不再读全局）；`getEngineAdapter(id)` / `getEngineAdapterForTask` 为唯一入口
- [x] 7.4 `taskProcessor.ts` cancel 路径：改为遍历 `listEngineAdapters()` 逐个 `cancelActive()`（未运行引擎为空操作），不再依赖全局活动适配器
- [x] 7.5 `systemInfoManager.ts`：移除 `transcriptionEngine` 字段输出（连带删除 `resolveTranscriptionEngine`/`store` 未用导入）；`types/types.ts::ISystemInfo` 同步删字段
- [x] 7.6 删除 `main/helpers/transcriptionEngine.ts`（`resolveTranscriptionEngine` 唯一定义）；`scripts/test-engine-units.ts` 无需改动且 99/0 通过（`EngineModelInfo.transcriptionEngine` 渲染层参数保留供单引擎辅助/测试用）
- [x] 7.7 typecheck 改动文件零新增错误；`main/` 无残留 `getActiveEngineAdapter`/`resolveTranscriptionEngine`/`get|set-transcription-engine`/`settings.transcriptionEngine`（仅余合法的逐任务 `formData.transcriptionEngine`）

## 8. UI 收尾与面板交互统一（用户回馈第二轮，D10–D12）

- [x] 8.1 任务页选择器按运行时门禁：`getEngineModelGroups`/`hasAnyModelAnyEngine` 对 fw 要求 `pythonEngineStatus.state==='ready'`、对 funasr 要求 `funasrEngineInstalled`；`Models.tsx`/`InlineConfigBar.tsx` 透传 `pythonEngineStatus`/`funasrEngineInstalled`（D10）
- [x] 8.2 管理页文案/图标收尾：funasr 移除"运行时未安装"横幅、builtin 移除"语音模型"跳转按钮；左栏改用品牌化 `EngineIcon`（D11）
- [x] 8.3 卸载二次确认：fw/funasr「卸载」内联到信息行 + `AlertDialog` 二次确认（破坏性主按钮）；新增 i18n `engines.{fasterWhisper,funasr}.uninstallConfirm`（D12）
- [x] 8.4 funasr 检查更新对齐 fw：主进程新增 `check-sherpa-lib-update`（已装 `SherpaLibStatus.version` vs 内置 `SHERPA_VERSION`，导出常量）；面板已安装态统一「版本 + 检查更新/升级 + 卸载」，安装/升级共用确认弹窗（按 `installed` 切文案）（D12）
- [x] 8.5 localCli 启用开关：面板顶部 `Switch`（写 `settings.useLocalWhisper`），就绪点需「启用且已配置」；新增 i18n `engines.localCli.enable/enableHint`（D12）
- [x] 8.6 localCli 命令改多行 `Textarea`（`rows={4}`，等宽）（D12）
- [x] 8.7 终验：renderer typecheck（改动文件零新增错误，仅余既有 `__tests__` jest 类型缺失）+ `check:i18n` 通过 + `test:engines` 99/0 + `yarn build` exit 0（renderer + main 均编译成功）
