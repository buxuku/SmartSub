## Context

`GpuAccelerationCard` 管理 whisper.cpp 的 addon 变体（CUDA/Vulkan），仅 builtin 引擎经 `loadWhisperAddon` 消费它。其内部已是渐进式披露：

- 常驻：`GpuStatusHero`（状态 + 主 CTA）、`GpuDownloadProgress`；
- 桌面 GPU 平台：`GpuModeSelector` + `GpuBackendSwitcher`；
- `Collapsible`（"更多选项"）内：`GpuInstalledList` / `GpuCustomAddonSection` / `GpuDiagnosticsPanel`；
- `CudaDownloadSheet`：一个 Sheet（抽屉）。

`BuiltinPanel` 目前近乎空白，是天然承载位。

## Goals / Non-Goals

**Goals**

- 让加速作用域诚实：GPU 加速属于 builtin/whisper.cpp。
- 折叠进 builtin 面板而**不**让面板过重，且**不**产生弹窗↔抽屉嵌套。
- 顶栏指示器与深链接平滑改向。

**Non-Goals**

- 不改 GPU 检测 / addon 下载底层 IPC、数据结构、降级逻辑。
- 不动 faster-whisper device 设置、不改 sherpa 引擎加速能力。
- 不在本变更最终删除「加速」Tab（归 `split-resource-center-nav`）。

## Decisions

### D1 — 内联渐进式披露，全程不引入 Dialog（解决嵌套顾虑）

- 用户顾虑：若「管理」走 **Dialog**，而 Dialog 内点「下载 CUDA」又开 **Sheet**，则 Dialog→Sheet 嵌套（焦点/滚动/层级/关闭语义皆劣化）。
- 决策：**不引入任何 Dialog**。builtin 面板内：
  - 常驻紧凑 `GpuStatusHero`（状态 + 主 CTA）；
  - 一个**内联** `Collapsible`「GPU 加速 · 管理/高级」（默认收起）承载模式/后端/已装/自定义/诊断；
  - `CudaDownloadSheet` 仍是 Sheet，但**从页面内（hero / 已装列表）打开**——页面→抽屉是标准模式，非嵌套。
- 即：把现有卡片**整体平移**进 builtin 面板（它本就具备正确的披露结构），仅「lead 更紧凑 + 高级块默认收起」。

### D2 — `GpuAccelerationCard` 增加紧凑/内嵌变体

- 加一个变体（prop，如 `variant="embedded"`）：
  - 默认收起 `GpuModeSelector` + `GpuBackendSwitcher` + 现有"更多选项"，统一进一个「管理/高级」折叠区；
  - 顶部只留 `GpuStatusHero` 紧凑态 + 下载进度。
- 非内嵌（旧 settings 用法，若仍存在）保持原样，避免回归。

### D3 — 平台差异

- macOS：`isDesktopGpuPlatform=false`，仅 `GpuStatusHero`（Metal/CoreML 状态）+ 诊断，面板天然极轻。
- Windows/Linux + NVIDIA：完整流程仍在，但默认收起，不挤占 builtin 面板首屏。

### D4 — 顶栏指示器与深链接改向

- `Layout.tsx`：Zap 徽章 `router.push('resources?tab=acceleration')` → 指向 builtin 引擎面板（引擎 Tab + 选中 builtin；如已有 `engineModelSelectedEngine` localStorage，可写入 'builtin' 再跳）。
- `AccelerationTab.tsx`：暂改薄重定向到 builtin 引擎面板，保住外部书签/旧深链接；最终移除归 `split-resource-center-nav`。

## Risks / Trade-offs

- **builtin 面板在 NVIDIA 桌面变重**：默认收起高级块 + lead 紧凑 hero 缓解；与 faster-whisper 的 device 折叠区密度一致。
- **选中态联动**：从顶栏跳转需可靠选中 builtin（写 `engineModelSelectedEngine`=builtin 再导航）。
- **与导航重构的时序**：本变更让 builtin 先具备 GPU 能力、加速 Tab 暂重定向；`split-resource-center-nav` 再删 Tab，避免两变更相互阻塞。

## Migration Plan

1. `GpuAccelerationCard` 加 embedded 变体（紧凑 lead + 默认收起高级；Sheet 仍页面内触发）。
2. `BuiltinPanel` 渲染该变体。
3. `Layout` 顶栏徽章 + `AccelerationTab` 重定向改向 builtin 引擎面板。
4. 冒烟：mac 仅状态行；NVIDIA 桌面下载/切换/诊断全功能；CUDA Sheet 从页面打开无嵌套；顶栏徽章落到 builtin 面板。

## Open Questions

- builtin 面板里 GPU 折叠区的默认展开态：是否在「检测到可用 GPU 但未启用加速」时默认展开一次以引导？（倾向：默认收起，仅 hero 给 CTA。）
