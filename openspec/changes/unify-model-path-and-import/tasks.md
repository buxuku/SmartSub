## 1. 后端：每引擎自定义模型路径

- [x] 1.1 `store/types.ts` 在 settings 接口新增可选字段 `funasrModelsPath?` / `qwenModelsPath?` / `fireRedModelsPath?`（与现有 `fasterWhisperModelsPath?` 同构）
- [x] 1.2 `funasrModelCatalog.ts#getFunasrModelsRoot()` 改为读 `settings.funasrModelsPath` 否则回退 `userData/models/funasr`，沿用 `ensureDir` 后返回
- [x] 1.3 `qwenModelCatalog.ts#getQwenModelsRoot()` 改为读 `settings.qwenModelsPath` 否则回退 `userData/models/qwen`
- [x] 1.4 `fireRedModelCatalog.ts#getFireRedModelsRoot()` 改为读 `settings.fireRedModelsPath` 否则回退 `userData/models/firered`
- [x] 1.5 确认三个 getter 的 store 访问与测试环境兼容（惰性 `require('./store')`，对齐 `downloadConfig` 的惰性加载处理）

## 2. 后端：导入校验/目的地解析（可单测纯逻辑）

- [x] 2.1 新增纯函数 `validateModelLayout(srcDir, requiredFiles): { ok, missing[] }`（逐项检查相对路径，支持嵌套如 `tokenizer/vocab.json`），放在 `main/helpers/modelImport.ts`，可被 `scripts/test-engine-units.ts` 引用
- [x] 2.2 新增 `resolveImportPlan(engine, modelId)`（systemInfoManager 内）：sherpa 返回 `<root>/<dirName>`；fasterWhisper 返回合成快照目录 `<ct2 root>/<toCt2CacheDirName(modelId)>/snapshots/imported`
- [x] 2.3 定义各引擎导入校验集来源：sherpa 取对应 catalog 的 `requiredFiles`；fasterWhisper 取 `CT2_REQUIRED_FILES`（`model.bin`/`config.json`）

## 3. 后端：泛化 importModel IPC

- [x] 3.1 `systemInfoManager.ts#importModel` 接受可选入参 `{ engine, modelId }`；无参或 `engine==='builtin'` 维持现有单文件 `.bin/.mlmodelc` 逻辑（向后兼容）
- [x] 3.2 文件夹导入分支：`dialog.showOpenDialog({ properties:['openDirectory'] })` 取源目录
- [x] 3.3 预校验 `validateModelLayout`，失败返回 `{ success:false, reason:'invalid-layout', missing }` 且不写盘
- [x] 3.4 `fse.copy(srcDir → resolveImportPlan())` 保留嵌套结构；目的地已存在则覆盖
- [x] 3.5 后校验目的地 `requiredFiles` 全在，返回 `{ success:true }`；统一错误形态 `{ success:false, reason?, error? }`
- [x] 3.6 sherpa 引擎覆盖前先 `getSherpaAsrRuntime().dispose()` 释放共享 worker，避免覆盖正在使用的模型目录时文件锁

## 4. 渲染层：UI 接入

- [x] 4.1 `ModelLibrarySection.tsx` 放开 funasr/qwen/fireRedAsr 的「更换路径」按钮（移除 `!isFunasr && !isQwen && !isFireRed` 限制）
- [x] 4.2 `handleChangeModelsPath` 按引擎写对应设置键（builtin→`modelsPath`、fasterWhisper→`fasterWhisperModelsPath`、funasr→`funasrModelsPath`、qwen→`qwenModelsPath`、fireRedAsr→`fireRedModelsPath`）
- [x] 4.3 路径展示区按引擎读取对应的 `systemInfo.*ModelsPath`（既有实现已覆盖 funasr/qwen/firered）
- [x] 4.4 sherpa 三引擎（FireRed/Qwen/Funasr Section 模型行）与 fasterWhisper（`Ct2ModelRowActions`）接入「从文件夹导入」动作，调用 `importModel({ engine, modelId })`
- [x] 4.5 导入结果按 `kind` 出文案：`invalid-layout`（列出缺失）/ `canceled`（静默）/ `error`；成功后 `onUpdate()` 刷新状态

## 5. 后端：系统信息字段

- [x] 5.1 `systemInfoManager.ts#getSystemInfo` 已暴露 funasr/qwen/fireRed 当前模型路径字段（既有实现）
- [x] 5.2 `types/types.ts#ISystemInfo` 已含 `funasrModelsPath` / `qwenModelsPath` / `fireRedModelsPath`（既有实现）

