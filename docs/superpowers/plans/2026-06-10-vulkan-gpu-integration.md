# Vulkan GPU 加速接入 — 实施计划

> 规格文档：`VULKAN_GPU_ACCELERATION_PLAN.md`（已评审通过，附录 C 为实施决策记录）
> 分支：`feat/vulkan-gpu`（当前已在此分支，设计文档已提交 947ce41）
> 日期：2026-06-10

## 目标

把 Vulkan 后端接入 SmartSub 的全链路：CI 预置 → 环境检测 → 下载/安装管理 variant 化 → 加载降级链重构（修复裸 dlopen）→ `gpuMode` 三态迁移 → 设置页 UI 重构 → 状态反馈（徽章/Toast）。

## 架构速览

- **新类型**：`AddonVariant = CudaVersion | 'vulkan'` 贯穿下载/安装/选择；`GpuMode = 'auto' | 'gpu-only' | 'cpu-only'` 取代 `useCuda`（旧键保留不删）。
- **新模块** `main/helpers/addonLoader.ts`：按矩阵生成候选 → 逐个 try/catch dlopen → 返回 `{ whisperAsync, backend, variant, source, fallback, ... }`；会话级缓存（缓存 key 含 gpuMode/selected/custom，设置变更自动失效）；降级事件推送（会话内同原因只一次）。
- **检测层**：`cudaUtils.ts` 扩展 `getGpuEnvironment()`（systeminformation 枚举 GPU 厂商 + Vulkan 运行库文件存在性检查 + 复用现有 NVIDIA 检测）。
- **加载候选链（win/linux auto 模式）**：custom → selected（CUDA 需 NVIDIA 驱动可用）→ userData vulkan → 内置 vulkan → 内置 CPU。`cpu-only` 直接内置 CPU；`gpu-only` 去掉 CPU 兜底、全失败时报错。macOS 维持现状（custom → CoreML → 内置 Metal/CPU）。
- **迁移**：主进程启动时 `settings.gpuMode` 不存在 → 写 `'auto'` + `gpuMigrationNotified=false`；渲染层一次性 toast 后置 true。

## 执行须知（每个任务都适用）

1. **git 卫生**：工作区有**不属于本次工作的脏文件**，永远不要 `git add -A` / `git add .`，只 add 计划中明确列出的路径。禁止触碰：
   - `extraResources/addons/addon.node`、`extraResources/addons/addon.coreml.node`（本地二进制，已 modified）
   - `release-notes/v2.16.0.md`（untracked）
2. **类型检查基线**（已验证）：

   - 主进程基线噪音仅来自 `parameterProcessor` 与 `__tests__`。每个主进程任务后运行：

     ```bash
     npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(main|types)/' | grep -v '__tests__' | grep -v 'parameterProcessor' || echo MAIN-OK
     ```

     期望输出仅 `MAIN-OK`。

   - 渲染层基线干净（排除 `__tests__`）。每个渲染层任务后运行：

     ```bash
     npx tsc --noEmit -p renderer/tsconfig.json 2>&1 | grep -v '__tests__' | grep 'error TS' || echo RENDERER-OK
     ```

     期望输出仅 `RENDERER-OK`。

3. **测试策略**（附录 C 决策 10）：不新增单测框架；门禁 = 上述 scoped typecheck + 最终 `yarn build` + 手动冒烟。
4. 提交信息用英文 conventional 风格（与仓库历史一致）。
5. `yarn dev` 正在终端 1 运行，主进程改动需重启 dev 进程才生效（最后冒烟时处理，过程中无需管它）。

---

## T0：预备 — 单独提交工作区已有的 workflow_dispatch 改动

`release.yml` 工作区有一处用户先前的未提交改动（`workflow_dispatch:` 触发器，共 2 行 + 注释）。T1 也要改这个文件，为避免混入，先把它作为独立 commit 落盘。

**步骤**

```bash
git diff .github/workflows/release.yml   # 确认 diff 仅为 workflow_dispatch 块
git add .github/workflows/release.yml
git commit -m "ci: allow manual release workflow dispatch"
```

> 注：附录 C 决策 3 说"无关改动不纳入本次提交"——这里以独立 commit 方式处理（不与 Vulkan 改动混合），该 commit 会随分支进入 PR。**此处理方式已在计划评审时向用户标注**，如用户不同意则改为：跳过 T0，T1 提交时接受 workflow_dispatch 一并入 commit。

---

## T1：Phase 0 — CI 预置 Vulkan addon + .gitignore

**文件**：`.github/workflows/release.yml`、`.gitignore`

`electron-builder.yml` 已确认零改动（`extraResources/addons/` 整目录拷贝，第 24-26/34-36/56-58 行）。

### 1a. matrix 增加 `vulkan_addon_name`

Windows 与 Linux 两个 matrix 项各加一行（macOS 两项不动）：

```yaml
# Windows x64 (通用版本，不包含 CUDA)
- os: windows-2022
  arch: x64
  os_build_arg: win
  addon_name: addon-windows-x64.node
  vulkan_addon_name: addon-windows-vulkan.node.gz
  artifact_suffix: windows-x64

# Linux x64 (通用版本，不包含 CUDA)
- os: ubuntu-22.04
  arch: x64
  os_build_arg: linux
  addon_name: addon-linux-x64.node
  vulkan_addon_name: addon-linux-vulkan.node.gz
  artifact_suffix: linux-x64
```

### 1b. 「Download addon」步骤追加下载与解压（该步骤本就是 `shell: bash`，全平台可用 gunzip）

在该步骤 run 脚本末尾（macOS CoreML 下载 if 块之后）追加：

```bash
          # Windows / Linux 额外下载 Vulkan 通用 GPU 包并解压
          if [[ -n "${{ matrix.vulkan_addon_name }}" ]]; then
            curl -L -o "temp-artifacts/${{ matrix.vulkan_addon_name }}" \
              "https://github.com/buxuku/whisper.cpp/releases/download/latest/${{ matrix.vulkan_addon_name }}"
            gunzip -c "temp-artifacts/${{ matrix.vulkan_addon_name }}" > "temp-artifacts/addon.vulkan.node"
          fi
```

### 1c. Prepare 步骤拷贝

「Prepare Windows addon」run 末尾（`node scripts/inject-build-info.js` 之前）加：

```powershell
          Copy-Item -Path "temp-artifacts/addon.vulkan.node" -Destination "extraResources/addons/addon.vulkan.node"
```

「Prepare Linux addon」run 末尾（inject-build-info 之前）加：

```bash
          cp temp-artifacts/addon.vulkan.node extraResources/addons/addon.vulkan.node
```

### 1d. `.gitignore` 末尾追加

```
extraResources/addons/addon.vulkan.node
```

**验证**：`yamllint` 不可用则目检缩进；`git diff` 确认仅上述 4 处。

**提交**

```bash
git add .github/workflows/release.yml .gitignore
git commit -m "ci: bundle vulkan addon into windows/linux installers"
```

---

## T2：addon 体系 variant 化（types + manager + downloader + versions + IPC + 旧 UI 引用同步）

> 本任务是原子改名（`CudaVersion` → `AddonVariant`、`cudaVersion` 字段 → `variant`），跨 6 个文件必须一次提交才能保持编译通过。

### 2a. `types/addon.ts`

(1) 在 `CudaVersion` 定义后新增：

```ts
/**
 * 全部加速包变体：CUDA 各版本 + Vulkan
 */
export const ALL_ADDON_VARIANTS = [
  ...AVAILABLE_CUDA_VERSIONS,
  'vulkan',
] as const;

export type AddonVariant = (typeof ALL_ADDON_VARIANTS)[number];

/**
 * GPU 加速模式（取代 useCuda 布尔开关）
 */
export type GpuMode = 'auto' | 'gpu-only' | 'cpu-only';

/**
 * GPU 厂商
 */
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
}

/**
 * 实际加载的 whisper 后端
 */
export type WhisperBackend =
  | 'cuda'
  | 'vulkan'
  | 'cpu'
  | 'metal'
  | 'coreml'
  | 'custom';

export type AddonSource = 'custom' | 'userData' | 'builtin';

/**
 * 单次候选加载失败记录
 */
export interface AddonLoadAttempt {
  backend: WhisperBackend;
  path: string;
  error: string;
  timestamp: string;
}

/**
 * 一次成功加载的结果（不含函数本体，可持久化/IPC 传输）
 */
export interface AddonLoadResultInfo {
  backend: WhisperBackend;
  variant: AddonVariant | null;
  source: AddonSource;
  path: string;
  /** 是否非首选候选（发生过降级） */
  fallback: boolean;
  failedAttempts: AddonLoadAttempt[];
  loadedAt: string;
}

/**
 * 加载历史条目（环形缓冲 10 条，诊断面板数据源）
 */
export interface AddonLoadHistoryEntry {
  backend: WhisperBackend;
  path: string;
  success: boolean;
  error?: string;
  timestamp: string;
}

/**
 * 降级事件（主进程 → 渲染层推送）
 */
export interface AddonFallbackEvent {
  expected: WhisperBackend;
  actual: WhisperBackend;
  reason: string;
}

/**
 * GPU 环境完整检测结果（跨厂商）
 */
export interface GpuEnvironment {
  /** 有效平台（含 dev 模拟） */
  platform: string;
  /** systeminformation 枚举的显卡列表 */
  gpus: GpuInfo[];
  /** Vulkan 运行库是否存在（仅 win/linux 有意义） */
  vulkanRuntime: boolean;
  /** 内置 vulkan addon 是否随包分发 */
  builtinVulkanAvailable: boolean;
  /** NVIDIA 完整检测结果（未检测到 N 卡时为 null） */
  nvidia: CudaEnvironment | null;
}
```

(2) 既有类型改名/放宽（精确替换）：

- `AddonConfig.selectedVersion: CudaVersion | null` → `selectedVersion: AddonVariant | null`
- `export type RemoteAddonVersions = Record<CudaVersion, RemoteAddonVersion>;` → `export type RemoteAddonVersions = Partial<Record<AddonVariant, RemoteAddonVersion>>;`
- `DownloadConfig`：`/** CUDA 版本 */ cudaVersion: CudaVersion;` → `/** 加速包变体 */ variant: AddonVariant;`
- `AddonUpdateInfo`：`/** CUDA 版本 */ cudaVersion: CudaVersion;` → `/** 加速包变体 */ variant: AddonVariant;`
- `DownloadState`：`/** CUDA 版本 */ cudaVersion: CudaVersion;` → `/** 加速包变体 */ variant: AddonVariant;`

### 2b. `main/helpers/addonManager.ts`

