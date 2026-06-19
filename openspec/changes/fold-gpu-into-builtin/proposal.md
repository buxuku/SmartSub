## Why

「GPU 加速」当前是资源中心一个独立 Tab，但它本质上**只服务 builtin（whisper.cpp）一个引擎**：

- `GpuAccelerationCard` 全程管理的是 whisper.cpp 的 `addon` 变体（CUDA / Vulkan 版 `addon.node`），由 `builtinEngine.ts#loadWhisperAddon` 加载。
- funasr / qwen / fireRedAsr 目前是 **CPU-only**（`provider: 'cpu'`，cuda 仅「预留」）；faster-whisper 有**自己的** device 选择器（在其引擎面板内）。
- 因此一个全局「加速」Tab 会让用户误以为它**加速所有引擎**（实际不会）。

而 builtin 的引擎面板（`BuiltinPanel.tsx`）目前几乎是空的（只有一行说明）。把 GPU 加速折叠进 builtin 面板，既消除「全局加速」的误导（让作用域诚实——「GPU 加速作用于 builtin/whisper.cpp」），又恰好填充了空面板。

## What Changes

- **GPU 加速卡折叠进 builtin 引擎面板**：`BuiltinPanel` 成为 GPU 加速的承载位，沿用 `GpuAccelerationCard` 既有的渐进式披露：
  - **紧凑状态摘要**（`GpuStatusHero`）常驻可见；
  - **「管理 / 高级」内联折叠区**（默认收起）承载模式三选、后端切换、已装列表、自定义 addon、诊断；
  - **CUDA 下载选择器仍为 Sheet（抽屉），但从页面内打开**，绝不从弹窗内打开 —— **杜绝「弹窗里再开抽屉」的嵌套**（这是本次 UX 的关键约束）。
- **macOS 退化为状态行**：mac 仅显示 Metal/CoreML 状态，无下载流程，面板保持极轻。
- **顶栏加速指示器改向**：`Layout.tsx` 顶部 Zap 徽章从 `resources?tab=acceleration` 改为指向 builtin 引擎面板（引擎 Tab 并选中 builtin）。
- **过渡保留深链接**：原 `?tab=acceleration` 深链接做薄重定向到 builtin 引擎面板（独立的「加速」Tab 的最终移除与导航重构归 `split-resource-center-nav`）。
- **不在本次范围**：不改 GPU 检测 / addon 下载的底层 IPC 与数据结构；不动 faster-whisper 自身 device 设置；不改 sherpa 引擎（仍 CPU）。

## Capabilities

### New Capabilities

<!-- 无新增能力；细化 engine-model-management 在「加速管理归属」上的契约。 -->

### Modified Capabilities

- `engine-model-management`: 新增需求——GPU 加速（whisper.cpp 的 CUDA/Vulkan addon）管理 SHALL 归属 builtin 引擎面板，以渐进式披露内联呈现，且 MUST NOT 出现弹窗内再开抽屉的嵌套。

## Impact

- **渲染层**：
  - `BuiltinPanel.tsx`：渲染 GPU 加速（紧凑摘要 + 内联折叠「管理/高级」）。
  - `GpuAccelerationCard.tsx`：增加「内嵌引擎面板」紧凑变体（lead 用 `GpuStatusHero`，把 `GpuModeSelector`/`GpuBackendSwitcher`/已装/自定义/诊断收进默认折叠区）；`CudaDownloadSheet` 仍由页面内触发（非弹窗内）。
  - `AccelerationTab.tsx`：暂改为薄重定向到 builtin 引擎面板（最终随 `split-resource-center-nav` 移除）。
  - `Layout.tsx`：顶栏 Zap 徽章 `router.push` 目标改向 builtin 引擎面板。
- **i18n**：`settings`/`resources` namespace 复用既有 `gpuAcceleration.*` 文案；新增「在 builtin 面板内」的少量上下文文案（如折叠区标题）。
- **不变**：`get-gpu-environment` / addon 下载 / `active-backend-changed` 等 IPC 与事件、faster-whisper device 设置、sherpa 引擎。
- **依赖关系**：`split-resource-center-nav`（Q6）依赖本变更先腾空「加速」Tab；本变更可独立先行（builtin 面板先长出 GPU 能力，加速 Tab 暂以重定向兜底）。