## 6. i18n

- [x] 6.1 `resources.json`（zh/en）增补 `importFromFolder` / `importModelSuccess` / `importModelFailed` / `importInvalidLayout`（供 sherpa 三 Section 的 `resources` namespace）
- [x] 6.2 `modelsControl.json`（zh/en）增补 `importFromFolder` / `importInvalidLayout` / `modelPathChangedHint`（供 ModelLibrarySection / ct2）
- [x] 6.3 复用既有 `changePath` / `modelPathChanged` / `openModelsFolder` 文案，避免重复键

## 7. 测试与静态校验

- [x] 7.1 `scripts/test-engine-units.ts` 增加 `validateModelLayout` 用例：齐备→ok；缺嵌套 `tokenizer/vocab.json`→missing 命中；funasr 两模型同集（按模型 id 取集消歧）
- [x] 7.2 增加 catalog requiredFiles 用例：qwen 含嵌套 `tokenizer/vocab.json`；fireRed 三件套
- [x] 7.3 增加 `resolveOverridePath` 用例：覆盖值优先；空/空白/undefined 回退默认
- [x] 7.4 `npx tsc --noEmit`（renderer 用 `renderer/tsconfig.json`）+ `yarn test:engines`（137 通过）+ `node scripts/check-i18n.mjs` 全绿

## 8. 端到端冒烟（运行时验证，手动）

- [ ] 8.1 对 funasr/qwen/fireRedAsr 各设一个自定义路径 → 下载/已安装/打开目录/转写均落新路径
- [ ] 8.2 准备一份本地 sherpa 模型文件夹（含嵌套）→ 导入 → 显示已安装 → 可转写出 SRT
- [ ] 8.3 导入布局不匹配的文件夹 → 被拒、有缺失提示、模型库无残留
- [ ] 8.4 fasterWhisper 导入一个 CT2 文件夹 → 经 `resolveCt2ModelSnapshotDir` 命中 → 实际转写可加载
- [ ] 8.5 回归：builtin 单文件导入、各引擎下载/删除、改路径不影响其它引擎，均不受影响

## 9. 共享 VAD 改为随应用内置（与引擎模型根解耦）

- [x] 9.1 将 `silero_vad.onnx`（~1.8MB，实测 1,807,522 字节）提交到 `extraResources/sherpa/vad/silero_vad.onnx`（沿用 `extraResources/sherpa/` 整目录拷贝，无需改 `electron-builder.yml`）
- [x] 9.2 `funasrModelCatalog.ts` / `qwenModelCatalog.ts` / `fireRedModelCatalog.ts`：新增/改写 `get*VadModelPath()` 返回 `resolveBundledVadPath(getExtraResourcesPath())`（惰性 `require('./utils')`，dev/prod 均解析为真实文件路径）
- [x] 9.3 `is*VadInstalled()` 改为基于内置文件存在性（`fs.existsSync`，正常安装恒真）；`isFunasrReady()` 退化为「内置 VAD + 至少一个 ASR 模型已装」
- [x] 9.4 退役下载链路：移除三面板 `handleDownloadVad` 与 VAD 下载入口；`FUNASR_MODELS['silero-vad']` 保留为「已退役/随包内置」遗留元数据（注释标注），UI 不再暴露
- [x] 9.5 渲染层：`FunasrModelSection` / `QwenModelSection` / `FireRedModelSection` 的 VAD 行改为「已内置」徽标（`commonT('builtIn')`），移除下载/取消/进度分支与 `needModelsHint` 头徽标
- [x] 9.6 i18n：新增 `common.builtIn`（zh「已内置」/ en「Built-in」）；`needModelsHint` 等保留向后兼容；`check-i18n` 通过
- [x] 9.7 `scripts/test-engine-units.ts`：新增 `SHERPA_VAD_SUBPATH` 与 `resolveBundledVadPath()` 纯函数用例（不触 electron）
- [x] 9.8 静态校验：renderer `tsc -p renderer/tsconfig.json`（改动文件零新增错误）+ `yarn test:engines`（139 通过）+ `node scripts/check-i18n.mjs` 全绿
- [ ] 9.9 冒烟：全新（无下载历史）环境选 funasr/qwen/fireRedAsr，仅装 ASR 模型即可转写出 SRT（VAD 无需下载即就绪）
- [ ] 9.10 冒烟：对 funasr 设自定义路径后，qwen/fireRedAsr 就绪态不受影响（VAD 不随之移动）
