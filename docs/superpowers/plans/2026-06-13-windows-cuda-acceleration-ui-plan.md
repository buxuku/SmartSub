# Windows CUDA 加速模块 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构资源中心加速 Tab（`GpuAccelerationCard`），实现四区块布局 + CUDA 下载确认 Sheet，消除「下拉隐式下载」并 surfaced 完整/轻量版推荐。

**Architecture:** 将 1150 行单体 `GpuAccelerationCard.tsx` 拆为 `renderer/components/settings/gpu/*` 子组件；共享下载决策逻辑抽到 `gpuDownloadUtils.ts`；下载仅经 `CudaDownloadSheet` 发起；区块 C 仅切换已安装后端。主进程 IPC 不变。

**Tech Stack:** Nextron、React 18、shadcn/ui（Sheet/RadioGroup/Badge/Collapsible）、next-i18next、现有 IPC（`start-addon-download` / `select-addon-version` / `get-gpu-environment`）、`useLocalStorageState` hook。

**上游文档:** `docs/superpowers/specs/2026-06-13-windows-cuda-acceleration-ui-design.md`

**验证方式:** 本仓库无 renderer 单测框架。每任务跑 `npx tsc --noEmit -p renderer/tsconfig.json`（不新增错误）+ `yarn dev:cuda-sim` 手工冒烟（macOS 上模拟 Windows CUDA 环境）。

**提交说明:** 用户未要求自动 commit；每完成一个 Task 可询问是否提交。`git add` 仅加本 task 列出的文件，不用 `git add .`。

---

## 文件结构（实施前锁定）

| 文件                                                       | 职责                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `renderer/components/settings/gpu/gpuDownloadUtils.ts`     | 版本过滤、包类型默认、CTA 文案、DownloadSource localStorage key |
| `renderer/components/settings/gpu/CudaDownloadSheet.tsx`   | 下载确认 Sheet（版本/包类型/源/开始下载）                       |
| `renderer/components/settings/gpu/GpuStatusHero.tsx`       | 区块 A：状态卡 + 升级 CTA + 推荐理由                            |
| `renderer/components/settings/gpu/GpuModeSelector.tsx`     | 区块 B：加速模式三选一                                          |
| `renderer/components/settings/gpu/GpuBackendSwitcher.tsx`  | 区块 C：已安装后端 Radio + 下载链                               |
| `renderer/components/settings/gpu/GpuInstalledList.tsx`    | 区块 D：已安装列表 + 更新/删除                                  |
| `renderer/components/settings/gpu/GpuDiagnosticsPanel.tsx` | 区块 D：检测详情折叠                                            |
| `renderer/components/settings/gpu/GpuDownloadProgress.tsx` | 下载进度条（从 Card 抽出）                                      |
| `renderer/components/settings/gpu/types.ts`                | 共享 props 类型                                                 |
| `renderer/components/settings/GpuAccelerationCard.tsx`     | 容器：数据加载、编排、Sheet 状态                                |
| `renderer/components/settings/index.ts`                    | 导出不变（仍 export GpuAccelerationCard）                       |
| `renderer/public/locales/zh/settings.json`                 | +gpuAcceleration 新 key                                         |
| `renderer/public/locales/en/settings.json`                 | +gpuAcceleration 新 key                                         |

---

## Task 0: 类型检查基线

**Files:** 无改动

- [ ] **Step 0.1: 记录基线**

```bash
cd /Users/xiaodong/Documents/code/SmartSub
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

预期：记下 exit code 与已有错误数；后续任务以「不新增错误」为通过标准。

---

## Task 1: 共享工具与类型

**Files:**

- Create: `renderer/components/settings/gpu/types.ts`
- Create: `renderer/components/settings/gpu/gpuDownloadUtils.ts`

- [ ] **Step 1.1: 创建 `types.ts`**

```typescript
import type {
  AddonVariant,
  CudaVersion,
  DownloadSource,
  GpuEnvironment,
  GpuMode,
  AddonLoadResultInfo,
  AddonUpdateInfo,
  DownloadProgress,
} from '../../../../types/addon';