- import 改为：`import type { AddonConfig, InstalledAddon, AddonVariant } from '../../types/addon';` 与 `import { ALL_ADDON_VARIANTS } from '../../types/addon';`（不再用 `AVAILABLE_CUDA_VERSIONS`、`CudaVersion`）。
- 新增目录命名辅助并改写 `getAddonVersionDir`：

```ts
/**
 * 变体目录名：cuda-1240 / vulkan
 */
export function getVariantDirName(variant: AddonVariant): string {
  return variant === 'vulkan' ? 'vulkan' : `cuda-${variant.replace(/\./g, '')}`;
}

/**
 * 获取特定变体的 addon 目录路径
 */
export function getAddonVersionDir(variant: AddonVariant): string {
  return path.join(getAddonsDir(), getVariantDirName(variant));
}
```

- 全文件签名机械替换 `CudaVersion` → `AddonVariant`（涉及：`isAddonInstalled`、`getInstalledAddons` 返回类型、`getAddonSize`、`registerInstalledAddon`、`selectAddonVersion`、`getSelectedAddonVersion`、`getAddonPath`、`removeAddon`、`backupAddon`、`restoreAddonBackup`、`cleanupBackup`、`getAddonSummary` 返回类型）。
- `getInstalledAddons` 的遍历：`for (const version of AVAILABLE_CUDA_VERSIONS)` → `for (const version of ALL_ADDON_VARIANTS)`。
- `backupAddon` / `restoreAddonBackup` / `cleanupBackup` 中备份路径 `` `cuda-${version.replace(/\./g, '')}_backup` `` 统一替换为 `` `${getVariantDirName(version)}_backup` ``（共 3 处）。

### 2c. `main/helpers/addonDownloader.ts`

- import 类型行：`CudaVersion` → `AddonVariant`；新增 `import { getAddonVersionDir } from './addonManager';`
- `getAddonFileName` 整体替换为：

```ts
/**
 * 获取加速包文件名
 */
export function getAddonFileName(
  variant: AddonVariant,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const platform = getEffectivePlatform();
  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const osName = platform === 'win32' ? 'windows' : 'linux';

  if (variant === 'vulkan') {
    // Vulkan 无运行时依赖，仅提供 node.gz 单文件包
    if (downloadType === 'tar.gz') {
      throw new Error('Vulkan addon only provides node.gz package');
    }
    return `addon-${osName}-vulkan.node.gz`;
  }

  const versionNum = variant.replace(/\./g, '').slice(0, 4);
  return downloadType === 'tar.gz'
    ? `${osName}-cuda-${versionNum}-optimized.tar.gz`
    : `addon-${osName}-cuda-${versionNum}-optimized.node.gz`;
}
```

- `getDownloadUrl(source, cudaVersion, downloadType)` 参数改 `variant: AddonVariant`（内部传给 `getAddonFileName`）。
- `download(source, cudaVersion, downloadType)` → `download(source, variant, downloadType)`；目录构造改为单一来源：

```ts
const addonsDir = path.join(app.getPath('userData'), 'addons');
const versionDir = getAddonVersionDir(variant);
```

temp 文件名 `` `temp-${cudaVersion.replace(/\./g, '')}` `` → `` `temp-${variant.replace(/\./g, '')}` ``（'vulkan' → `temp-vulkan`，天然兼容）。

- `downloadFile` 的 `cudaVersion: CudaVersion` 参数 → `variant: AddonVariant`；构造 `DownloadState` 时字段 `cudaVersion,` → `variant,`；递归重定向调用同步改名。
- `readDownloadState` 增加旧字段兼容映射（解析后）：

```ts
const parsed = JSON.parse(content);
// 兼容旧版字段名 cudaVersion（v2.16 之前的断点续传状态文件）
if (parsed && parsed.cudaVersion && !parsed.variant) {
  parsed.variant = parsed.cudaVersion;
  delete parsed.cudaVersion;
}
return parsed;
```

### 2d. `main/helpers/addonVersions.ts`

- import 类型行 `CudaVersion` → `AddonVariant`。
- `checkVersionUpdate(version: CudaVersion)` → `(variant: AddonVariant)`，函数体内 `version` 全部改 `variant`，返回对象字段 `cudaVersion: version` → `variant`（dev 强制更新分支同改）。
- `getRemoteVersionInfo` / `getVersionChecksum` 参数同改 `variant: AddonVariant`。
- （内置 Vulkan 版本比较在 T5 之后用到，本任务一并加上）文件末尾新增：

```ts
import { getBuildInfo } from './buildInfo';

/**
 * 内置 Vulkan addon 的版本号（取 CI 注入的构建日期，如 "2026.06.10"）
 * 开发环境无 buildInfo 时返回 null（跳过更新提示）
 */
export function getBuiltinVulkanVersion(): string | null {
  const buildInfo = getBuildInfo();
  if (!buildInfo?.buildDate) {
    return null;
  }
  return buildInfo.buildDate.split('T')[0].replace(/-/g, '.');
}
```

（import 语句放到文件顶部 import 区。）

> 注意：`checkAllUpdates` 的「内置 Vulkan 更新检测」依赖 `getBuiltinVulkanAddonPath`（T4 才加入 cudaUtils）。**为保证 T2 单独可编译，该追加块放在 T4 步骤 4c 实施**。T2 阶段 `checkAllUpdates` 只做类型改名。

### 2e. `main/helpers/ipcAddonHandlers.ts`

- import 类型行 `CudaVersion` → `AddonVariant`。
- `'select-addon-version'` handler 参数 `version: CudaVersion` → `version: AddonVariant`。
- `'start-addon-download'` handler 内 `config.cudaVersion` 全部 → `config.variant`（共 4 处：download 调用、getRemoteVersionInfo、registerInstalledAddon、selectAddonVersion、日志字符串）。
- `'remove-addon'` 参数 → `AddonVariant`。
- `'get-addon-download-url'` 参数解构 `{ source, cudaVersion, type }` → `{ source, variant, type }`，类型注解同步，`getDownloadUrl(source, variant, type)`。

### 2f. 旧 UI 引用同步（保持编译，T7 会整体重写此文件）

`renderer/components/settings/GpuAccelerationCard.tsx` 共 3 处：

- L268-272 `'start-addon-download'` 载荷：`cudaVersion: version,` → `variant: version,`
- L593-595 `updates.find((u) => u.cudaVersion === version && u.hasUpdate)` → `u.variant === version`
- L309-311 `handleCheckUpdates` 内 `updateInfo?.some((u: AddonUpdateInfo) => u.hasUpdate)` 无字段引用，不动。

**验证**：主进程 + 渲染层两条 scoped typecheck 均须 OK。

**提交**

```bash
git add types/addon.ts main/helpers/addonManager.ts main/helpers/addonDownloader.ts main/helpers/addonVersions.ts main/helpers/ipcAddonHandlers.ts renderer/components/settings/GpuAccelerationCard.tsx
git commit -m "refactor: generalize addon pipeline from CudaVersion to AddonVariant (vulkan-ready)"
```

---

## T3：store 增加 gpuMode + 一次性迁移

### 3a. `main/helpers/store/types.ts`

顶部 import 增加：

```ts
import {
  GpuMode,
  AddonLoadResultInfo,
  AddonLoadHistoryEntry,
} from '../../../types/addon';
```

`settings` 内 `useCuda: boolean;` 之后增加：

```ts
    /** GPU 加速模式（取代 useCuda；useCuda 保留仅为回滚安全） */
    gpuMode?: GpuMode;
    /** gpuMode 迁移一次性通知标记：false=待通知，true=已通知 */
    gpuMigrationNotified?: boolean;
```

`logs: LogEntry[];` 之后（顶层）增加：

```ts
  lastAddonLoadResult?: AddonLoadResultInfo;
  addonLoadHistory?: AddonLoadHistoryEntry[];
```

### 3b. `main/helpers/store/index.ts`

defaults.settings 内 `useCuda: true,` 之后加一行：

```ts
      gpuMode: 'auto' as const,
```

> electron-store 的 defaults 是**顶层 key 浅合并**：新装用户 `settings.gpuMode === 'auto'`（不触发迁移通知）；老用户磁盘上的 settings 对象没有 gpuMode → undefined → 触发 3c 迁移。

### 3c. `main/helpers/ipcStoreHandlers.ts`

`setupStoreHandlers()` 函数体最前面（`getAndInitializeProviders()` 调用之前）插入：

```ts
// gpuMode 一次性迁移（附录 C 决策 2/7）：
// 老用户（settings 中无 gpuMode）统一迁移为 'auto'，并标记待通知；
// 新装用户由 store defaults 提供 gpuMode='auto'，不会进入此分支。
const currentSettings = store.get('settings');
if (currentSettings && currentSettings.gpuMode === undefined) {
  store.set('settings', {
    ...currentSettings,
    gpuMode: 'auto',
    gpuMigrationNotified: false,
  });
  logMessage(
    `Migrated GPU settings: useCuda=${currentSettings.useCuda} -> gpuMode=auto`,
    'info',
  );
}
```

**验证**：主进程 scoped typecheck OK。

**提交**

```bash
git add main/helpers/store/types.ts main/helpers/store/index.ts main/helpers/ipcStoreHandlers.ts
git commit -m "feat: add gpuMode setting with one-time migration from useCuda"
```

---

## T4：检测层 — getGpuEnvironment

**文件**：`main/helpers/cudaUtils.ts`（扩展，不改名）、`main/helpers/addonVersions.ts`（补 T2 留下的内置 Vulkan 更新检测）

### 4a. cudaUtils 顶部 import 增加

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as si from 'systeminformation';
import { getExtraResourcesPath } from './utils';
```

类型 import 行增加 `GpuEnvironment, GpuInfo, GpuVendor`。

> 循环依赖检查（已确认安全）：`utils.ts` 不 import cudaUtils；`systeminformation` 为纯 JS 依赖（package.json ^5.27.7 已存在）。

### 4b. cudaUtils 文件末尾追加

```ts
/**
 * 归一化 GPU 厂商
 */
function normalizeGpuVendor(vendor: string, model: string): GpuVendor {
  const s = `${vendor} ${model}`.toLowerCase();
  if (
    s.includes('nvidia') ||
    s.includes('geforce') ||
    s.includes('quadro') ||
    s.includes('tesla')
  ) {
    return 'nvidia';
  }
  if (
    s.includes('amd') ||
    s.includes('radeon') ||
    s.includes('advanced micro')
  ) {
    return 'amd';
  }
  if (s.includes('intel')) {
    return 'intel';
  }
  if (s.includes('apple')) {
    return 'apple';
  }
  return 'unknown';
}

/**
 * 枚举显卡（systeminformation，跨平台），带 10s 超时与 dev 模拟
 */
