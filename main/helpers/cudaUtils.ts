import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as si from 'systeminformation';
import { logMessage } from './storeManager';
import { getExtraResourcesPath, isAppleSilicon } from './utils';

/**
 * 异步执行外部命令（不阻塞主进程 event loop）。
 * GPU/CUDA 探测（nvcc / nvidia-smi）首次冷启动可能耗时数秒，必须异步执行，
 * 否则同步 execSync 会卡死主进程，连带阻塞所有并发 IPC（引擎/模型状态等），UI 卡顿。
 */
const execAsync = promisify(exec);
import type {
  CudaEnvironment,
  CudaToolkitInfo,
  GpuCudaSupport,
  AddonRecommendation,
  CudaVersion,
  DevSimulationConfig,
  GpuEnvironment,
  GpuInfo,
  GpuVendor,
} from '../../types/addon';
import { AVAILABLE_CUDA_VERSIONS } from '../../types/addon';

/**
 * 开发模式模拟配置
 * 通过环境变量控制，仅在开发模式下生效
 */
export function getDevSimulationConfig(): DevSimulationConfig | null {
  // 仅在开发模式下启用模拟
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  if (process.env.DEV_SIMULATE_CUDA !== 'true') {
    return null;
  }

  return {
    enabled: true,
    platform:
      (process.env.DEV_SIMULATE_PLATFORM as 'win32' | 'linux') || 'win32',
    hasToolkit: process.env.DEV_SIMULATE_HAS_TOOLKIT === 'true',
    toolkitVersion: process.env.DEV_SIMULATE_CUDA_TOOLKIT || null,
    gpuCudaVersion: process.env.DEV_SIMULATE_GPU_CUDA_VERSION || '12.6',
    gpuName:
      process.env.DEV_SIMULATE_GPU_NAME ||
      'NVIDIA GeForce RTX 3080 (Simulated)',
  };
}

/**
 * 检测 CUDA Toolkit 安装情况
 * 通过检测 nvcc 命令来判断
 */
export async function getCudaToolkitInfo(): Promise<CudaToolkitInfo> {
  // 检查开发模式模拟
  const simConfig = getDevSimulationConfig();
  if (simConfig?.enabled) {
    logMessage('[Dev Simulation] Using simulated CUDA Toolkit info', 'info');
    return {
      installed: simConfig.hasToolkit,
      version: simConfig.toolkitVersion,
    };
  }

  // 仅支持 Windows 和 Linux 平台
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return { installed: false, version: null };
  }

  try {
    const { stdout: nvccOutput } = await execAsync('nvcc --version', {
      encoding: 'utf8',
      timeout: 5000,
    });

    // 解析 nvcc 输出获取版本号
    // 示例输出: "Cuda compilation tools, release 12.4, V12.4.99"
    const versionMatch = nvccOutput.match(/release (\d+\.\d+)/i);
    if (versionMatch) {
      const majorMinor = versionMatch[1];
      // 补充完整版本号
      const fullVersionMatch = nvccOutput.match(/V(\d+\.\d+\.\d+)/);
      const version = fullVersionMatch
        ? fullVersionMatch[1]
        : `${majorMinor}.0`;

      logMessage(`CUDA Toolkit detected: ${version}`, 'info');
      return { installed: true, version };
    }

    return { installed: true, version: null };
  } catch {
    logMessage('CUDA Toolkit not detected (nvcc not found)', 'info');
    return { installed: false, version: null };
  }
}

/**
 * 检测 GPU CUDA 支持情况
 * 通过 nvidia-smi 命令来判断
 */