export interface InstalledAddonInfo {
  version: AddonVariant;
  info: {
    installedAt: string;
    remoteVersion: string;
    hasDlls: boolean;
    size: number;
  };
}

export type PackageEdition = 'full' | 'lite';

export interface CudaDownloadSheetState {
  open: boolean;
  /** 预填 CUDA 版本；null = 用 recommendation */
  presetVersion: CudaVersion | null;
}

export interface GpuAccelerationSharedProps {
  gpuEnv: GpuEnvironment;
  activeBackend: AddonLoadResultInfo | null;
  gpuMode: GpuMode;
  installedAddons: InstalledAddonInfo[];
  selectedVersion: AddonVariant | null;
  customAddonPath: string | null;
  updates: AddonUpdateInfo[];
  downloadProgress: DownloadProgress | null;
  downloadingVariant: AddonVariant | null;
  downloadSource: DownloadSource;
  onDownloadSourceChange: (source: DownloadSource) => void;
  onReload: (forceRefresh?: boolean) => void;
  onModeChange: (mode: GpuMode) => void;
  onSelectBackend: (variant: AddonVariant | null) => Promise<void>;
  onStartDownload: (
    variant: AddonVariant,
    type: 'node.gz' | 'tar.gz',
  ) => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onRemoveAddon: (variant: AddonVariant) => Promise<void>;
  onCheckUpdates: () => Promise<void>;
  onSelectCustomAddon: () => Promise<void>;
  onClearCustomAddon: () => Promise<void>;
  onCopyDiagnostics: () => Promise<void>;
  onOpenDownloadSheet: (presetVersion?: CudaVersion | null) => void;
  checkingUpdates: boolean;
}
```

- [ ] **Step 1.2: 创建 `gpuDownloadUtils.ts`**

```typescript
import {
  AVAILABLE_CUDA_VERSIONS,
  type CudaVersion,
  type GpuEnvironment,
} from '../../../../types/addon';
import type { PackageEdition } from './types';

const ADDON_DOWNLOAD_SOURCE_KEY = 'addonDownloadSource';

/** major.minor 比较，与 main/helpers/cudaUtils 逻辑对齐 */
function getMajorMinor(version: string): string {
  const parts = version.split('.');
  return `${parts[0] || '0'}.${parts[1] || '0'}`;
}

