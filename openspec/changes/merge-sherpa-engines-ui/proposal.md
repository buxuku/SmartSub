## Why

funasr / qwen / fireRedAsr 在引擎面是**三个独立左栏条目**，但它们：

- 共用同一个 sherpa-onnx 原生运行库（同一份二进制）；
- 共用同一份内置 VAD、同一套转写 / 取消 / 预热流程（`funasrEngine.ts` / `qwenEngine.ts` / `fireRedEngine.ts` 三个 adapter 90% 重复）；
- UI 已经共用一个 `SherpaRuntimePanel` + `useSherpaRuntime`。

三条目各自渲染**同一张运行库管理卡**，会误导用户：以为要把「运行库」下载三遍，或担心卸载 funasr 的运行库会拖垮 qwen（它们其实共享同一份）。三者真正的差异只有：**选用的模型不同**（SenseVoice/Paraformer vs Qwen3-ASR vs FireRedASR-AED）、配置块与少量参数。

因此把它们在**引擎面合并为单一条目**、按模型族分组展示，更贴合「同一引擎、不同模型」的真实心智。

> 关于「逆文本规整（ITN）是否通用配置」：经核实**并非通用** —— ITN 仅作用于 SenseVoice（`funasrUseItn` → sherpa `useInverseTextNormalization`），`qwenParams.ts` / `fireRedParams.ts` 均无 ITN（Qwen/FireRed 内部处理规整）。故合并后的「高级设置」MUST 按模型族上下文呈现，不能做成引擎级全局开关。

## What Changes

- **仅 UI 合并（后端不动）**：保留 `funasr` / `qwen` / `fireRedAsr` 三个 adapter id 与任务 `formData.transcriptionEngine` 取值不变（**零迁移、最低风险**）。合并只发生在引擎面的呈现层。
- **单一左栏条目 + 中性名 + 副标题**：引擎左栏用一个合并条目（中性名，如「本地多模型引擎」）+ 副标题列出 `FunASR · Qwen · FireRed`，让用户一眼知道它覆盖三类模型。
- **右栏：一张运行库卡 + 分组模型清单**：运行库管理只呈现一次；模型清单按 FunASR / Qwen / FireRed 分组（各组下是各自模型行：下载 / 导入 / 删除 / 换路径）。
- **模型族上下文的高级设置**：ITN 仅在 SenseVoice/FunASR 组出现；`numThreads` 等按组呈现；FireRed 段长安全闸等各自保留。
- **任务页模型选择器分组**：任务页「引擎 ▸ 模型」选择器把三族模型按族分组（底层仍写各自 `transcriptionEngine` id）。
- **不在本次范围**：不合并后端 adapter / 不改引擎 id / 不改运行库获取方式（内置 vs 下载属 `rebalance-runtime-packaging`）；不动 builtin / fasterWhisper / localCli 条目。

## Capabilities

### New Capabilities

<!-- 无新增能力；细化 engine-model-management 在「引擎面呈现」上的契约。 -->

### Modified Capabilities

- `engine-model-management`: 新增需求——sherpa 系引擎（funasr / qwen / fireRedAsr）在引擎面以**单一合并条目**呈现、按模型族分组、运行库卡只出现一次、高级设置按模型族上下文展示；底层引擎 id 不变。

## Impact

- **渲染层**：
  - `EngineModelTab.tsx`：`ENGINES` 左栏把 funasr/qwen/fireRedAsr 折叠为一个合并条目（UI 组 key，如 `sherpa`）；右栏渲染单张运行库卡 + 分组模型区；合并条目的就绪点 = 三族任一就绪。
  - 新增分组容器（如 `SherpaEngineGroupPanel`）：内联一份 `SherpaRuntimePanel` + 三族各自的高级设置（ITN 仅 SenseVoice）与模型分组（复用 `FunasrModelSection` / `QwenModelSection` / `FireRedModelSection` 或经 `ModelLibrarySection` 分组渲染）。
  - `EngineIcon.tsx`：为合并条目加图标。
  - 任务页模型选择器（`TaskConfigForm` 相关）：三族模型分组展示，底层仍映射到各自 `transcriptionEngine` id。
- **i18n**：`resources` namespace 新增合并条目中性名 + 副标题 + 分组标题；保留 funasr/qwen/fireRedAsr 各自既有键（仍被组内复用）。
- **不变**：三引擎 adapter、模型目录 / catalog、下载器、`formData.transcriptionEngine` 取值、`OverviewTab`（如仍存在）。
- **与其它变更的关系**：与 `rebalance-runtime-packaging` 正交（无论运行库内置或下载，合并后的运行库卡都只出现一次）；先做哪个都不阻塞。
