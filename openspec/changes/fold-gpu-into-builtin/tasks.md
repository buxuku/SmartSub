## 1. GpuAccelerationCard 紧凑/内嵌变体

- [ ] 1.1 `GpuAccelerationCard.tsx` 增加 `variant="embedded"`（默认 `standalone` 保持旧行为）
- [ ] 1.2 embedded 下：lead 仅 `GpuStatusHero`（紧凑）+ `GpuDownloadProgress`；`GpuModeSelector`/`GpuBackendSwitcher`/`GpuInstalledList`/`GpuCustomAddonSection`/`GpuDiagnosticsPanel` 收进单个「管理 / 高级」`Collapsible`（默认收起）
- [ ] 1.3 确认 `CudaDownloadSheet` 由页面内（hero / 已装列表）触发，**不**位于任何 Dialog 内（核查无 Dialog 包裹）
- [ ] 1.4 macOS 分支（`!isDesktopGpuPlatform`）embedded 下仅状态 + 诊断，保持极轻

## 2. 折叠进 builtin 面板

- [ ] 2.1 `BuiltinPanel.tsx`：在说明下渲染 `<GpuAccelerationCard variant="embedded" />`
- [ ] 2.2 保持 `BuiltinPanel` 现有说明文案；GPU 区作为 builtin 运行时配置主体

## 3. 顶栏指示器与深链接改向

- [ ] 3.1 `Layout.tsx`：Zap 徽章 `router.push` 目标从 `resources?tab=acceleration` 改为 builtin 引擎面板（引擎 Tab；导航前写 `engineModelSelectedEngine='builtin'`）
- [ ] 3.2 `AccelerationTab.tsx`：暂改为薄重定向到 builtin 引擎面板（保住旧 `?tab=acceleration` 深链接）
- [ ] 3.3 核查其它跳 `?tab=acceleration` 的入口（如 `OverviewTab` 的加速卡 manage、迁移提示）一并改向

## 4. i18n

- [ ] 4.1 复用既有 `gpuAcceleration.*`；新增「GPU 加速 · 管理/高级」折叠区标题等少量上下文键（zh/en）
- [ ] 4.2 `node scripts/check-i18n.mjs` 通过

## 5. 校验

- [ ] 5.1 `npx tsc --noEmit`（renderer 用 `renderer/tsconfig.json`）全绿
- [ ] 5.2 冒烟（NVIDIA 桌面）：builtin 面板内 GPU 状态/模式/后端切换/已装/自定义/诊断全功能；CUDA 下载从页面打开为抽屉、**无弹窗内嵌套**
- [ ] 5.3 冒烟（macOS）：builtin 面板仅显示 Metal/CoreML 状态行，无下载流程
- [ ] 5.4 冒烟：顶栏 Zap 徽章点击落到 builtin 引擎面板并选中 builtin；旧 `?tab=acceleration` 深链接重定向正确
- [ ] 5.5 回归：builtin 转写按所选后端加载、降级 toast、`active-backend-changed` 刷新均不受影响