async function detectGpus(): Promise<GpuInfo[]> {
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_SIMULATE_GPU_VENDOR
  ) {
    const vendor = process.env.DEV_SIMULATE_GPU_VENDOR as GpuVendor;
    return [{ name: `Simulated ${vendor.toUpperCase()} GPU`, vendor }];
  }

  try {
    const graphics = await Promise.race([
      si.graphics(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GPU detection timeout')), 10000),
      ),
    ]);
    return (graphics.controllers || [])
      .filter((c) => c.model || c.vendor)
      .map((c) => ({
        name: c.model || c.vendor || 'Unknown GPU',
        vendor: normalizeGpuVendor(c.vendor || '', c.model || ''),
      }));
  } catch (error) {
    logMessage(`GPU enumeration failed: ${error}`, 'warning');
    return [];
  }
}

/**
 * 检测 Vulkan 运行库是否存在（纯文件检查，毫秒级，不调用 vulkaninfo）
 */
export function detectVulkanRuntime(): boolean {
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_SIMULATE_VULKAN
  ) {
    return process.env.DEV_SIMULATE_VULKAN === 'true';
  }
  // dev 平台模拟时本机文件检查无意义，默认按可用处理（可用 DEV_SIMULATE_VULKAN=false 覆盖）
  if (getDevSimulationConfig()?.enabled) {
    return true;
  }

  const platform = getEffectivePlatform();
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return fs.existsSync(path.join(systemRoot, 'System32', 'vulkan-1.dll'));
  }
  if (platform === 'linux') {
    const commonPaths = [
      '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
      '/usr/lib64/libvulkan.so.1',
      '/usr/lib/libvulkan.so.1',
    ];
    if (commonPaths.some((p) => fs.existsSync(p))) {
      return true;
    }
    try {
      const out = execSync('ldconfig -p', { encoding: 'utf8', timeout: 5000 });
      return out.includes('libvulkan.so.1');
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 内置 Vulkan addon 路径（CI 预置；macOS / 开发环境通常不存在）
 */
export function getBuiltinVulkanAddonPath(): string {
  return path.join(getExtraResourcesPath(), 'addons', 'addon.vulkan.node');
}

let cachedGpuEnvironment: GpuEnvironment | null = null;

/**
 * 获取完整 GPU 环境（跨厂商）。结果会话级缓存，forceRefresh 重新检测。
 */
export async function getGpuEnvironment(
  forceRefresh = false,
): Promise<GpuEnvironment> {
  if (cachedGpuEnvironment && !forceRefresh) {
    return cachedGpuEnvironment;
  }

  const platform = getEffectivePlatform();
  const gpus = await detectGpus();
  const vulkanRuntime = isPlatformCudaCapable() ? detectVulkanRuntime() : false;
  const builtinVulkanAvailable =
    isPlatformCudaCapable() && fs.existsSync(getBuiltinVulkanAddonPath());

  // NVIDIA 详细检测：检测到 N 卡、枚举失败（空列表，nvidia-smi 兜底）或 dev 模拟时执行
  const hasNvidia = gpus.some((g) => g.vendor === 'nvidia');
  const shouldProbeNvidia =
    isPlatformCudaCapable() &&
    (hasNvidia || gpus.length === 0 || !!getDevSimulationConfig()?.enabled);
  const nvidia = shouldProbeNvidia ? getCudaEnvironment() : null;

  cachedGpuEnvironment = {
    platform,
    gpus,
    vulkanRuntime,
    builtinVulkanAvailable,
    nvidia,
  };
  logMessage(
    `GPU Environment: ${JSON.stringify({ ...cachedGpuEnvironment, nvidia: nvidia ? 'detected' : null })}`,
    'info',
  );
  return cachedGpuEnvironment;
}

export function clearGpuEnvironmentCache(): void {
  cachedGpuEnvironment = null;
}
```

### 4c. 补 `addonVersions.ts` 的内置 Vulkan 更新检测

顶部 import 增加：

```ts
import * as fs from 'fs';
import { isAddonInstalled } from './addonManager';
import { isPlatformCudaCapable, getBuiltinVulkanAddonPath } from './cudaUtils';
```

（`getBuildInfo` import 已在 T2 加。`addonManager` 已有 import 行的话合并即可。）

`checkAllUpdates()` 的 `return updates;` 之前插入：

```ts
// 内置 Vulkan（尚未下载到 userData 时）也参与更新检测：
// 远程版本比构建日期新 → 提示可下载更新版到 userData 覆盖内置
if (
  isPlatformCudaCapable() &&
  !isAddonInstalled('vulkan') &&
  fs.existsSync(getBuiltinVulkanAddonPath())
) {
  const builtinVersion = getBuiltinVulkanVersion();
  if (builtinVersion) {
    const remoteVersions = await fetchRemoteVersions();
    const remoteVulkan = remoteVersions?.vulkan;
    if (remoteVulkan) {
      const hasUpdate =
        normalizeVersion(remoteVulkan.version) >
        normalizeVersion(builtinVersion);
      if (hasUpdate) {
        updates.push({
          variant: 'vulkan',
          hasUpdate: true,
          localVersion: builtinVersion,
          remoteVersion: remoteVulkan.version,
          updateNotes: remoteVulkan.updateNotes,
        });
      }
    }
  }
}
```

**验证**：主进程 scoped typecheck OK。

**提交**

```bash
git add main/helpers/cudaUtils.ts main/helpers/addonVersions.ts
git commit -m "feat: cross-vendor GPU environment detection (vendors + vulkan runtime)"
```

---

## T5：加载降级链（核心）— addonLoader + whisper + subtitleGenerator + 新 IPC

### 5a. 新建 `main/helpers/addonLoader.ts`（完整文件）

```ts
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { store, logMessage } from './storeManager';
import { getExtraResourcesPath, isAppleSilicon } from './utils';
import {
  getEffectivePlatform,
  getGpuEnvironment,
  getBuiltinVulkanAddonPath,
} from './cudaUtils';
import {
  getSelectedAddonVersion,
  isAddonInstalled,
  getAddonVersionDir,
  hasDependentLibs,
  getCustomAddonPath,
} from './addonManager';
import type {
  AddonVariant,
  GpuMode,
  WhisperBackend,
  AddonSource,
  AddonLoadAttempt,
  AddonLoadResultInfo,
  AddonFallbackEvent,
  AddonLoadHistoryEntry,
} from '../../types/addon';

type WhisperFn = (
  params: Record<string, unknown>,
  callback: (error: Error | null, result?: unknown) => void,
) => void;

export type WhisperAsyncFn = (params: Record<string, unknown>) => Promise<any>;

export interface AddonLoadResult extends AddonLoadResultInfo {
  whisperAsync: WhisperAsyncFn;
}

export interface LoadContext {
  gpuMode: GpuMode;
  /** Apple Silicon 且当前模型存在 encoder（CoreML 可用） */
  coremlEligible: boolean;
}

interface AddonCandidate {
  backend: WhisperBackend;
  variant: AddonVariant | null;
  source: AddonSource;
  path: string;
}

let cachedResult: AddonLoadResult | null = null;
let cachedKey: string | null = null;
const notifiedFallbackReasons = new Set<string>();
let fallbackNotifier: ((event: AddonFallbackEvent) => void) | null = null;
let loadResultNotifier: ((info: AddonLoadResultInfo) => void) | null = null;

export function setFallbackNotifier(
  fn: (event: AddonFallbackEvent) => void,
): void {
  fallbackNotifier = fn;
}

export function setLoadResultNotifier(
  fn: (info: AddonLoadResultInfo) => void,
): void {
  loadResultNotifier = fn;
}

export function clearAddonLoadCache(): void {
  cachedResult = null;
  cachedKey = null;
}

function builtinAddonPath(file: string): string {
  return path.join(getExtraResourcesPath(), 'addons', file);
}

/**
 * 设置动态链接库搜索路径（必须在 dlopen 之前调用）
 */
function setupLibraryPath(addonDir: string): void {
  const platform = getEffectivePlatform();
  const absoluteAddonDir = path.resolve(addonDir);

  if (platform === 'win32') {
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(absoluteAddonDir)) {
      process.env.PATH = `${absoluteAddonDir};${currentPath}`;
      logMessage(`Added ${absoluteAddonDir} to PATH for DLL loading`, 'info');
    }
  } else if (platform === 'linux') {
    const currentLdPath = process.env.LD_LIBRARY_PATH || '';
    if (!currentLdPath.includes(absoluteAddonDir)) {
      process.env.LD_LIBRARY_PATH = `${absoluteAddonDir}:${currentLdPath}`;
      logMessage(
        `Added ${absoluteAddonDir} to LD_LIBRARY_PATH for SO loading`,
        'info',
      );
    }
  }
}

/**
 * 按 4.1 推荐矩阵生成加载候选列表
 *
 * win/linux auto：custom → selected（CUDA 需 N 卡驱动可用）→ userData vulkan → 内置 vulkan → 内置 CPU
 * win/linux gpu-only：同 auto 但去掉内置 CPU
 * win/linux cpu-only：仅内置 CPU
 * darwin：custom → CoreML（可用时）→ 内置（arm64 为 Metal，intel 为 CPU），不受 gpuMode 影响
 */
async function resolveCandidates(ctx: LoadContext): Promise<AddonCandidate[]> {
  const platform = getEffectivePlatform();
  const candidates: AddonCandidate[] = [];
  const builtinDefault: AddonCandidate = {
    backend: platform === 'darwin' && isAppleSilicon() ? 'metal' : 'cpu',
    variant: null,
    source: 'builtin',
    path: builtinAddonPath('addon.node'),
  };

  if (platform === 'darwin') {
    const customPath = getCustomAddonPath();
    if (customPath) {
      candidates.push({
        backend: 'custom',
        variant: null,
        source: 'custom',
        path: customPath,
      });
    }
    if (ctx.coremlEligible) {
      candidates.push({
        backend: 'coreml',
        variant: null,
        source: 'builtin',
        path: builtinAddonPath('addon.coreml.node'),
      });
    }
    candidates.push(builtinDefault);
    return candidates;
  }

  if (ctx.gpuMode === 'cpu-only') {
    return [builtinDefault];
  }

  // custom 无条件最高优先级（修复旧版非 NVIDIA 环境忽略自定义路径的 bug）
  const customPath = getCustomAddonPath();
  if (customPath) {
    candidates.push({
      backend: 'custom',
      variant: null,
      source: 'custom',
      path: customPath,
    });
  }

  const gpuEnv = await getGpuEnvironment();
  const selected = getSelectedAddonVersion();

  if (selected && isAddonInstalled(selected)) {
    if (selected === 'vulkan') {
      candidates.push({
        backend: 'vulkan',
        variant: 'vulkan',
        source: 'userData',
        path: path.join(getAddonVersionDir('vulkan'), 'addon.node'),
      });
    } else if (gpuEnv.nvidia?.gpuSupport.supported) {
      candidates.push({
        backend: 'cuda',
        variant: selected,
        source: 'userData',
        path: path.join(getAddonVersionDir(selected), 'addon.node'),
      });
    } else {
      logMessage(
        `Selected CUDA addon ${selected} skipped: no NVIDIA GPU detected`,
        'warning',
      );
    }
  }

  // 已下载到 userData 的 Vulkan（比内置新），未被 selected 命中时作为次级候选
  if (selected !== 'vulkan' && isAddonInstalled('vulkan')) {
    candidates.push({
      backend: 'vulkan',
      variant: 'vulkan',
      source: 'userData',
      path: path.join(getAddonVersionDir('vulkan'), 'addon.node'),
    });
  }

  // 内置 Vulkan：不预过滤 vulkanRuntime（检测仅供 UI 诊断），由 dlopen try/catch 兜底
  const builtinVulkan = getBuiltinVulkanAddonPath();
  if (fs.existsSync(builtinVulkan)) {
    candidates.push({
      backend: 'vulkan',
      variant: 'vulkan',
      source: 'builtin',
      path: builtinVulkan,
    });
  }

  if (ctx.gpuMode === 'auto') {
    candidates.push(builtinDefault);
  }

  return candidates;
}

/**
 * 尝试加载单个候选（dlopen 包 try/catch 由调用方负责）
 */
function tryLoadCandidate(candidate: AddonCandidate): WhisperFn {
  if (!fs.existsSync(candidate.path)) {
    throw new Error(`Addon not found: ${candidate.path}`);
  }
  const dir = path.dirname(candidate.path);
  if (hasDependentLibs(dir)) {
    setupLibraryPath(dir);
  }
  const module = { exports: { whisper: null } };
  process.dlopen(module, candidate.path);
  if (typeof module.exports.whisper !== 'function') {
    throw new Error(`Addon loaded but exports no whisper(): ${candidate.path}`);
  }
  return module.exports.whisper as WhisperFn;
}

function pushHistory(entry: AddonLoadHistoryEntry): void {
  const history: AddonLoadHistoryEntry[] = store.get('addonLoadHistory') || [];
  history.push(entry);
  while (history.length > 10) {
    history.shift();
  }
  store.set('addonLoadHistory', history);
}

function notifyFallback(
  expected: AddonCandidate,
  actual: AddonCandidate,
  attempts: AddonLoadAttempt[],
): void {
  const reasonKey = `${expected.backend}->${actual.backend}:${attempts[0]?.error || ''}`;
  if (notifiedFallbackReasons.has(reasonKey)) {
    return;
  }
  notifiedFallbackReasons.add(reasonKey);
  fallbackNotifier?.({
    expected: expected.backend,
    actual: actual.backend,
    reason: attempts[0]?.error || 'unknown',
  });
}

/**
 * 加载最优可用 addon（核心入口）
 *
 * 候选逐个 try/catch dlopen；成功结果会话级缓存（缓存 key 覆盖全部决策输入，
 * 设置变更后 key 变化自动重新解析，无需手动失效）。
 */
export async function loadBestAddon(
  ctx: LoadContext,
): Promise<AddonLoadResult> {
  const cacheKey = JSON.stringify({
    gpuMode: ctx.gpuMode,
    coremlEligible: ctx.coremlEligible,
    selected: getSelectedAddonVersion(),
    custom: getCustomAddonPath(),
  });
  if (cachedResult && cachedKey === cacheKey) {
    return cachedResult;
  }

  const candidates = await resolveCandidates(ctx);
  if (candidates.length === 0) {
    throw new Error('No addon candidates available');
  }
  logMessage(
    `Addon candidates: ${candidates.map((c) => `${c.backend}(${c.source})`).join(' -> ')}`,
    'info',
  );

  const failedAttempts: AddonLoadAttempt[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const whisper = tryLoadCandidate(candidate);
      const loadedAt = new Date().toISOString();
      const result: AddonLoadResult = {
        whisperAsync: promisify(whisper) as WhisperAsyncFn,
        backend: candidate.backend,
        variant: candidate.variant,
        source: candidate.source,
        path: candidate.path,
        fallback: i > 0,
        failedAttempts,
        loadedAt,
      };
      logMessage(
        `Whisper addon loaded: backend=${candidate.backend} source=${candidate.source} path=${candidate.path} fallback=${result.fallback}`,
        'info',
      );
      pushHistory({
        backend: candidate.backend,
        path: candidate.path,
        success: true,
        timestamp: loadedAt,
      });
      const { whisperAsync: _fn, ...info } = result;
      store.set('lastAddonLoadResult', info);
      loadResultNotifier?.(info);
      if (result.fallback) {
        notifyFallback(candidates[0], candidate, failedAttempts);
      }
      cachedResult = result;
      cachedKey = cacheKey;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMessage(
        `Failed to load addon candidate (${candidate.backend} @ ${candidate.path}): ${message}`,
        'warning',
      );
      const timestamp = new Date().toISOString();
      failedAttempts.push({
        backend: candidate.backend,
        path: candidate.path,
        error: message,
        timestamp,
      });
      pushHistory({
        backend: candidate.backend,
        path: candidate.path,
        success: false,
        error: message,
        timestamp,
      });
    }
  }

  const summary = failedAttempts
    .map((a) => `${a.backend}: ${a.error}`)
    .join('; ');
  if (ctx.gpuMode === 'gpu-only') {
    throw new Error(
      `GPU acceleration unavailable in GPU-only mode. ${summary}`,
    );
  }
  throw new Error(`Failed to load whisper addon. ${summary}`);
}

