import {
  AVAILABLE_CUDA_VERSIONS,
  type CudaVersion,
  type DownloadSource,
  type GpuEnvironment,
  type RemoteAddonVersions,
} from '../../../../types/addon';
import type { PackageEdition } from './types';

const ADDON_DOWNLOAD_SOURCE_KEY = 'addonDownloadSource';
const CUDA_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

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

/** 比较完整 semver（用于排序） */
export function compareCudaVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 从远程 addon-versions.json 解析 CUDA 版本列表；失败时回退到内置常量
 */
export function parseRemoteCudaVersions(
  remote: RemoteAddonVersions | null | undefined,
): CudaVersion[] {
  if (!remote) return [...AVAILABLE_CUDA_VERSIONS];
  const keys = Object.keys(remote).filter(
    (k) => k !== 'vulkan' && CUDA_VERSION_PATTERN.test(k),
  ) as CudaVersion[];
  if (keys.length === 0) return [...AVAILABLE_CUDA_VERSIONS];
  return keys.sort(compareCudaVersion).reverse();
}

export function getCompatibleCudaVersions(
  gpuEnv: GpuEnvironment,
  availableVersions: CudaVersion[] = parseRemoteCudaVersions(undefined),
): CudaVersion[] {
  const maxCuda = gpuEnv.nvidia?.gpuSupport.maxCudaVersion;
  if (!maxCuda) return availableVersions;
  return availableVersions.filter(
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

export function readPersistedDownloadSource(): DownloadSource {
  if (typeof window === 'undefined') return 'github';
  const v = localStorage.getItem(ADDON_DOWNLOAD_SOURCE_KEY);
  if (v === 'ghproxy' || v === 'gitcode' || v === 'github') {
    return v;
  }
  return 'github';
}

export function persistDownloadSource(source: DownloadSource): void {
  localStorage.setItem(ADDON_DOWNLOAD_SOURCE_KEY, source);
}

export async function fetchPackageSizeHints(
  variant: CudaVersion,
  source: DownloadSource,
): Promise<{ full: number | null; lite: number | null }> {
  const [full, lite] = await Promise.all([
    window?.ipc?.invoke('get-addon-package-size', {
      variant,
      type: 'tar.gz',
      source,
    }),
    window?.ipc?.invoke('get-addon-package-size', {
      variant,
      type: 'node.gz',
      source,
    }),
  ]);
  return {
    full: typeof full === 'number' ? full : null,
    lite: typeof lite === 'number' ? lite : null,
  };
}

export { ADDON_DOWNLOAD_SOURCE_KEY };

/** Map backend recommendation reasonKey to localized sentence */
export function getRecommendationReasonText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  reasonKey?: string,
): string | null {
  if (!reasonKey) return null;
  const key = `gpuAcceleration.recommendReason.${reasonKey}`;
  const text = t(key);
  return text === key ? null : text;
}