function compareMajorMinor(a: string, b: string): number {
  const pa = getMajorMinor(a).split('.').map(Number);
  const pb = getMajorMinor(b).split('.').map(Number);
  for (let i = 0; i < 2; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** 仅返回驱动兼容的 CUDA 版本（从高到低排序） */
export function getCompatibleCudaVersions(
  gpuEnv: GpuEnvironment,
): CudaVersion[] {
  const maxCuda = gpuEnv.nvidia?.gpuSupport.maxCudaVersion;
  if (!maxCuda) return [...AVAILABLE_CUDA_VERSIONS];
  return AVAILABLE_CUDA_VERSIONS.filter(
    (v) => compareMajorMinor(getMajorMinor(v), getMajorMinor(maxCuda)) <= 0,
  );
}

export function getDefaultPackageEdition(
  gpuEnv: GpuEnvironment,
): PackageEdition {
  const toolkitInstalled = gpuEnv.nvidia?.cudaToolkit.installed ?? false;
  return toolkitInstalled ? 'lite' : 'full';
}

export function editionToDownloadType(
  edition: PackageEdition,
): 'node.gz' | 'tar.gz' {
  return edition === 'full' ? 'tar.gz' : 'node.gz';
}

export function canDownloadLiteEdition(gpuEnv: GpuEnvironment): boolean {
  return gpuEnv.nvidia?.cudaToolkit.installed ?? false;
}

export function getRecommendedCudaVersion(
  gpuEnv: GpuEnvironment,
): CudaVersion | null {
  return gpuEnv.nvidia?.recommendation.recommendedVersion ?? null;
}

export function readPersistedDownloadSource(): 'github' | 'ghproxy' {
  if (typeof window === 'undefined') return 'github';
  const v = localStorage.getItem(ADDON_DOWNLOAD_SOURCE_KEY);
  return v === 'ghproxy' ? 'ghproxy' : 'github';
}

export function persistDownloadSource(source: 'github' | 'ghproxy'): void {
  localStorage.setItem(ADDON_DOWNLOAD_SOURCE_KEY, source);
}

export { ADDON_DOWNLOAD_SOURCE_KEY };
```

- [ ] **Step 1.3: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
```

预期：不新增错误。

---

## Task 2: i18n 文案

**Files:**

- Modify: `renderer/public/locales/zh/settings.json`（`gpuAcceleration` 节点内追加）
- Modify: `renderer/public/locales/en/settings.json`

- [ ] **Step 2.1: zh 追加 key**

在 `gpuAcceleration` 对象内追加（保留现有 key）：

```json
"upgradeToCudaWithDetails": "升级到 CUDA {{version}}（{{edition}} · {{sizeHint}}）",
"downloadSheetTitle": "下载 CUDA 加速包",
"downloadSheetReason": "推荐理由",
"selectCudaVersion": "CUDA 版本",
"selectPackageType": "包类型",
"fullEditionDesc": "内置 CUDA 运行时，开箱即用",
"liteEditionDesc": "体积小，需本机已安装 CUDA Toolkit",
"fullEditionSizeHint": "约 1.4 GB",
"liteEditionSizeHint": "约 150 MB",
"liteRequiresToolkit": "轻量版需要本机已安装 CUDA Toolkit",
"installCudaToolkit": "安装 CUDA Toolkit",
"startDownload": "开始下载",
"downloadCudaPack": "下载 CUDA 加速包",
"needCudaAcceleration": "需要更高性能的 CUDA 加速？",
"manageInstalled": "管理已安装包",
"switchMirrorAndRetry": "切换镜像并重试",
"moreOptions": "更多选项",
"currentBackend": "当前后端",
"compatibleOldDriver": "兼容旧驱动",
"customBackend": "自定义加速包"
```

- [ ] **Step 2.2: en 追加 key**

```json
"upgradeToCudaWithDetails": "Upgrade to CUDA {{version}} ({{edition}} · {{sizeHint}})",
"downloadSheetTitle": "Download CUDA Pack",
"downloadSheetReason": "Why this is recommended",
"selectCudaVersion": "CUDA Version",
"selectPackageType": "Package Type",
"fullEditionDesc": "Includes CUDA runtime, works out of the box",
"liteEditionDesc": "Smaller download, requires CUDA Toolkit on this machine",
"fullEditionSizeHint": "~1.4 GB",
"liteEditionSizeHint": "~150 MB",
"liteRequiresToolkit": "Lite edition requires CUDA Toolkit installed locally",
"installCudaToolkit": "Install CUDA Toolkit",
"startDownload": "Start Download",
"downloadCudaPack": "Download CUDA Pack",
"needCudaAcceleration": "Want higher-performance CUDA acceleration?",
"manageInstalled": "Manage installed packs",
"switchMirrorAndRetry": "Switch mirror and retry",
"moreOptions": "More Options",
"currentBackend": "Active Backend",
"compatibleOldDriver": "Compatible with older drivers",
"customBackend": "Custom addon"
```

- [ ] **Step 2.3: 校验 i18n**

```bash
yarn check:i18n
```

预期：zh/en settings 对称，无缺失 key。

---

## Task 3: CudaDownloadSheet 组件

**Files:**

- Create: `renderer/components/settings/gpu/CudaDownloadSheet.tsx`

- [ ] **Step 3.1: 实现 Sheet**

核心行为：

- Props: `open`, `onOpenChange`, `gpuEnv`, `downloadSource`, `onDownloadSourceChange`, `presetVersion`, `downloadingVariant`, `onConfirmDownload(variant, type)`, `disabled`
- 内部 state: `selectedVersion`（默认 `presetVersion ?? getRecommendedCudaVersion(gpuEnv)`），`selectedEdition`（默认 `getDefaultPackageEdition(gpuEnv)`）
- 版本区：`getCompatibleCudaVersions(gpuEnv)` 渲染为 button group；推荐项 Badge
- 包类型：两卡片 Radio；轻量版且 `!canDownloadLiteEdition` 时卡片 opacity-50 + 下方警告 + NVIDIA 链接（`openUrl('https://developer.nvidia.com/cuda-downloads')`）
- 下载源：两个 Radio `github` / `ghproxy`，变更时 `persistDownloadSource`
- 主按钮 disabled 当：`downloadingVariant` 非空，或选中 lite 且 toolkit 未安装
- 点击「开始下载」→ `onConfirmDownload(selectedVersion, editionToDownloadType(selectedEdition))` → `onOpenChange(false)`

使用组件：`Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetFooter`, `Button`, `Badge`, `Label`, `RadioGroup`, `RadioGroupItem`

Sheet 宽度：`className="sm:max-w-md w-full"`

- [ ] **Step 3.2: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
```

---

## Task 4: GpuStatusHero（区块 A）

**Files:**

- Create: `renderer/components/settings/gpu/GpuStatusHero.tsx`

- [ ] **Step 4.1: 实现 Hero**

从现有 `GpuAccelerationCard` 提取：

- `deriveStatus()` / `statusToneClasses` / `renderStatusIcon()` 移入或 import
- 展示 `gpuName`、驱动版本、降级错误、`updateDriverHint`
- `showUpgradeButton` 条件保持不变（N 卡 + 有推荐版本 + 非 CUDA active + 无 custom）
- CTA 文案改用 `upgradeToCudaWithDetails`：
  - `edition`: `fullEdition` / `liteEdition`（来自 `getDefaultPackageEdition`）
  - `sizeHint`: `fullEditionSizeHint` / `liteEditionSizeHint`
- CTA `onClick` → `onOpenDownloadSheet()`（不再直接 `handleDownload`）
- CTA `disabled` 当 `downloadingVariant` 非空
- 新增：`gpuEnv.nvidia.recommendation.reason` 一行（有值时显示）
- CUDA 已运行时：可选文字链 `manageInstalled` → `onManageInstalledClick()`（父组件展开区块 D）

- [ ] **Step 4.2: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
```

---

## Task 5: GpuModeSelector（区块 B）

**Files:**

- Create: `renderer/components/settings/gpu/GpuModeSelector.tsx`

- [ ] **Step 5.1: 抽出三卡片**

原 `modeOptions` map 逻辑原样移入；Props: `gpuMode`, `onModeChange`。

Section 标题：`modeTitle`；底部 `Separator` 与区块 C 分隔。

- [ ] **Step 5.2: 类型检查**

---

## Task 6: GpuBackendSwitcher（区块 C）

**Files:**

- Create: `renderer/components/settings/gpu/GpuBackendSwitcher.tsx`

- [ ] **Step 6.1: 实现 Radio 切换（仅已安装）**

构建 options 数组：

```typescript
type BackendOption = {
  id: string;
  label: string;
  variant: AddonVariant | null; // null = builtin vulkan
};

// 若 customAddonPath → 仅显示 custom 项（选中态，不可切）
// 若 builtinVulkanAvailable → { id: 'builtin-vulkan', label: vulkanBuiltin, variant: null }
// 若 isVariantInstalled('vulkan') → { id: 'vulkan', label: vulkanUserData, variant: 'vulkan' }
// installedAddons 中 CUDA 版本各一项
```

`onValueChange` → 调用 `onSelectBackend(variant)` **不下载**。

当前选中值推导（与现 `backendSelectValue` 一致）：

- custom → `'custom'`
- selectedVersion null → `'builtin-vulkan'`
- else → selectedVersion

**删除行为：** 未安装 CUDA 不出现在 Radio 中。

N 卡且 `canUseCuda`：组下方显示：

```tsx
<p className="text-xs text-muted-foreground">
  {t('needCudaAcceleration')}{' '}
  <button
    type="button"
    className="text-primary hover:underline"
    onClick={() => onOpenDownloadSheet()}
  >
    {t('downloadCudaPack')}
  </button>
</p>
```

- [ ] **Step 6.2: 类型检查**

---

## Task 7: GpuInstalledList + GpuDiagnosticsPanel + GpuDownloadProgress

**Files:**

- Create: `renderer/components/settings/gpu/GpuInstalledList.tsx`
- Create: `renderer/components/settings/gpu/GpuDiagnosticsPanel.tsx`
- Create: `renderer/components/settings/gpu/GpuDownloadProgress.tsx`

- [ ] **Step 7.1: GpuDownloadProgress**

从 `renderDownloadProgress()` 原样抽出；Props 同现有局部变量。

- [ ] **Step 7.2: GpuInstalledList**

移入：内置 Vulkan 行、userData 列表、check updates 按钮、删除 AlertDialog。

**变更：** 「更新」按钮 `onClick={() => onOpenDownloadSheet(addon.version as CudaVersion)}` 而非直接 download。

Vulkan 行的 update 仍 `onOpenDownloadSheet` 不适用 — vulkan 更新保持 `onStartDownload('vulkan', 'node.gz')` 或单独 prop `onUpdateVulkan`。

- [ ] **Step 7.3: GpuDiagnosticsPanel**

移入现有「检测详情」Collapsible 整块（`diagnosticsOpen` state 保留在 panel 内部）。

- [ ] **Step 7.4: 类型检查**

---

## Task 8: 重构 GpuAccelerationCard 容器

**Files:**

- Modify: `renderer/components/settings/GpuAccelerationCard.tsx`（大幅精简）

- [ ] **Step 8.1: 重写 Card 为编排层**

保留：数据 loading、`loadData`、IPC 订阅、`handleModeChange`、`handleDownload`、`handleCancelDownload`、`handleRemoveAddon`、custom addon handlers、`handleCheckUpdates`、`handleCopyDiagnostics`。

**修改 `handleDownload`：**

- 下载失败 toast 改为 action：

```typescript
toast.error(progress.error || t('gpuAcceleration.downloadFailed'), {
  action:
    downloadSource === 'github'
      ? {
          label: t('gpuAcceleration.switchMirrorAndRetry'),
          onClick: () => {
            setDownloadSource('ghproxy');
            persistDownloadSource('ghproxy');
            setSheetState({
              open: true,
              presetVersion:
                (downloadingVariantRef.current as CudaVersion) ?? null,
            });
          },
        }
      : undefined,
});
```

（在 progress error handler 中实现，而非 handleDownload 本身）

**新增 state：**

```typescript
const [downloadSource, setDownloadSource] = useState<DownloadSource>(() =>
  readPersistedDownloadSource(),
);
const [sheetState, setSheetState] = useState<CudaDownloadSheetState>({
  open: false,
  presetVersion: null,
});
const [moreOpen, setMoreOpen] = useState(false);
```

**新增 `handleSelectBackend`（替代 handleBackendSelect）：**

```typescript
const handleSelectBackend = async (variant: AddonVariant | null) => {
  if (customAddonPath) {
    await window?.ipc?.invoke('set-custom-addon-path', null);
    setCustomAddonPath(null);
  }
  await window?.ipc?.invoke('select-addon-version', variant);
  setSelectedVersion(variant);
  notifyGpuSettingsChanged();
  toast.success(t('gpuAcceleration.versionSelected'));
};
```

**删除：** `handleBackendSelect` 中对未安装 variant 调用 `handleDownload` 的分支；删除整个「高级选项」Collapsible 内联 JSX。

**渲染结构（`isDesktopGpuPlatform` 时）：**

```tsx
<GpuStatusHero ... onOpenDownloadSheet={(v) => setSheetState({ open: true, presetVersion: v ?? null })} />
<GpuDownloadProgress ... />
<GpuModeSelector ... />
<GpuBackendSwitcher ... onSelectBackend={handleSelectBackend} ... />
<Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
  <CollapsibleTrigger>{t('gpuAcceleration.moreOptions')}</CollapsibleTrigger>
  <CollapsibleContent>
    <GpuInstalledList ... />
    {/* custom addon 区块 — 从旧 advanced 移入 */}
    <GpuDiagnosticsPanel ... />
    {/* crashTip */}
  </CollapsibleContent>
</Collapsible>
<CudaDownloadSheet
  open={sheetState.open}
  onOpenChange={(open) => setSheetState((s) => ({ ...s, open }))}
  presetVersion={sheetState.presetVersion}
  ...
  onConfirmDownload={(variant, type) => handleDownload(variant, type)}
/>
```

**macOS（`!isDesktopGpuPlatform`）：** 仅渲染 StatusHero（无 upgrade CTA）+ GpuDiagnosticsPanel；不渲染 B/C/Sheet。

- [ ] **Step 8.2: 删除 Card 内已迁移的死代码**

移除未使用的 Select import、BACKEND 相关 dead code、`advancedOpen` state。

- [ ] **Step 8.3: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json
```

---

## Task 9: 手工冒烟验收

**Files:** 无

- [ ] **Step 9.1: 启动 CUDA 模拟**

```bash
yarn dev:cuda-sim
```

- [ ] **Step 9.2: 验收路径（对照 spec §8）**

1. 资源中心 → 加速 Tab
2. 状态 Hero 显示 `升级到 CUDA x.x（完整版 · 约 1.4 GB）` + 推荐理由
3. 点击 CTA → Sheet 打开；版本/包类型/下载源同屏；改下载源后关闭再开仍记住
4. 选轻量版 + Toolkit 未安装 → 开始下载 disabled + 警告
5. 开始下载 → Sheet 关闭 → Hero 下进度条
6. 区块 C：切换 Vulkan/CUDA（已安装）不触发下载
7. 区块 C「下载 CUDA 加速包」链打开 Sheet
8. 展开「更多」→ 已安装列表更新按钮打开 Sheet
9. （可选）断网模拟失败 → toast 含切换镜像

- [ ] **Step 9.3: 完整构建**

```bash
yarn build
```

预期：构建成功。

- [ ] **Step 9.4: 更新 spec 状态**

Modify: `docs/superpowers/specs/2026-06-13-windows-cuda-acceleration-ui-design.md` 首行状态改为 `已评审 · 实施中`。

---

## Plan 自检

| Spec 要求                | 对应 Task                                       |
| ------------------------ | ----------------------------------------------- |
| 四区块 A/B/C/D           | Task 4/5/6/7/8                                  |
| 下载 Sheet               | Task 3                                          |
| 禁止下拉下载             | Task 6 + 8（删除 handleBackendSelect 下载分支） |
| 推荐理由 surfaced        | Task 4                                          |
| 完整/轻量可选 + 默认推荐 | Task 3                                          |
| 下载源在 Sheet           | Task 3                                          |
| 失败切换镜像             | Task 8                                          |
| i18n                     | Task 2                                          |
| macOS 精简               | Task 8                                          |
| 组件拆分                 | Task 1–8 文件结构                               |

无 TBD / 无「类似 Task N」省略。

---

## 执行方式

Plan 已保存至 `docs/superpowers/plans/2026-06-13-windows-cuda-acceleration-ui-plan.md`。

**两种执行选项：**

1. **Subagent-Driven（推荐）** — 每 Task 派发 fresh subagent，任务间 review
2. **Inline Execution** — 本会话按 Task 顺序直接改代码，checkpoint Review

请选择执行方式。