/**
 * 当前生效的后端（无内存缓存时回退到持久化的最近一次结果）
 */
export function getActiveBackend(): AddonLoadResultInfo | null {
  if (cachedResult) {
    const { whisperAsync: _fn, ...info } = cachedResult;
    return info;
  }
  return store.get('lastAddonLoadResult') || null;
}
```

> 循环依赖检查：addonLoader → storeManager / utils / cudaUtils / addonManager，均不反向 import addonLoader。`storeManager` re-export 的 `ipcStoreHandlers` 不 import addonLoader（T3 已保证迁移逻辑不依赖 loader）。

### 5b. `main/helpers/whisper.ts` 重构 loadWhisperAddon

- 删除 `setupLibraryPath` 函数（已移入 addonLoader）。
- 整体替换 `loadWhisperAddon`（原 L287-392）为：

```ts
/**
 * 加载适合当前系统的 Whisper Addon
 *
 * 实际决策与降级链见 addonLoader.resolveCandidates；
 * 此处仅负责组装 LoadContext（gpuMode + CoreML 可用性）。
 */
export async function loadWhisperAddon(model: string) {
  const settings = store.get('settings');
  const gpuMode: GpuMode = settings?.gpuMode || 'auto';
  const coremlEligible =
    getEffectivePlatform() === 'darwin' &&
    isAppleSilicon() &&
    hasEncoderModel(model);

  return loadBestAddon({ gpuMode, coremlEligible });
}
```

- import 清理：
  - 删除 `checkCudaSupport, isPlatformCudaCapable`（保留 `getEffectivePlatform`）。
  - 删除整个 `./addonManager` import 块（whisper.ts 不再直接用）。
  - `./utils` import 去掉 `getExtraResourcesPath`（保留 `isAppleSilicon, isWin32`）。
  - 新增：`import { loadBestAddon } from './addonLoader';` 与 `import type { GpuMode } from '../../types/addon';`

### 5c. `main/helpers/subtitleGenerator.ts`

- 删除 `import { checkCudaSupport } from './cudaUtils';`
- `generateSubtitleWithBuiltinWhisper` 内，删除原 GPU 判断与加载块（L104-118：`const useCuda = ...` 至 `const whisperAsync = promisify(whisper);`，保留 L103 的 `const settings = store.get('settings');`），替换为：

```ts
// 加载链内部按 gpuMode + 环境自动决策并逐级降级（见 addonLoader）
const { whisperAsync, backend, variant } = await loadWhisperAddon(whisperModel);
const backendLabels: Record<string, string> = {
  vulkan: 'Vulkan',
  cpu: 'CPU',
  metal: 'Metal',
  coreml: 'CoreML',
  custom: 'Custom',
};
const whisperBackend =
  backend === 'cuda' && variant !== null && variant !== 'vulkan'
    ? `CUDA ${variant}`
    : backendLabels[backend] || backend;
// 把实际后端推给任务卡片（useIpcCommunication 做通用 merge）
event.sender.send('taskFileChange', {
  ...file,
  extractSubtitle: 'loading',
  whisperBackend,
});
```

> `promisify` 已在 addonLoader 内完成，本文件不再需要：删除 `import { promisify } from 'util';`（已确认本文件无其它使用处）。L105-106 的 `const platform` / `const arch` 仅被删除块使用（已 grep 确认），一并删除。

- `whisperParams` 中 `use_gpu: !!shouldUseGpu,` → `use_gpu: backend !== 'cpu',`

### 5d. `types/types.ts` — IFiles 扩展

`tempTranslatedSrtFile?: string;` 之后加：

```ts
  /** 本次转写实际使用的后端标签（如 "CUDA 12.4.0" / "Vulkan" / "CPU"） */
  whisperBackend?: string;
```

### 5e. `main/helpers/ipcAddonHandlers.ts` — 新 IPC 与事件接线

- import 增加：

```ts
import { getGpuEnvironment, clearGpuEnvironmentCache } from './cudaUtils';
import {
  getActiveBackend,
  setFallbackNotifier,
  setLoadResultNotifier,
  clearAddonLoadCache,
} from './addonLoader';
```

（与现有 `from './cudaUtils'` 的 import 合并成一条。）

- `setMainWindowForAddon` 改为：

```ts
export function setMainWindowForAddon(window: BrowserWindow): void {
  mainWindow = window;
  getAddonDownloader(window);

  // 加载降级 / 后端变更事件推送到渲染层
  setFallbackNotifier((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('addon-fallback', event);
    }
  });
  setLoadResultNotifier((info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('active-backend-changed', info);
    }
  });
}
```

- `registerAddonIpcHandlers` 顶部（`get-cuda-environment` handler 之后）新增两个 handler：

```ts
// 获取跨厂商 GPU 环境信息
ipcMain.handle(
  'get-gpu-environment',
  async (_event, forceRefresh?: boolean) => {
    try {
      if (forceRefresh) {
        clearGpuEnvironmentCache();
      }
      return await getGpuEnvironment(!!forceRefresh);
    } catch (error) {
      logMessage(`Error getting GPU environment: ${error}`, 'error');
      return null;
    }
  },
);

