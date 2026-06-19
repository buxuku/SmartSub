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

## 6. 评审追加调整（首轮试用反馈）

- [x] 6.1 高级设置集中：废弃「每族内联 `SherpaFamilyAdvanced`」（2.2 的旧形态），改为组面板底部**单一**「高级设置」折叠区——线程数统一一项（更改时同步写入 `set-funasr/qwen/firered-settings`），ITN 单独成行并备注「仅 FunASR（SenseVoice）支持」（`engines.sherpa.{advanced,numThreads,numThreadsHint,itn,itnHint,itnFunasrOnly}`）
- [x] 6.2 不再展示 VAD 面板：silero-vad 随包内置（`extraResources/sherpa/vad`），从 `FunasrModelSection`/`QwenModelSection`/`FireRedModelSection` 删除 VAD 区块及其 `vadInstalled`/孤立 import；ASR 导入按钮转为无条件
- [x] 6.3 运行库内置不再做安装检测：移除三族 `pkgInstalled` 链路（`EngineModelTab` 三个 `*PkgInstalled` state + `engineInstalled` 读取 + `SherpaFamily.pkgInstalled`），族徽标只剩「可用 / 需下载模型」，不再出现「未安装」
- [x] 6.4 `npx tsc --noEmit -p renderer/tsconfig.json` 改动文件零错误；`node scripts/check-i18n.mjs` 通过
- [x] 6.5 左栏引擎列表固定、仅右栏滚动：`engines.tsx` 外层去掉 `overflow-auto`，`EngineModelTab` 根容器 `h-full min-h-0 md:flex-row`，左 nav `md:overflow-y-auto` 整列常驻、右栏 `overflow-y-auto` 独立滚动
- [ ] 6.6 冒烟：高级设置改线程数后三引擎一致生效；ITN 仅作用 FunASR；三族在内置运行库下仅按模型下载态显示徽标；左栏固定/右栏独立滚动正常（需运行 App）
