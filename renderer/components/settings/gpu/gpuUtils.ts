import type {
  AddonLoadResultInfo,
  GpuEnvironment,
} from '../../../../types/addon';

export const BACKEND_LABELS: Record<string, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  cpu: 'CPU',
  metal: 'Metal',
  coreml: 'CoreML',
  custom: 'Custom',
};

export function backendDisplay(info: AddonLoadResultInfo | null): string {
  if (!info) return '';
  if (info.backend === 'cuda' && info.variant && info.variant !== 'vulkan') {
    return `CUDA ${info.variant}`;
  }
  return BACKEND_LABELS[info.backend] || info.backend;
}

/** macOS 转写结果在 Windows 模拟下、或反之，不应作为当前平台状态展示 */
export function isActiveBackendStaleForPlatform(
  active: AddonLoadResultInfo | null,
  gpuEnv: GpuEnvironment,
): boolean {
  if (!active) return false;
  const isDesktop = gpuEnv.platform !== 'darwin';
  if (
    isDesktop &&
    (active.backend === 'metal' || active.backend === 'coreml')
  ) {
    return true;
  }
  if (
    !isDesktop &&
    (active.backend === 'cuda' ||
      active.backend === 'vulkan' ||
      active.backend === 'custom')
  ) {
    return true;
  }
  return false;
}

export function resolveActiveBackendForPlatform(
  active: AddonLoadResultInfo | null,
  gpuEnv: GpuEnvironment,
): AddonLoadResultInfo | null {
  if (isActiveBackendStaleForPlatform(active, gpuEnv)) return null;
  return active;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export type StatusTone = 'green' | 'yellow' | 'gray' | 'neutral';

export const statusToneClasses: Record<StatusTone, string> = {
  green: 'border-success/40 bg-success/10',
  yellow: 'border-warning/40 bg-warning/10',
  gray: 'border-muted bg-muted/40',
  neutral: 'border-muted bg-muted/40',
};