export async function getGpuCudaSupport(): Promise<GpuCudaSupport> {
  // 检查开发模式模拟
  const simConfig = getDevSimulationConfig();
  if (simConfig?.enabled) {
    logMessage('[Dev Simulation] Using simulated GPU CUDA support', 'info');
    return {
      supported: true,
      driverVersion: '535.104.05',
      maxCudaVersion: simConfig.gpuCudaVersion,
      gpuName: simConfig.gpuName,
    };
  }

  // 仅支持 Windows 和 Linux 平台
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return { supported: false, driverVersion: null, maxCudaVersion: null };
  }

  // 优先使用机器可读查询获取显卡名与驱动版本：
  // 跨驱动版本、跨语言环境最稳定，且不会像解析表格那样误匹配到进程行
  let gpuName: string | undefined;
  let driverVersion: string | null = null;
  try {
    const queryOutput = (
      await execAsync(
        'nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 10000 },
      )
    ).stdout.trim();
    const firstLine = queryOutput.split('\n').find((line) => line.trim());
    if (firstLine) {
      const [queriedName, queriedDriver] = firstLine
        .split(',')
        .map((field) => field.trim());
      gpuName = queriedName || undefined;
      driverVersion = queriedDriver || null;
    }
  } catch {
    // 查询接口不可用时，下面回退到解析 nvidia-smi 文本输出
  }

  // 解析显卡支持的最高 CUDA 版本（--query-gpu 无此字段，只能从 nvidia-smi 表头读取）
  let maxCudaVersion: string | null = null;
  try {
    const { stdout: nsmiResult } = await execAsync('nvidia-smi', {
      encoding: 'utf8',
      timeout: 10000,
    });

    // 600 系列及以上驱动已将 "CUDA Version" 更名为 "CUDA UMD Version"，需同时兼容
    const cudaVersionMatch = nsmiResult.match(
      /CUDA(?:\s+UMD)?\s+Version\s*:\s*(\d+(?:\.\d+)?)/i,
    );
    maxCudaVersion = cudaVersionMatch ? cudaVersionMatch[1] : null;

    // 查询接口失败时从表格兜底补全驱动版本：
    // 兼容新版 "KMD Version" 与旧版 "Driver Version"，允许 2~3 段版本号（如 610.47）
    if (!driverVersion) {
      const driverVersionMatch = nsmiResult.match(
        /(?:KMD|Driver)\s+Version\s*:\s*(\d+(?:\.\d+)+)/i,
      );
      driverVersion = driverVersionMatch ? driverVersionMatch[1] : null;
    }

    // 查询接口失败时从表格兜底补全显卡名称：限定 NVIDIA 开头，避免误匹配进程行
    if (!gpuName) {
      const gpuNameMatch = nsmiResult.match(
        /\|\s*\d+\s+(NVIDIA[^|]+?)\s+(?:On|Off|N\/A)/i,
      );
      gpuName = gpuNameMatch ? gpuNameMatch[1].trim() : undefined;
    }
  } catch {
    // bare nvidia-smi 不可用时，maxCudaVersion 保持 null
  }

  // 只要检测到 NVIDIA 显卡（拿到名称或驱动版本）即视为支持 CUDA，
  // 即使因输出格式变化导致 CUDA 版本解析失败，也不再误判为"不支持"
  const hasNvidiaGpu = !!gpuName || !!driverVersion;
  const supported = !!maxCudaVersion || hasNvidiaGpu;

  if (!supported) {
    logMessage(
      'GPU CUDA support not detected (no NVIDIA GPU found via nvidia-smi)',
      'info',
    );
    return { supported: false, driverVersion: null, maxCudaVersion: null };
  }

  logMessage(
    `GPU CUDA support detected: maxCuda=${maxCudaVersion}, driver=${driverVersion}, gpu=${gpuName}`,
    'info',
  );

  return {
    supported,
    driverVersion,
    maxCudaVersion,
    gpuName,
  };
}

/**
 * 比较版本号
 * @returns 负数表示 v1 < v2, 0 表示相等, 正数表示 v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) {
      return p1 - p2;
    }
  }
  return 0;
}

/**
 * 提取版本号的 major.minor 部分
 * 例如 "13.0.2" -> "13.0", "12.4.0" -> "12.4"
 */
function getMajorMinor(version: string): string {
  const parts = version.split('.');
  return `${parts[0] || '0'}.${parts[1] || '0'}`;
}

/**
 * 获取推荐的加速包版本
 * 根据用户的 CUDA 版本，找到最合适的可用版本
 *
 * nvidia-smi 报告的 CUDA 版本 (如 "13.0") 表示驱动支持的最高 CUDA 运行时版本族，
 * 即 13.0.x 系列的补丁版本都是兼容的。因此匹配时只比较 major.minor，忽略 patch。
 *
 * 同时，新架构的 GPU（如 Blackwell）可能不被旧版 CUDA toolkit 支持，
 * 所以在兼容范围内优先推荐最高版本。
 *
 * @param userCudaVersion 用户的 CUDA 版本 (如 "12.6" 或 "13.0")
 * @returns 推荐的加速包版本，如果没有合适的则返回 null
 */
export function getRecommendedAddonVersion(
  userCudaVersion: string,
): CudaVersion | null {
  const userMajorMinor = getMajorMinor(userCudaVersion);

  // 从高到低遍历可用版本，找到第一个 major.minor 不超过用户版本的
  // 这样同系列的 patch 版本（如 13.0.2 对应驱动 13.0）也能正确匹配
  for (const version of [...AVAILABLE_CUDA_VERSIONS].reverse()) {
    const addonMajorMinor = getMajorMinor(version);
    if (compareVersions(addonMajorMinor, userMajorMinor) <= 0) {
      return version;
    }
  }

  return null;
}

/**
 * 获取加速包推荐信息
 */