// 获取当前生效的后端（最近一次加载结果）
ipcMain.handle('get-active-backend', async () => {
  try {
    return getActiveBackend();
  } catch (error) {
    logMessage(`Error getting active backend: ${error}`, 'error');
    return null;
  }
});
```

- 以下 handler 成功路径里各加一行 `clearAddonLoadCache();`（防御性失效，缓存 key 本身已覆盖决策输入）：
  - `'select-addon-version'`（`selectAddonVersion(version);` 之后）
  - `'set-custom-addon-path'`（`setCustomAddonPath(filePath);` 之后）
  - `'remove-addon'`（`await removeAddon(version);` 之后）
  - `'start-addon-download'` 的 `.then` 内（`selectAddonVersion(config.variant);` 之后）

**验证**：主进程 + 渲染层 scoped typecheck OK（IFiles 在渲染层也被引用）。

**提交**

```bash
git add main/helpers/addonLoader.ts main/helpers/whisper.ts main/helpers/subtitleGenerator.ts main/helpers/ipcAddonHandlers.ts types/types.ts
git commit -m "feat: centralized addon loader with try/catch fallback chain and backend reporting"
```

---

## T6：i18n 文案

### 6a. `renderer/public/locales/zh/settings.json`

`gpuAcceleration` 对象内 `"toolkitCompatTip": "...",` 之后追加（注意给 toolkitCompatTip 行尾补逗号）：

```json
    "modeTitle": "加速模式",
    "modeAuto": "自动（推荐）",
    "modeAutoDesc": "自动选择最佳可用后端，失败时逐级降级，永远能完成转写",
    "modeGpuOnly": "仅 GPU",
    "modeGpuOnlyDesc": "强制使用 GPU，全部 GPU 后端失败时任务报错",
    "modeCpuOnly": "仅 CPU",
    "modeCpuOnlyDesc": "彻底关闭 GPU 加速",
    "modeChanged": "加速模式已更新",
    "gpuOnlyWarning": "仅 GPU 模式下，GPU 不可用时任务将直接报错",
    "statusRunningGpu": "GPU 加速运行中 · {{backend}}",
    "statusFallback": "已自动切换到 {{backend}}",
    "statusCpu": "CPU 模式",
    "statusCpuManual": "CPU 模式（手动设置）",
    "statusAutoReady": "已就绪 · 转写时自动选择最佳后端",
    "upgradeHint": "检测到 {{gpu}}，升级到 CUDA 加速包可再提升约 10%~30% 性能",
    "upgradeToCuda": "升级到 CUDA {{version}}",
    "advancedOptions": "高级选项",
    "backendSelect": "加速后端",
    "backendGroupUniversal": "通用 GPU（NVIDIA / AMD / Intel）",
    "backendGroupCuda": "NVIDIA CUDA（性能最佳，仅 N 卡）",
    "vulkanBuiltin": "Vulkan（内置）",
    "vulkanUserData": "Vulkan（已下载）",
    "cudaNotApplicable": "未检测到 NVIDIA 显卡，CUDA 不可用",
    "selectToDownload": "未安装，选择后开始下载",
    "builtin": "内置",
    "installedManagement": "已安装管理",
    "packageType": "CUDA 包类型",
    "diagnostics": "检测详情",
    "copyDiagnostics": "复制诊断信息",
    "diagnosticsCopied": "诊断信息已复制",
    "vulkanRuntimeLabel": "Vulkan 运行库",
    "detected": "已检测到",
    "lastLoad": "上次加载",
    "loadSuccess": "成功",
    "loadFallbackBadge": "降级",
    "noLoadYet": "尚未执行过转写",
    "failureDetails": "失败明细",
    "vulkanUpdateAvailable": "Vulkan 加速包有新版本，可下载更新",
    "linuxVulkanHint": "Linux 下若缺少 Vulkan 运行库，可执行：sudo apt install libvulkan1",
    "updateDriverHint": "若本机有独立显卡但未启用加速，请尝试更新显卡驱动"
```

### 6b. `renderer/public/locales/en/settings.json`

同位置追加：

```json
    "modeTitle": "Acceleration Mode",
    "modeAuto": "Auto (Recommended)",
    "modeAutoDesc": "Automatically picks the best available backend with graceful fallback, transcription always works",
    "modeGpuOnly": "GPU Only",
    "modeGpuOnlyDesc": "Force GPU; tasks fail if no GPU backend can be loaded",
    "modeCpuOnly": "CPU Only",
    "modeCpuOnlyDesc": "Disable GPU acceleration entirely",
    "modeChanged": "Acceleration mode updated",
    "gpuOnlyWarning": "In GPU-only mode, tasks will fail when GPU is unavailable",
    "statusRunningGpu": "GPU Acceleration Active · {{backend}}",
    "statusFallback": "Automatically switched to {{backend}}",
    "statusCpu": "CPU Mode",
    "statusCpuManual": "CPU Mode (manual)",
    "statusAutoReady": "Ready · best backend will be picked at transcription time",
    "upgradeHint": "{{gpu}} detected. Upgrading to a CUDA pack can boost performance by ~10-30%",
    "upgradeToCuda": "Upgrade to CUDA {{version}}",
    "advancedOptions": "Advanced Options",
    "backendSelect": "Backend",
    "backendGroupUniversal": "Universal GPU (NVIDIA / AMD / Intel)",
    "backendGroupCuda": "NVIDIA CUDA (best performance, NVIDIA only)",
    "vulkanBuiltin": "Vulkan (built-in)",
    "vulkanUserData": "Vulkan (downloaded)",
    "cudaNotApplicable": "No NVIDIA GPU detected, CUDA unavailable",
    "selectToDownload": "Not installed, select to download",
    "builtin": "Built-in",
    "installedManagement": "Installed Packs",
    "packageType": "CUDA Pack Type",
    "diagnostics": "Diagnostics",
    "copyDiagnostics": "Copy Diagnostics",
    "diagnosticsCopied": "Diagnostics copied",
    "vulkanRuntimeLabel": "Vulkan Runtime",
    "detected": "Detected",
    "lastLoad": "Last Load",
    "loadSuccess": "Success",
    "loadFallbackBadge": "Fallback",
    "noLoadYet": "No transcription run yet",
    "failureDetails": "Failure Details",
    "vulkanUpdateAvailable": "A newer Vulkan pack is available for download",
    "linuxVulkanHint": "On Linux, if the Vulkan runtime is missing: sudo apt install libvulkan1",
    "updateDriverHint": "If this machine has a discrete GPU but acceleration is off, try updating the GPU driver"
```

### 6c. `renderer/public/locales/zh/common.json`

- 替换：`"gpuAccelerationEnabledTip": "GPU 加速已启用，正在使用 CUDA 加速处理"` → `"gpuAccelerationEnabledTip": "GPU 加速已启用，点击查看详细设置"`
- `"gpuAccelerationDisabledTip"` 行后追加：

```json
  "gpuFallbackToast": "GPU 加速暂不可用，已自动切换到 {{backend}} 继续转写",
  "gpuMigrationNotice": "新版本已支持通用 GPU 加速（Vulkan）并默认启用，可在设置 → GPU 加速中调整"
```

### 6d. `renderer/public/locales/en/common.json`

- 替换：`"gpuAccelerationEnabledTip": "GPU acceleration is enabled, using CUDA for faster processing"` → `"gpuAccelerationEnabledTip": "GPU acceleration is enabled. Click to view settings."`
- 同位置追加：

```json
  "gpuFallbackToast": "GPU acceleration unavailable, automatically switched to {{backend}}",
  "gpuMigrationNotice": "This version adds universal GPU acceleration (Vulkan), enabled by default. Adjust in Settings → GPU Acceleration."
```

**验证**：四个 JSON 用 `node -e "require('./renderer/public/locales/zh/settings.json')"`（等四条）确认合法。

**提交**

```bash
git add renderer/public/locales/zh/settings.json renderer/public/locales/en/settings.json renderer/public/locales/zh/common.json renderer/public/locales/en/common.json
git commit -m "feat: i18n strings for vulkan gpu acceleration UI"
```

---

## T7：设置页 UI 重构 — GpuAccelerationCard

**文件**：`renderer/components/settings/GpuAccelerationCard.tsx`（整文件重写，单文件保持现有代码风格；约 700 行 → 结构为：状态卡 → 模式三态 → 高级选项折叠 → 检测详情折叠）

完整新文件内容：

```tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Zap,
  ZapOff,
  Cpu,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  ChevronDown,
  Trash2,
  FolderOpen,
  FileCode,
  ExternalLink,
  Info,
  X,
  Package,
  Copy,
  Gauge,
} from 'lucide-react';
import { toast } from 'sonner';
import { openUrl } from '@/lib/utils';
import type {
  GpuEnvironment,
  GpuMode,
  AddonVariant,
  AddonLoadResultInfo,
  AddonUpdateInfo,
  DownloadProgress,
  DownloadSource,
  CudaVersion,
} from '../../../types/addon';
import { AVAILABLE_CUDA_VERSIONS } from '../../../types/addon';

interface InstalledAddonInfo {
  version: AddonVariant;
  info: {
    installedAt: string;
    remoteVersion: string;
    hasDlls: boolean;
    size: number;
  };
}

const BACKEND_LABELS: Record<string, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  cpu: 'CPU',
  metal: 'Metal',
  coreml: 'CoreML',
  custom: 'Custom',
};

