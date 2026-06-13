import type {
  AddonLoadResultInfo,
  AddonVariant,
  GpuEnvironment,
  GpuMode,
} from '../../../../types/addon';
import { backendDisplay, resolveActiveBackendForPlatform } from './gpuUtils';

export type GpuOverviewKind =
  | 'darwin'
  | 'cpuManual'
  | 'gpuOnlyOnCpu'
  | 'gpuOnlyPending'
  | 'autoPending'
  | 'cpuFallback'
  | 'running';

export interface GpuDisplayState {
  isDarwin: boolean;
  gpuMode: GpuMode;
  gpuName: string;
  accelerationLabel: string;
  overviewKind: GpuOverviewKind;
  canUpgradeCuda: boolean;
  recommendedCudaVersion: string | null;
}

export function deriveGpuDisplayState(
  gpuEnv: GpuEnvironment,
  gpuMode: GpuMode,
  activeBackend: AddonLoadResultInfo | null,
  selectedVersion: AddonVariant | null = null,
  customAddonPath: string | null = null,
): GpuDisplayState {
  const isDarwin = gpuEnv.platform === 'darwin';
  const effective = resolveActiveBackendForPlatform(activeBackend, gpuEnv);
  const recommendation = gpuEnv.nvidia?.recommendation;
  const isCudaActive = effective?.backend === 'cuda';
  const recommendedCudaVersion = recommendation?.recommendedVersion ?? null;

  const canUpgradeCuda =
    !isDarwin &&
    gpuMode !== 'cpu-only' &&
    !!recommendation?.canUseCuda &&
    !!recommendedCudaVersion &&
    !isCudaActive &&
    !(selectedVersion && selectedVersion !== 'vulkan') &&
    !customAddonPath;

  const gpuName =
    gpuEnv.gpus?.[0]?.name || gpuEnv.nvidia?.gpuSupport?.gpuName || '';

  const base = {
    isDarwin,
    gpuMode,
    gpuName,
    canUpgradeCuda,
    recommendedCudaVersion,
  };

  if (isDarwin) {
    return {
      ...base,
      accelerationLabel: effective ? backendDisplay(effective) : '',
      overviewKind: 'darwin',
    };
  }

  if (gpuMode === 'cpu-only') {
    return {
      ...base,
      accelerationLabel: '',
      overviewKind: 'cpuManual',
    };
  }

  if (gpuMode === 'gpu-only') {
    if (effective?.backend === 'cpu') {
      return {
        ...base,
        accelerationLabel: 'CPU',
        overviewKind: 'gpuOnlyOnCpu',
      };
    }
    if (!effective) {
      return {
        ...base,
        accelerationLabel: '',
        overviewKind: 'gpuOnlyPending',
      };
    }
    return {
      ...base,
      accelerationLabel: backendDisplay(effective),
      overviewKind: 'running',
    };
  }

  // auto
  if (!effective) {
    return {
      ...base,
      accelerationLabel: '',
      overviewKind: 'autoPending',
    };
  }
  if (effective.backend === 'cpu') {
    return {
      ...base,
      accelerationLabel: 'CPU',
      overviewKind: 'cpuFallback',
    };
  }
  return {
    ...base,
    accelerationLabel: backendDisplay(effective),
    overviewKind: 'running',
  };
}

export function isGpuAccelerationActive(state: GpuDisplayState): boolean {
  return (
    state.overviewKind === 'running' ||
    (state.isDarwin && !!state.accelerationLabel)
  );
}
