## 1. 展示组与左栏

- [x] 1.1 渲染层定义 sherpa 展示组常量与「组 ↔ 三引擎 id（funasr/qwen/fireRedAsr）」映射（`EngineModelTab.tsx` 内 `EngineView`/`SHERPA_FAMILIES`/`ENGINE_VIEWS`）
- [x] 1.2 `EngineModelTab.tsx`：左栏从 6 项折叠为 `ENGINE_VIEWS = [builtin, fasterWhisper, sherpa, localCli]`（选中态改用新 localStorage key `engineModelSelectedView`，旧值自然回落）
- [x] 1.3 合并条目就绪点（`StatusDot` tone）= funasr/qwen/fireRedAsr 任一就绪 → ready，否则 pending（`sherpaAnyReady`）
- [x] 1.4 `EngineIcon.tsx`：为合并条目新增 'sherpa' 图标分支（堆叠声波层），类型放宽为 `TranscriptionEngine | 'sherpa'`

## 2. 右栏分组容器

- [x] 2.1 新增 `SherpaEngineGroupPanel`：顶部单张共享运行库卡（内联，仅渲染一次），下方三族折叠分区
- [x] 2.2 各族分区内联各自高级设置（`SherpaFamilyAdvanced`）：FunASR(ITN + numThreads)、Qwen(numThreads + providerNote)、FireRed(numThreads + providerNote)——从原 3 个 panel 抽出设置控件，去掉运行库卡包装
- [x] 2.3 模型清单按族复用 `ModelLibrarySection`（内部即 `FunasrModelSection`/`QwenModelSection`/`FireRedModelSection`），保留下载/导入/删除/换路径
- [x] 2.4 ITN 控件**仅**出现在 FunASR 分区（已核实 qwen/firered 无 ITN）
- [x] 2.5 未安装任何模型的族默认折叠（`defaultOpen = modelsReady || 任一未就绪时的首族`）

## 3. 任务页模型选择器分组

- [x] 3.1 任务页「引擎 ▸ 模型」选择器已按族分组展示（`Models.tsx` 每引擎独立 `SelectGroup`，组标题 = `engineBadge.<engine>`，即 FunASR / Qwen / FireRed）——既有行为已满足，无需改动
- [x] 3.2 选择某族模型仍写入对应 `transcriptionEngine` id（`encodeEngineModel` 编码真实引擎 id），后端零改动
- [x] 3.3 既有任务回填正确（`decodeEngineModel` 直接还原为真实引擎 id，不经展示组）

## 4. i18n

- [x] 4.1 `resources.json`（zh/en）：新增 `engines.sherpa.{name, subtitle, desc, builtinRuntime, installedVersion, needsModels}`，副标题 `FunASR · Qwen · FireRed`
- [x] 4.2 保留 funasr/qwen/fireRedAsr 各自既有键（组内复用 name/needsModels/notInstalled/advanced/itn*/numThreads*/providerNote）；`node scripts/check-i18n.mjs` 通过

## 5. 校验

- [x] 5.1 `npx tsc --noEmit -p renderer/tsconfig.json`（改动文件零错误）+ `yarn test:engines`（139 passed）全绿
- [ ] 5.2 冒烟：合并条目下三族各自下载/导入/删除/换路径与转写均与合并前一致（需运行 App）
- [ ] 5.3 冒烟：ITN 仅在 FunASR 分区出现；切换不丢运行库状态（共享 `useSherpaRuntime` 不重复请求）（需运行 App）
- [ ] 5.4 冒烟：任务页能选到三族模型并正确转写；旧任务回填正确（需运行 App）
