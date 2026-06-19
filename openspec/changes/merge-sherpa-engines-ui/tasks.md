## 1. 展示组与左栏

- [ ] 1.1 渲染层定义 sherpa 展示组常量与「组 ↔ 三引擎 id（funasr/qwen/fireRedAsr）」映射（集中一处，如 `lib/engineModels` 或新常量文件）
- [ ] 1.2 `EngineModelTab.tsx`：左栏 `ENGINES` 从 6 项折叠为 `[builtin, fasterWhisper, <sherpa 组>, localCli]`
- [ ] 1.3 合并条目就绪点（`StatusDot` tone）= funasr/qwen/fireRedAsr 任一就绪 → ready，否则 pending
- [ ] 1.4 `EngineIcon.tsx`：为合并条目新增图标分支

## 2. 右栏分组容器

- [ ] 2.1 新增 `SherpaEngineGroupPanel`（或在 `EngineModelTab` 内）：顶部单张共享运行库卡（复用一个 `SherpaRuntimePanel`），下方三族分区
- [ ] 2.2 各族分区内联各自高级设置：FunASR(ITN + numThreads)、Qwen(numThreads + providerNote)、FireRed(numThreads + providerNote + 段长说明)——复用现 `FunasrPanel`/`QwenPanel`/`FireRedPanel` 的设置控件，去掉它们各自的运行库卡包装
- [ ] 2.3 模型清单按族分组复用 `FunasrModelSection`/`QwenModelSection`/`FireRedModelSection`（或 `ModelLibrarySection` 分组），保留下载/导入/删除/换路径
- [ ] 2.4 ITN 控件**仅**出现在 FunASR(SenseVoice) 分区（核实 qwen/firered 无 ITN）
- [ ] 2.5 未安装任何模型的族默认折叠/弱化（减少纵向长度）

## 3. 任务页模型选择器分组

- [ ] 3.1 任务页「引擎 ▸ 模型」选择器把三族模型按族分组展示（组标题：FunASR / Qwen / FireRed）
- [ ] 3.2 选择某族模型时仍写入对应 `transcriptionEngine` id（funasr/qwen/fireRedAsr），保持后端零改动
- [ ] 3.3 校验合并展示不影响既有任务回填（已存任务的 engine id 仍能正确映射回所属族）

## 4. i18n

- [ ] 4.1 `resources.json`（zh/en）：新增合并条目中性主名 + 副标题（`FunASR · Qwen · FireRed`）+ 三族分组标题
- [ ] 4.2 保留 funasr/qwen/fireRedAsr 各自既有键（组内复用）；`node scripts/check-i18n.mjs` 通过

## 5. 校验

- [ ] 5.1 `npx tsc --noEmit`（renderer 用 `renderer/tsconfig.json`）+ `yarn test:engines` 全绿
- [ ] 5.2 冒烟：合并条目下三族各自下载/导入/删除/换路径与转写均与合并前一致
- [ ] 5.3 冒烟：ITN 仅在 FunASR 分区出现；切换不丢运行库状态（共享 `useSherpaRuntime` 不重复请求）
- [ ] 5.4 冒烟：任务页能选到三族模型并正确转写；旧任务回填正确
