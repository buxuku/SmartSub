/**
 * CUDA 加速包相关类型定义
 */

/**
 * 可用的 CUDA 加速包版本
 */
export const AVAILABLE_CUDA_VERSIONS = [
  '11.8.0',
  '12.2.0',
  '12.4.0',
  '13.0.2',
] as const;

export type CudaVersion = (typeof AVAILABLE_CUDA_VERSIONS)[number];

/**
 * CUDA Toolkit 检测结果
 */
export interface CudaToolkitInfo {
  /** 是否已安装 CUDA Toolkit */
  installed: boolean;
  /** CUDA Toolkit 版本号 (如 "12.4.0") */
  version: string | null;
}

/**
 * GPU CUDA 支持检测结果
 */
export interface GpuCudaSupport {
  /** 显卡是否支持 CUDA */
  supported: boolean;
  /** 显卡驱动版本 */
  driverVersion: string | null;
  /** 显卡支持的最高 CUDA 版本 */
  maxCudaVersion: string | null;
  /** 显卡名称 */
  gpuName?: string;
}

/**
 * 加速包推荐信息
 */
export interface AddonRecommendation {
  /** 是否可以使用 CUDA 加速 */
  canUseCuda: boolean;
  /** 推荐的加速包版本 */
  recommendedVersion: CudaVersion | null;
  /** 是否需要下载包含 DLLs 的完整包 */
  needsDlls: boolean;
  /** 推荐的下载包类型 */
  downloadType: 'node.gz' | 'tar.gz' | null;
  /** 推荐原因说明 */
  reason?: string;
}

/**
 * CUDA 环境完整检测结果
 */
export interface CudaEnvironment {
  /** CUDA Toolkit 信息 */
  cudaToolkit: CudaToolkitInfo;
  /** GPU CUDA 支持信息 */
  gpuSupport: GpuCudaSupport;
  /** 加速包推荐 */
  recommendation: AddonRecommendation;
}

/**
 * 已安装的加速包信息
 */
export interface InstalledAddon {
  /** 安装时间 */
  installedAt: string;
  /** 下载时的远程版本号 (用于更新检测) */
  remoteVersion: string;
  /** 是否包含 DLLs/SO 文件 */
  hasDlls: boolean;
  /** 文件大小 (字节) */
  size: number;
  /** 文件校验和 */
  checksum?: string;
}

/**
 * 加速包配置
 */
export interface AddonConfig {
  /** 当前选中的版本 */
  selectedVersion: CudaVersion | null;
  /** 已安装的加速包 */
  installed: Record<string, InstalledAddon>;
}

/**
 * 远程加速包版本信息
 */
export interface RemoteAddonVersion {
  /** 版本日期 (用于更新检测) */
  version: string;
  /** 更新说明 */
  updateNotes: string;
  /** 校验和信息 */
  checksum?: {
    'windows-tar'?: string;
    'windows-node'?: string;
    'linux-tar'?: string;
    'linux-node'?: string;
  };
}

/**
 * 远程版本文件结构
 */
export type RemoteAddonVersions = Record<CudaVersion, RemoteAddonVersion>;

/**
 * 下载状态
 */
export type DownloadStatus =
  | 'idle'
  | 'downloading'
  | 'paused'
  | 'extracting'
  | 'verifying'
  | 'completed'
  | 'error';

/**
 * 下载进度信息
 */
export interface DownloadProgress {
  /** 下载状态 */
  status: DownloadStatus;
  /** 下载进度百分比 (0-100) */
  progress: number;
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数 */
  total: number;
  /** 下载速度 (字节/秒) */
  speed: number;
  /** 预计剩余时间 (秒) */
  eta: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 下载源类型
 */
export type DownloadSource = 'github' | 'ghproxy';

/**
 * 下载配置
 */
export interface DownloadConfig {
  /** 下载源 */
  source: DownloadSource;
  /** CUDA 版本 */
  cudaVersion: CudaVersion;
  /** 下载类型 */
  type: 'node.gz' | 'tar.gz';
}

/**
 * 更新检测结果
 */
export interface AddonUpdateInfo {
  /** CUDA 版本 */
  cudaVersion: CudaVersion;
  /** 是否有更新 */
  hasUpdate: boolean;
  /** 当前本地版本 */
  localVersion: string;
  /** 远程最新版本 */
  remoteVersion: string;
  /** 更新说明 */
  updateNotes?: string;
}

/**
 * 下载状态持久化信息 (用于断点续传)
 */
export interface DownloadState {
  /** 下载 URL */
  url: string;
  /** 目标路径 */
  destPath: string;
  /** 临时文件路径 */
  tempPath: string;
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数 */
  total: number;
  /** CUDA 版本 */
  cudaVersion: CudaVersion;
  /** 下载类型 */
  downloadType: 'node.gz' | 'tar.gz';
  /** 开始时间 */
  startedAt: string;
  /** 最后更新时间 */
  lastUpdatedAt: string;
}

/**
 * 开发模式模拟配置
 */
export interface DevSimulationConfig {
  /** 是否启用模拟 */
  enabled: boolean;
  /** 模拟平台 */
  platform: 'win32' | 'linux';
  /** 是否安装了 CUDA Toolkit */
  hasToolkit: boolean;
  /** CUDA Toolkit 版本 */
  toolkitVersion: string | null;
  /** GPU 支持的最高 CUDA 版本 */
  gpuCudaVersion: string;
  /** 显卡名称 */
  gpuName: string;
}