function backendDisplay(info: AddonLoadResultInfo | null): string {
  if (!info) return '';
  if (info.backend === 'cuda' && info.variant && info.variant !== 'vulkan') {
    return `CUDA ${info.variant}`;
  }
  return BACKEND_LABELS[info.backend] || info.backend;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const GpuAccelerationCard: React.FC = () => {
  const { t } = useTranslation('settings');

  const [gpuEnv, setGpuEnv] = useState<GpuEnvironment | null>(null);
  const [activeBackend, setActiveBackend] =
    useState<AddonLoadResultInfo | null>(null);
  const [gpuMode, setGpuMode] = useState<GpuMode>('auto');
  const [installedAddons, setInstalledAddons] = useState<InstalledAddonInfo[]>(
    [],
  );
  const [selectedVersion, setSelectedVersion] = useState<AddonVariant | null>(
    null,
  );
  const [customAddonPath, setCustomAddonPath] = useState<string | null>(null);
  const [updates, setUpdates] = useState<AddonUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [downloadSource, setDownloadSource] =
    useState<DownloadSource>('github');
  const [downloadingVariant, setDownloadingVariant] =
    useState<AddonVariant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const lastToastStatus = useRef<string | null>(null);
  const downloadingVariantRef = useRef<AddonVariant | null>(null);

  const isDesktopGpuPlatform = gpuEnv ? gpuEnv.platform !== 'darwin' : false;

  const loadData = useCallback(async (forceRefresh = false) => {
    try {
      setIsLoading(true);
      const env = await window?.ipc?.invoke(
        'get-gpu-environment',
        forceRefresh,
      );
      setGpuEnv(env);

      const active = await window?.ipc?.invoke('get-active-backend');
      setActiveBackend(active);

      const addons = await window?.ipc?.invoke('get-installed-addons');
      setInstalledAddons(addons || []);

      const selected = await window?.ipc?.invoke('get-selected-addon-version');
      setSelectedVersion(selected);

      const customPath = await window?.ipc?.invoke('get-custom-addon-path');
      setCustomAddonPath(customPath);

      const settings = await window?.ipc?.invoke('getSettings');
      setGpuMode(settings?.gpuMode || 'auto');
    } catch (error) {
      console.error('Failed to load GPU acceleration data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 下载进度
  useEffect(() => {
    const handleProgress = async (progress: DownloadProgress) => {
      setDownloadProgress(progress);

      if (progress.status === 'completed') {
        if (lastToastStatus.current !== 'completed') {
          toast.success(t('gpuAcceleration.downloadComplete'));
          lastToastStatus.current = 'completed';
        }
        setTimeout(async () => {
          setDownloadProgress(null);
          setDownloadingVariant(null);
          downloadingVariantRef.current = null;
          // 主进程下载完成后已自动 registerInstalledAddon + selectAddonVersion
          await loadData();
          notifyGpuSettingsChanged();
        }, 1000);
      } else if (progress.status === 'error') {
        if (lastToastStatus.current !== 'error') {
          toast.error(progress.error || t('gpuAcceleration.downloadFailed'));
          lastToastStatus.current = 'error';
        }
        setDownloadingVariant(null);
        downloadingVariantRef.current = null;
      } else if (progress.status === 'downloading') {
        lastToastStatus.current = null;
      }
    };

    const cleanup = window?.ipc?.on('addon-download-progress', handleProgress);
    return () => {
      cleanup?.();
    };
  }, [loadData, t]);

  // 后端变更推送（转写触发加载后刷新状态卡）
  useEffect(() => {
    const cleanup = window?.ipc?.on(
      'active-backend-changed',
      (info: AddonLoadResultInfo) => {
        setActiveBackend(info);
      },
    );
    return () => {
      cleanup?.();
    };
  }, []);

  const notifyGpuSettingsChanged = () => {
    window.dispatchEvent(new Event('gpu-settings-changed'));
  };

  // ===== 操作 =====

  const handleModeChange = async (mode: GpuMode) => {
    try {
      await window?.ipc?.invoke('setSettings', { gpuMode: mode });
      setGpuMode(mode);
      notifyGpuSettingsChanged();
      toast.success(t('gpuAcceleration.modeChanged'));
      if (mode === 'gpu-only') {
        toast.warning(t('gpuAcceleration.gpuOnlyWarning'));
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleDownload = async (
    variant: AddonVariant,
    forceType?: 'node.gz' | 'tar.gz',
  ) => {
    const downloadType: 'node.gz' | 'tar.gz' =
      variant === 'vulkan'
        ? 'node.gz'
        : (forceType ??
          (gpuEnv?.nvidia?.recommendation.needsDlls ? 'tar.gz' : 'node.gz'));
    setDownloadingVariant(variant);
    downloadingVariantRef.current = variant;
    try {
      await window?.ipc?.invoke('start-addon-download', {
        source: downloadSource,
        variant,
        type: downloadType,
      });
      toast.info(t('gpuAcceleration.downloadStarted'));
    } catch (error) {
      toast.error(t('gpuAcceleration.downloadFailed'));
      setDownloadingVariant(null);
      downloadingVariantRef.current = null;
    }
  };

  const handleCancelDownload = async () => {
    try {
      await window?.ipc?.invoke('cancel-addon-download');
      setDownloadProgress(null);
      setDownloadingVariant(null);
      downloadingVariantRef.current = null;
      toast.info(t('gpuAcceleration.downloadCancelled'));
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  };

  const isVariantInstalled = (variant: AddonVariant): boolean =>
    installedAddons.some((a) => a.version === variant);

  // 后端下拉选择：builtin-vulkan = 清空选择走默认链；其它 = 选中（未安装则触发下载）
  const handleBackendSelect = async (value: string) => {
    try {
      if (customAddonPath) {
        await window?.ipc?.invoke('set-custom-addon-path', null);
        setCustomAddonPath(null);
      }
      if (value === 'builtin-vulkan') {
        await window?.ipc?.invoke('select-addon-version', null);
        setSelectedVersion(null);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.versionSelected'));
        return;
      }
      const variant = value as AddonVariant;
      if (isVariantInstalled(variant)) {
        await window?.ipc?.invoke('select-addon-version', variant);
        setSelectedVersion(variant);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.versionSelected'));
      } else {
        await handleDownload(variant);
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleRemoveAddon = async (variant: AddonVariant) => {
    try {
      await window?.ipc?.invoke('remove-addon', variant);
      toast.success(t('gpuAcceleration.addonRemoved'));
      loadData();
      notifyGpuSettingsChanged();
    } catch (error) {
      toast.error(t('gpuAcceleration.removeFailed'));
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    try {
      const updateInfo = await window?.ipc?.invoke('check-addon-updates');
      setUpdates(updateInfo || []);
      const hasUpdates = updateInfo?.some((u: AddonUpdateInfo) => u.hasUpdate);
      if (hasUpdates) {
        toast.info(t('gpuAcceleration.updatesAvailable'));
      } else {
        toast.success(t('gpuAcceleration.noUpdates'));
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.checkUpdatesFailed'));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleSelectCustomAddon = async () => {
    try {
      const result = await window?.ipc?.invoke('select-addon-file');
      if (result?.canceled || !result?.filePath) return;
      const setResult = await window?.ipc?.invoke(
        'set-custom-addon-path',
        result.filePath,
      );
      if (setResult?.success) {
        setCustomAddonPath(result.filePath);
        setSelectedVersion(null);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.customAddonSet'));
      } else {
        toast.error(
          setResult?.error || t('gpuAcceleration.customAddonSetFailed'),
        );
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.customAddonSetFailed'));
    }
  };

  const handleClearCustomAddon = async () => {
    try {
      await window?.ipc?.invoke('set-custom-addon-path', null);
      setCustomAddonPath(null);
      notifyGpuSettingsChanged();
      toast.info(t('gpuAcceleration.customAddonCleared'));
      loadData();
    } catch (error) {
      console.error('Failed to clear custom addon path:', error);
    }
  };

  const handleCopyDiagnostics = async () => {
    const diag = {
      gpuEnv,
      activeBackend,
      gpuMode,
      selectedVersion,
      customAddonPath,
      installed: installedAddons,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      toast.success(t('gpuAcceleration.diagnosticsCopied'));
    } catch {
      toast.error(t('copyFailed', { ns: 'common' }));
    }
  };

  // ===== 派生状态 =====

  const nvidiaRecommendation = gpuEnv?.nvidia?.recommendation;
  const recommendedCudaVersion = nvidiaRecommendation?.recommendedVersion;
  const cudaApplicable = !!nvidiaRecommendation?.canUseCuda;
  const activeLabel = backendDisplay(activeBackend);
  const isCudaActive = activeBackend?.backend === 'cuda';
  const showUpgradeButton =
    isDesktopGpuPlatform &&
    gpuMode !== 'cpu-only' &&
    cudaApplicable &&
    !!recommendedCudaVersion &&
    !isCudaActive &&
    !(selectedVersion && selectedVersion !== 'vulkan') &&
    !customAddonPath;

  const gpuName =
    gpuEnv?.gpus?.[0]?.name ||
    gpuEnv?.nvidia?.gpuSupport?.gpuName ||
    t('gpuAcceleration.notDetected');

  type StatusTone = 'green' | 'yellow' | 'gray' | 'neutral';
  const deriveStatus = (): { tone: StatusTone; title: string } => {
    if (gpuMode === 'cpu-only') {
      return { tone: 'gray', title: t('gpuAcceleration.statusCpuManual') };
    }
    if (!activeBackend) {
      return { tone: 'neutral', title: t('gpuAcceleration.statusAutoReady') };
    }
    if (activeBackend.backend === 'cpu') {
      return {
        tone: isDesktopGpuPlatform ? 'yellow' : 'gray',
        title: isDesktopGpuPlatform
          ? t('gpuAcceleration.statusFallback', { backend: 'CPU' })
          : t('gpuAcceleration.statusCpu'),
      };
    }
    if (activeBackend.fallback) {
      return {
        tone: 'yellow',
        title: t('gpuAcceleration.statusFallback', { backend: activeLabel }),
      };
    }
    return {
      tone: 'green',
      title: t('gpuAcceleration.statusRunningGpu', { backend: activeLabel }),
    };
  };
  const status = deriveStatus();

  const statusToneClasses: Record<StatusTone, string> = {
    green:
      'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30',
    yellow:
      'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30',
    gray: 'border-muted bg-muted/40',
    neutral: 'border-muted bg-muted/40',
  };

  const renderStatusIcon = () => {
    if (status.tone === 'green')
      return <Zap className="w-5 h-5 text-green-600 dark:text-green-400" />;
    if (status.tone === 'yellow')
      return <AlertTriangle className="w-5 h-5 text-amber-500" />;
    if (gpuMode === 'cpu-only')
      return <ZapOff className="w-5 h-5 text-muted-foreground" />;
    return <Cpu className="w-5 h-5 text-muted-foreground" />;
  };

  // ===== 渲染 =====

  if (isLoading) {
    return (
      <Card id="gpu-acceleration">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderDownloadProgress = () => {
    if (!downloadProgress || downloadProgress.status === 'idle') return null;
    const isDownloading = downloadProgress.status === 'downloading';
    const isExtracting = downloadProgress.status === 'extracting';
    const isError = downloadProgress.status === 'error';
    const variantLabel =
      downloadingVariant === 'vulkan'
        ? 'Vulkan'
        : downloadingVariant
          ? `CUDA ${downloadingVariant}`
          : '';

    return (
      <div className="space-y-2 p-3 bg-muted rounded-lg">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {variantLabel && `${variantLabel}: `}
            {isDownloading && t('gpuAcceleration.downloading')}
            {isExtracting && t('gpuAcceleration.extracting')}
            {isError && t('gpuAcceleration.downloadFailed')}
          </span>
          <div className="flex items-center gap-2">
            {isError && downloadingVariant && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownload(downloadingVariant)}
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                {t('gpuAcceleration.retry')}
              </Button>
            )}
            {isDownloading && (
              <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
                {t('cancel')}
              </Button>
            )}
            {isError && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDownloadProgress(null);
                  setDownloadingVariant(null);
                }}
              >
                {t('gpuAcceleration.dismiss')}
              </Button>
            )}
          </div>
        </div>
        <Progress value={downloadProgress.progress} />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatSize(downloadProgress.downloaded)} /{' '}
            {formatSize(downloadProgress.total)}
          </span>
          {isDownloading && downloadProgress.speed > 0 && (
            <span>
              {formatSize(downloadProgress.speed)}/s ·{' '}
              {formatEta(downloadProgress.eta)}
            </span>
          )}
          {isError && downloadProgress.error && (
            <span className="text-destructive">{downloadProgress.error}</span>
          )}
        </div>
      </div>
    );
  };

  const modeOptions: { value: GpuMode; label: string; desc: string }[] = [
    {
      value: 'auto',
      label: t('gpuAcceleration.modeAuto'),
      desc: t('gpuAcceleration.modeAutoDesc'),
    },
    {
      value: 'gpu-only',
      label: t('gpuAcceleration.modeGpuOnly'),
      desc: t('gpuAcceleration.modeGpuOnlyDesc'),
    },
    {
      value: 'cpu-only',
      label: t('gpuAcceleration.modeCpuOnly'),
      desc: t('gpuAcceleration.modeCpuOnlyDesc'),
    },
  ];

  const backendSelectValue = customAddonPath
    ? 'custom'
    : (selectedVersion ?? 'builtin-vulkan');

  const selectedCudaInstalled = installedAddons.find(
    (a) => a.version === selectedVersion && a.version !== 'vulkan',
  );
  const vulkanUpdate = updates.find(
    (u) => u.variant === 'vulkan' && u.hasUpdate,
  );

  return (
    <Card id="gpu-acceleration">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </div>
          <Button variant="ghost" size="sm" onClick={() => loadData(true)}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 状态卡 */}
        <div
          className={`rounded-lg border-2 p-4 space-y-2 ${statusToneClasses[status.tone]}`}
        >
          <div className="flex items-center gap-2">
            {renderStatusIcon()}
            <span className="font-semibold text-sm">{status.title}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {gpuName}
            {gpuEnv?.nvidia?.gpuSupport?.driverVersion &&
              ` · ${t('gpuAcceleration.driver')} ${gpuEnv.nvidia.gpuSupport.driverVersion}`}
          </div>
          {status.tone === 'yellow' &&
            activeBackend?.failedAttempts?.length > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-400">
                {activeBackend.failedAttempts[0].error}
              </div>
            )}
          {status.tone !== 'green' && isDesktopGpuPlatform && (
            <div className="text-xs text-muted-foreground">
              {!gpuEnv?.vulkanRuntime && t('gpuAcceleration.updateDriverHint')}
              {!gpuEnv?.vulkanRuntime &&
                gpuEnv?.platform === 'linux' &&
                ` ${t('gpuAcceleration.linuxVulkanHint')}`}
            </div>
          )}
          {showUpgradeButton && (
            <div className="pt-2 border-t border-current/10 space-y-2">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Gauge className="w-3.5 h-3.5" />
                {t('gpuAcceleration.upgradeHint', { gpu: gpuName })}
              </div>
              <Button
                size="sm"
                onClick={() => handleDownload(recommendedCudaVersion!)}
                disabled={!!downloadingVariant}
              >
                {t('gpuAcceleration.upgradeToCuda', {
                  version: recommendedCudaVersion,
                })}
              </Button>
            </div>
          )}
        </div>

        {/* 下载进度（全局可见） */}
        {renderDownloadProgress()}

        {/* 加速模式（macOS 隐藏） */}
        {isDesktopGpuPlatform && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t('gpuAcceleration.modeTitle')}
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {modeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleModeChange(opt.value)}
                  className={`p-2.5 rounded-lg border-2 text-left transition-all ${
                    gpuMode === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-primary/50'
                  }`}
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 高级选项（macOS 隐藏；cpu-only 时禁入无意义，仍可见便于管理已安装项） */}
        {isDesktopGpuPlatform && (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-medium w-full"
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${advancedOpen ? '' : '-rotate-90'}`}
                />
                {t('gpuAcceleration.advancedOptions')}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-4">
              {/* 后端选择 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t('gpuAcceleration.backendSelect')}
                </span>
                <Select
                  value={backendSelectValue}
                  onValueChange={handleBackendSelect}
                  disabled={!!downloadingVariant}
                >
                  <SelectTrigger className="w-[280px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {customAddonPath && (
                      <SelectItem value="custom" disabled>
                        {t('gpuAcceleration.customAddonActive')}
                      </SelectItem>
                    )}
                    <SelectGroup>
                      <SelectLabel className="text-[11px]">
                        {t('gpuAcceleration.backendGroupUniversal')}
                      </SelectLabel>
                      <SelectItem value="builtin-vulkan">
                        {t('gpuAcceleration.vulkanBuiltin')}
                      </SelectItem>
                      {isVariantInstalled('vulkan') && (
                        <SelectItem value="vulkan">
                          {t('gpuAcceleration.vulkanUserData')}
                        </SelectItem>
                      )}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel className="text-[11px]">
                        {t('gpuAcceleration.backendGroupCuda')}
                        {!cudaApplicable &&
                          ` — ${t('gpuAcceleration.cudaNotApplicable')}`}
                      </SelectLabel>
                      {AVAILABLE_CUDA_VERSIONS.map((version: CudaVersion) => (
                        <SelectItem
                          key={version}
                          value={version}
                          disabled={!cudaApplicable}
                        >
                          CUDA {version}
                          {version === recommendedCudaVersion &&
                            ` · ${t('gpuAcceleration.recommended')}`}
                          {!isVariantInstalled(version) &&
                            ` · ${t('gpuAcceleration.selectToDownload')}`}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {/* CUDA 包类型（仅选中已安装 CUDA 时） */}
              {selectedCudaInstalled && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('gpuAcceleration.packageType')}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      <Package className="w-3 h-3 mr-1" />
                      {selectedCudaInstalled.info.hasDlls
                        ? t('gpuAcceleration.fullEdition')
                        : t('gpuAcceleration.liteEdition')}
                    </Badge>
                    {(selectedCudaInstalled.info.hasDlls
                      ? gpuEnv?.nvidia?.cudaToolkit.installed
                      : true) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!!downloadingVariant}
                        onClick={() =>
                          handleDownload(
                            selectedCudaInstalled.version,
                            selectedCudaInstalled.info.hasDlls
                              ? 'node.gz'
                              : 'tar.gz',
                          )
                        }
                      >
                        {selectedCudaInstalled.info.hasDlls
                          ? t('gpuAcceleration.switchToLite')
                          : t('gpuAcceleration.switchToFull')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* 下载源 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('gpuAcceleration.downloadSource')}
                </span>
                <Select
                  value={downloadSource}
                  onValueChange={(v) => setDownloadSource(v as DownloadSource)}
                >
                  <SelectTrigger className="w-[200px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="ghproxy">
                      {t('gpuAcceleration.ghProxy')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 已安装管理 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t('gpuAcceleration.installedManagement')}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleCheckUpdates}
                    disabled={checkingUpdates}
                  >
                    <RefreshCw
                      className={`w-3 h-3 mr-1 ${checkingUpdates ? 'animate-spin' : ''}`}
                    />
                    {t('gpuAcceleration.checkNewVersion')}
                  </Button>
                </div>

                {/* 内置 Vulkan 行 */}
                {gpuEnv?.builtinVulkanAvailable && (
                  <div className="flex items-center justify-between p-2 rounded-md border text-xs">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                      <span>Vulkan</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {t('gpuAcceleration.builtin')}
                      </Badge>
                    </div>
                    {vulkanUpdate && !isVariantInstalled('vulkan') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px] text-amber-600"
                        disabled={!!downloadingVariant}
                        onClick={() => handleDownload('vulkan')}
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        {t('gpuAcceleration.update')}
                      </Button>
                    )}
                  </div>
                )}

                {/* userData 安装项 */}
                {installedAddons.map((addon) => {
                  const hasUpdate = updates.find(
                    (u) => u.variant === addon.version && u.hasUpdate,
                  );
                  const label =
                    addon.version === 'vulkan'
                      ? 'Vulkan'
                      : `CUDA ${addon.version}`;
                  return (
                    <div
                      key={addon.version}
                      className="flex items-center justify-between p-2 rounded-md border text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                        <span>{label}</span>
                        <span className="text-muted-foreground">
                          v{addon.info.remoteVersion} ·{' '}
                          {formatSize(addon.info.size)}
                        </span>
                        {addon.version !== 'vulkan' && (
                          <Badge variant="outline" className="text-[10px]">
                            {addon.info.hasDlls
                              ? t('gpuAcceleration.fullEdition')
                              : t('gpuAcceleration.liteEdition')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {hasUpdate && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[11px] text-amber-600"
                            disabled={!!downloadingVariant}
                            onClick={() => handleDownload(addon.version)}
                          >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            {t('gpuAcceleration.update')}
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-destructive"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t('gpuAcceleration.confirmDelete')}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('gpuAcceleration.confirmDeleteDesc', {
                                  version: label,
                                })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {t('cancel')}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRemoveAddon(addon.version)}
                              >
                                {t('delete')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 自定义加速包 */}
              <div className="pt-3 border-t border-dashed space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {t('gpuAcceleration.customAddonPath')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      openUrl(
                        'https://github.com/buxuku/whisper.cpp/releases/tag/latest',
                      )
                    }
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t('gpuAcceleration.downloadPackageUrl')}
                  </button>
                </div>
                <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md">
                  <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-[11px] text-muted-foreground space-y-1">
                    <p>{t('gpuAcceleration.customAddonTip')}</p>
                    <p>{t('gpuAcceleration.customAddonDllTip')}</p>
                  </div>
                </div>
                {customAddonPath ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg border-2 border-primary bg-primary/5">
                    <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {t('gpuAcceleration.customAddonActive')}
                      </div>
                      <div
                        className="text-[11px] text-muted-foreground truncate"
                        title={customAddonPath}
                      >
                        {customAddonPath}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={handleSelectCustomAddon}
                      >
                        <FolderOpen className="w-3.5 h-3.5 mr-1" />
                        {t('gpuAcceleration.selectAddonFile')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive"
                        onClick={handleClearCustomAddon}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-9 text-xs"
                    onClick={handleSelectCustomAddon}
                  >
                    <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                    {t('gpuAcceleration.selectAddonFile')}
                  </Button>
                )}
              </div>

              {/* 闪退提示 */}
              <div className="flex items-start gap-2 p-2.5 bg-amber-50 dark:bg-amber-950/30 rounded-md border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  {t('gpuAcceleration.crashTip')}
                </span>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* 检测详情（全平台可见） */}
        <Collapsible open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium w-full"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform ${diagnosticsOpen ? '' : '-rotate-90'}`}
              />
              {t('gpuAcceleration.diagnostics')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('gpuAcceleration.gpu')}
                </span>
                <span className="font-medium text-right">
                  {gpuEnv?.gpus?.length
                    ? gpuEnv.gpus.map((g) => g.name).join(' / ')
                    : t('gpuAcceleration.notDetected')}
                </span>
              </div>
              {isDesktopGpuPlatform && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('gpuAcceleration.vulkanRuntimeLabel')}
                  </span>
                  <span>
                    {gpuEnv?.vulkanRuntime
                      ? `✓ ${t('gpuAcceleration.detected')}`
                      : `✗ ${t('gpuAcceleration.notDetected')}`}
                  </span>
                </div>
              )}
              {gpuEnv?.nvidia && (
                <>
                  {gpuEnv.nvidia.gpuSupport.maxCudaVersion && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {t('gpuAcceleration.maxCuda')}
                      </span>
                      <span>{gpuEnv.nvidia.gpuSupport.maxCudaVersion}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {t('gpuAcceleration.cudaToolkit')}
                    </span>
                    <span>
                      {gpuEnv.nvidia.cudaToolkit.installed
                        ? gpuEnv.nvidia.cudaToolkit.version ||
                          t('gpuAcceleration.installed')
                        : t('gpuAcceleration.notInstalled')}
                    </span>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between border-t pt-2">
                <span className="text-muted-foreground">
                  {t('gpuAcceleration.lastLoad')}
                </span>
                <span className="text-right">
                  {activeBackend
                    ? `${activeLabel} · ${
                        activeBackend.fallback
                          ? t('gpuAcceleration.loadFallbackBadge')
                          : t('gpuAcceleration.loadSuccess')
                      } · ${new Date(activeBackend.loadedAt).toLocaleString()}`
                    : t('gpuAcceleration.noLoadYet')}
                </span>
              </div>
              {activeBackend?.failedAttempts?.length > 0 && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">
                    {t('gpuAcceleration.failureDetails')}
                  </span>
                  {activeBackend.failedAttempts.map((a, idx) => (
                    <div
                      key={idx}
                      className="text-[11px] text-muted-foreground pl-2 break-all"
                    >
                      {BACKEND_LABELS[a.backend] || a.backend}: {a.error}
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleCopyDiagnostics}
                >
                  <Copy className="w-3 h-3 mr-1" />
                  {t('gpuAcceleration.copyDiagnostics')}
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
};

export default GpuAccelerationCard;
```

**实施注意**：

- `@/components/ui/select` 需确认导出 `SelectGroup` / `SelectLabel`（shadcn 默认模板有；若无则补导出，radix 原语 `SelectPrimitive.Group` / `SelectPrimitive.Label` 已在依赖内）。
- `t('copyFailed', { ns: 'common' })`：settings 页面的 `serverSideTranslations` 需已包含 common namespace（现有页面均加载 `['common', 'settings']`，无需改动；若类型报错改为直接字符串 fallback）。
- 移除了旧文件的 5 卡片网格、`useCuda` 状态、`handleDisableCuda`、`handleVersionSelect`（被 `handleBackendSelect` 取代）。

**验证**：渲染层 scoped typecheck OK；`yarn dev` 里设置页手动目检（macOS 下应只见状态卡 + 检测详情）。

**提交**

```bash
git add renderer/components/settings/GpuAccelerationCard.tsx
git commit -m "feat: redesign GPU acceleration settings UI (status card + mode switch + advanced)"
```

---

## T8：渲染层状态反馈 — Layout 指示器 / 降级 toast / 迁移通知 / 任务徽章

### 8a. `renderer/components/Layout.tsx`

(1) 状态替换（L52-53）：

```tsx
const [gpuCapable, setGpuCapable] = useState(false);
const [gpuEnabled, setGpuEnabled] = useState(false);
const [gpuBackendLabel, setGpuBackendLabel] = useState('');
```

(2) `useEffect` 内 `checkAddonStatus` 整体替换为：

```tsx
// 检查 GPU 加速状态
const checkGpuStatus = async () => {
  try {
    const env = await window?.ipc?.invoke('get-gpu-environment');
    const capable = !!env && env.platform !== 'darwin';
    setGpuCapable(capable);
    if (!capable) return;

    const settings = await window?.ipc?.invoke('getSettings');
    const active = await window?.ipc?.invoke('get-active-backend');
    const labels: Record<string, string> = {
      cuda: 'CUDA',
      vulkan: 'Vulkan',
      cpu: 'CPU',
      custom: 'Custom',
    };
    const isCpuResult = active?.backend === 'cpu';
    setGpuEnabled(settings?.gpuMode !== 'cpu-only' && !isCpuResult);
    setGpuBackendLabel(
      active && !isCpuResult
        ? active.backend === 'cuda' && active.variant
          ? `CUDA ${active.variant}`
          : labels[active.backend] || active.backend
        : '',
    );
  } catch (error) {
    console.error('Failed to check GPU status:', error);
  }
};

checkGpuStatus();

// 一次性迁移通知（gpuMode 自动启用告知）
const checkMigrationNotice = async () => {
  try {
    const settings = await window?.ipc?.invoke('getSettings');
    if (settings?.gpuMigrationNotified === false) {
      toast.info(t('gpuMigrationNotice'), { duration: 10000 });
      await window?.ipc?.invoke('setSettings', {
        gpuMigrationNotified: true,
      });
    }
  } catch (error) {
    console.error('Failed to check migration notice:', error);
  }
};
checkMigrationNotice();

// 降级事件 toast（主进程已做会话内同原因去重）
const cleanupFallback = window?.ipc?.on(
  'addon-fallback',
  (event: { expected: string; actual: string; reason: string }) => {
    const labels: Record<string, string> = {
      cuda: 'CUDA',
      vulkan: 'Vulkan',
      cpu: 'CPU',
      metal: 'Metal',
      coreml: 'CoreML',
      custom: 'Custom',
    };
    toast.warning(
      t('gpuFallbackToast', {
        backend: labels[event.actual] || event.actual,
      }),
      { duration: 8000 },
    );
    checkGpuStatus();
  },
);

// 后端变更推送（转写实际加载后刷新头部徽章）
const cleanupBackendChanged = window?.ipc?.on('active-backend-changed', () => {
  checkGpuStatus();
});

// 监听 GPU 设置变更事件（由设置页面触发）
const handleGpuSettingsChanged = () => {
  checkGpuStatus();
};
window.addEventListener('gpu-settings-changed', handleGpuSettingsChanged);
```

(3) 清理函数追加（return 块内）：

```tsx
cleanupFallback?.();
cleanupBackendChanged?.();
```

（保留原 `cleanupMessage` / `cleanupUpdateStatus` / removeEventListener。）

(4) 头部指示器 JSX（原 `{cudaCapable && (...)}` 块）中变量替换：`cudaCapable` → `gpuCapable`、`cudaEnabled` → `gpuEnabled`，启用态文案行替换为：

```tsx
{
  gpuEnabled
    ? `${t('gpuAccelerationEnabled')}${gpuBackendLabel ? ` · ${gpuBackendLabel}` : ''}`
    : t('gpuAccelerationDisabled');
}
```

### 8b. `renderer/components/TaskStatus.tsx`

`status === 'loading'` 分支返回块替换为：

```tsx
return (
  <div className="flex items-center gap-1">
    <Loader className="animate-spin size-4" />
    <span className="text-xs">{displayProgress}%</span>
    {checkKey === 'extractSubtitle' && file.whisperBackend && (
      <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground whitespace-nowrap">
        {file.whisperBackend}
      </span>
    )}
  </div>
);
```

> `whisperBackend` 经 `taskFileChange` 通用 merge（`useIpcCommunication.handleFileChange` 的 `{ ...file, ...res }`）自动进入任务状态，hook 零改动。

**验证**：渲染层 scoped typecheck OK。

**提交**

```bash
git add renderer/components/Layout.tsx renderer/components/TaskStatus.tsx
git commit -m "feat: backend status indicator, fallback toast and migration notice in renderer"
```

---

## T9：终验

1. **完整 typecheck**：两条 scoped 命令 OK。
2. **构建门禁**：`yarn build`（与 CI 一致），必须成功。
3. **macOS 回归冒烟**（当前开发机）：重启 `yarn dev` →
   - 设置页：GPU 加速卡显示状态卡 + 检测详情（无三态开关/高级区，因 darwin）；
   - 跑一个短视频转写：任务行出现 `Metal` 或 `CoreML` 徽章；日志含 `Whisper addon loaded: backend=...`；
   - 迁移验证：手动删掉 config.json 中 settings.gpuMode 字段后重启 → 出现一次性迁移 toast，且 `gpuMigrationNotified` 置 true。
4. **win/linux 降级链模拟**（开发机可做的部分）：`DEV_SIMULATE_CUDA=true DEV_SIMULATE_PLATFORM=win32 yarn dev` → 设置页出现三态开关与 CUDA 分组；`DEV_SIMULATE_GPU_VENDOR=amd` → CUDA 组置灰。真实 Windows/Linux 矩阵（规格 8.1）留待 beta 阶段。
5. 全部通过后汇报，等待用户决定是否合并/发版（不主动 push）。

---

## 验收对照（规格 8.2）

| 标准                                   | 由哪些任务保证                                   |
| -------------------------------------- | ------------------------------------------------ |
| 零闪退（每级 dlopen try/catch）        | T5 addonLoader                                   |
| 状态卡后端 = 实际加载后端              | T5 lastAddonLoadResult + T7 状态卡 + T8 推送     |
| 降级必有 toast + 黄色状态卡            | T5 notifier + T7/T8                              |
| 新装用户零配置获得加速                 | T1 预置 + T3 默认 auto + T5 候选链               |
| 老 CUDA 用户行为不变                   | T5 候选链优先级 2（selected CUDA 在前）          |
| 自定义 addon / 断点续传 / 镜像源不回归 | T2 兼容映射 + T5 custom 最高优先级 + T7 保留入口 |
