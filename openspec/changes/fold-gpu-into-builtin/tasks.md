## 1. GpuAccelerationCard 紧凑/内嵌变体

- [x] 1.1 `GpuAccelerationCard.tsx` 增加 `variant`（`'standalone'` 默认保持旧行为 / `'embedded'`）
- [x] 1.2 embedded 下：lead 仅 `GpuStatusHero`（紧凑）+ `GpuDownloadProgress`；`GpuModeSelector`/`GpuBackendSwitcher`/`GpuInstalledList`/`GpuCustomAddonSection`/`GpuDiagnosticsPanel` 收进单个「管理 / 高级」`Collapsible`（默认收起）。子区块抽为元素变量，两变体共享同组 props 仅排布不同
- [x] 1.3 确认 `CudaDownloadSheet` 由页面内（hero / 已装列表）触发，**不**位于任何 Dialog 内（embedded 同样页面内触发，无 Dialog 包裹）
- [x] 1.4 macOS 分支（`!isDesktopGpuPlatform`）embedded 下仅状态 hero + 诊断，保持极轻

## 2. 折叠进 builtin 面板

- [x] 2.1 `BuiltinPanel.tsx`：在说明下（分隔线后）渲染 `<GpuAccelerationCard variant="embedded" />`
- [x] 2.2 保持 `BuiltinPanel` 现有说明文案；GPU 区作为 builtin 运行时配置主体

## 3. 顶栏指示器与深链接改向

- [x] 3.1 `Layout.tsx`：Zap 徽章 `router.push` 目标从 `resources?tab=acceleration` 改为 `resources?tab=engines`，导航前写 `engineModelSelectedView='builtin'`（新选中态 key）
- [x] 3.2 `AccelerationTab.tsx`：改为薄重定向（写 `engineModelSelectedView='builtin'` 后 `router.replace` 到 `?tab=engines`），保住旧 `?tab=acceleration` 深链接
- [x] 3.3 其它入口：`OverviewTab` 加速卡经 Tab 切换（`?tab=acceleration`）由 AccelerationTab 重定向兜底；`OnboardingDialog` 加速按钮直接改向 `?tab=engines`+builtin

## 4. i18n

- [x] 4.1 复用既有 `gpuAcceleration.*`；新增 `gpuAcceleration.manageAdvanced`（折叠区标题，zh/en）
- [x] 4.2 `node scripts/check-i18n.mjs` 通过

## 5. 校验

- [x] 5.1 `npx tsc --noEmit -p renderer/tsconfig.json`（改动文件零错误）全绿
- [ ] 5.2 冒烟（NVIDIA 桌面）：builtin 面板内 GPU 状态/模式/后端切换/已装/自定义/诊断全功能；CUDA 下载从页面打开为抽屉、**无弹窗内嵌套**（需运行 App）
- [ ] 5.3 冒烟（macOS）：builtin 面板仅显示 Metal/CoreML 状态行，无下载流程（需运行 App）
- [ ] 5.4 冒烟：顶栏 Zap 徽章点击落到 builtin 引擎面板并选中 builtin；旧 `?tab=acceleration` 深链接重定向正确（需运行 App）
- [ ] 5.5 回归：builtin 转写按所选后端加载、降级 toast、`active-backend-changed` 刷新均不受影响（需运行 App）