function getAddonRecommendation(
  toolkit: CudaToolkitInfo,
  gpuSupport: GpuCudaSupport,
): AddonRecommendation {
  // 未检测到 NVIDIA 显卡时无法使用加速
  if (!gpuSupport.supported) {
    return {
      canUseCuda: false,
      recommendedVersion: null,
      needsDlls: false,
      downloadType: null,
      reason: 'GPU 不支持 CUDA 或未检测到 NVIDIA 显卡',
      reasonKey: 'cudaNotSupported',
    };
  }

  // 兜底：检测到 N 卡但未能解析出最高 CUDA 版本时（如新版驱动输出格式变化），
  // 按可用加速包的最高版本推荐，避免误判为不可用；用户可在异常时手动改选更低版本
  const effectiveCudaVersion =
    gpuSupport.maxCudaVersion ||
    AVAILABLE_CUDA_VERSIONS[AVAILABLE_CUDA_VERSIONS.length - 1];

  // 获取推荐版本
  const recommendedVersion = getRecommendedAddonVersion(effectiveCudaVersion);

  if (!recommendedVersion) {
    return {
      canUseCuda: false,
      recommendedVersion: null,
      needsDlls: false,
      downloadType: null,
      reason: `显卡支持的 CUDA 版本 (${gpuSupport.maxCudaVersion}) 低于最低要求 (11.8.0)`,
      reasonKey: 'cudaVersionTooOld',
    };
  }

  // 判断是否需要下载带 DLLs 的包
  // 如果用户已安装 CUDA Toolkit，只需下载 addon.node
  // 如果未安装，需要下载包含运行时库的完整包
  const needsDlls = !toolkit.installed;
  const downloadType = needsDlls ? 'tar.gz' : 'node.gz';

  let reason: string;
  let reasonKey: AddonRecommendation['reasonKey'];
  if (!gpuSupport.maxCudaVersion) {
    reason = `未能识别显卡支持的最高 CUDA 版本，已按最高加速包版本推荐；若运行异常请手动选择更低版本`;
    reasonKey = 'maxCudaUnknown';
  } else if (toolkit.installed) {
    reason = `已检测到 CUDA Toolkit ${toolkit.version}，推荐下载轻量版加速包`;
    reasonKey = 'toolkitInstalled';
  } else {
    reason = `未检测到 CUDA Toolkit，推荐下载包含运行时库的完整加速包`;
    reasonKey = 'toolkitMissing';
  }

  return {
    canUseCuda: true,
    recommendedVersion,
    needsDlls,
    downloadType,
    reason,
    reasonKey,
  };
}

/**
 * 获取完整的 CUDA 环境信息
 * 这是主要的对外接口
 */
export async function getCudaEnvironment(): Promise<CudaEnvironment> {
  const cudaToolkit = await getCudaToolkitInfo();
  const gpuSupport = await getGpuCudaSupport();
  const recommendation = getAddonRecommendation(cudaToolkit, gpuSupport);

  logMessage(
    `CUDA Environment: toolkit=${JSON.stringify(cudaToolkit)}, gpu=${JSON.stringify(gpuSupport)}, recommendation=${JSON.stringify(recommendation)}`,
    'info',
  );

  return {
    cudaToolkit,
    gpuSupport,
    recommendation,
  };
}

/**
 * 检查系统是否支持 CUDA 并返回支持的版本
 * @deprecated 请使用 getCudaEnvironment() 获取更详细的信息
 */
export async function checkCudaSupport(): Promise<string | false> {
  const env = await getCudaEnvironment();

  if (!env.recommendation.canUseCuda) {
    return false;
  }

  return env.recommendation.recommendedVersion || false;
}

/**
 * 检查当前平台是否可能支持 CUDA
 */
export function isPlatformCudaCapable(): boolean {
  // 检查开发模式模拟
  const simConfig = getDevSimulationConfig();
  if (simConfig?.enabled) {
    return simConfig.platform === 'win32' || simConfig.platform === 'linux';
  }

  return process.platform === 'win32' || process.platform === 'linux';
}

/**
 * 获取当前有效的平台
 * 在开发模式模拟时返回模拟平台
 */
export function getEffectivePlatform(): NodeJS.Platform {
  const simConfig = getDevSimulationConfig();
  if (simConfig?.enabled) {
    return simConfig.platform;
  }
  return process.platform;
}

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
  const simConfig = getDevSimulationConfig();
  if (simConfig?.enabled) {
    return [{ name: simConfig.gpuName, vendor: 'nvidia' }];
  }

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
  const nvidia = shouldProbeNvidia ? await getCudaEnvironment() : null;

  cachedGpuEnvironment = {
    platform,
    appleSilicon: isAppleSilicon(),
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
