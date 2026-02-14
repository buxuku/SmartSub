import { execSync } from 'child_process';
import { logMessage } from './storeManager';
import type {
  CudaEnvironment,
  CudaToolkitInfo,
  GpuCudaSupport,
  AddonRecommendation,
  CudaVersion,
  DevSimulationConfig,
} from '../../types/addon';
import { AVAILABLE_CUDA_VERSIONS } from '../../types/addon';

/**
 * 开发模式模拟配置
 * 通过环境变量控制，仅在开发模式下生效
 */
function getDevSimulationConfig(): DevSimulationConfig | null {
  // 仅在开发模式下启用模拟
  if (process.env.NODE_ENV !== 'development') {
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
export function getCudaToolkitInfo(): CudaToolkitInfo {
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
    const nvccOutput = execSync('nvcc --version', {
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
export function getGpuCudaSupport(): GpuCudaSupport {
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

  try {
    const nsmiResult = execSync('nvidia-smi', {
      encoding: 'utf8',
      timeout: 10000,
    });

    // 提取 CUDA 版本
    const cudaVersionMatch = nsmiResult.match(/CUDA Version:\s*(\d+\.\d+)/);
    const maxCudaVersion = cudaVersionMatch ? cudaVersionMatch[1] : null;

    // 提取驱动版本
    const driverVersionMatch = nsmiResult.match(
      /Driver Version:\s*(\d+\.\d+\.\d+)/,
    );
    const driverVersion = driverVersionMatch ? driverVersionMatch[1] : null;

    // 提取 GPU 名称
    const gpuNameMatch = nsmiResult.match(/\|\s+(\d+)\s+([^|]+?)\s+(?:On|Off)/);
    const gpuName = gpuNameMatch ? gpuNameMatch[2].trim() : undefined;

    logMessage(
      `GPU CUDA support detected: maxCuda=${maxCudaVersion}, driver=${driverVersion}, gpu=${gpuName}`,
      'info',
    );

    return {
      supported: !!maxCudaVersion,
      driverVersion,
      maxCudaVersion,
      gpuName,
    };
  } catch {
    logMessage(
      'GPU CUDA support not detected (nvidia-smi not found or failed)',
      'info',
    );
    return { supported: false, driverVersion: null, maxCudaVersion: null };
  }
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
  // 如果 GPU 不支持 CUDA，无法使用加速
  if (!gpuSupport.supported || !gpuSupport.maxCudaVersion) {
    return {
      canUseCuda: false,
      recommendedVersion: null,
      needsDlls: false,
      downloadType: null,
      reason: 'GPU 不支持 CUDA 或未检测到 NVIDIA 显卡',
    };
  }

  // 获取推荐版本
  const recommendedVersion = getRecommendedAddonVersion(
    gpuSupport.maxCudaVersion,
  );

  if (!recommendedVersion) {
    return {
      canUseCuda: false,
      recommendedVersion: null,
      needsDlls: false,
      downloadType: null,
      reason: `显卡支持的 CUDA 版本 (${gpuSupport.maxCudaVersion}) 低于最低要求 (11.8.0)`,
    };
  }

  // 判断是否需要下载带 DLLs 的包
  // 如果用户已安装 CUDA Toolkit，只需下载 addon.node
  // 如果未安装，需要下载包含运行时库的完整包
  const needsDlls = !toolkit.installed;
  const downloadType = needsDlls ? 'tar.gz' : 'node.gz';

  let reason: string;
  if (toolkit.installed) {
    reason = `已检测到 CUDA Toolkit ${toolkit.version}，推荐下载轻量版加速包`;
  } else {
    reason = `未检测到 CUDA Toolkit，推荐下载包含运行时库的完整加速包`;
  }

  return {
    canUseCuda: true,
    recommendedVersion,
    needsDlls,
    downloadType,
    reason,
  };
}

/**
 * 获取完整的 CUDA 环境信息
 * 这是主要的对外接口
 */
export function getCudaEnvironment(): CudaEnvironment {
  const cudaToolkit = getCudaToolkitInfo();
  const gpuSupport = getGpuCudaSupport();
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
export function checkCudaSupport(): string | false {
  const env = getCudaEnvironment();

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
