import {
  resolveSelectedCudaGpu,
  sanitizeSelectedCudaDevice,
} from '../../types/gpuDevice';
import type { GpuInfo } from '../../types/addon';

const MANAGED_MARKER = 'SMARTSUB_CUDA_SELECTION_MANAGED';
const ORIGINAL_VALUE = 'SMARTSUB_ORIGINAL_CUDA_VISIBLE_DEVICES';
const UNSET_SENTINEL = '__SMARTSUB_CUDA_VISIBLE_DEVICES_UNSET__';

function rememberInheritedCudaVisibility(env: NodeJS.ProcessEnv): void {
  if (env[MANAGED_MARKER] === '1') return;
  env[ORIGINAL_VALUE] = env.CUDA_VISIBLE_DEVICES ?? UNSET_SENTINEL;
  env[MANAGED_MARKER] = '1';
}

/**
 * Apply the persisted CUDA GPU selection to this process. Child/utility
 * processes inherit it, so whisper.cpp, sherpa-onnx and faster-whisper all see
 * the selected physical card as logical device 0.
 *
 * The original environment is carried across Electron relaunches so switching
 * back to "Auto" restores a user-supplied CUDA_VISIBLE_DEVICES value instead
 * of discarding it.
 */
export function applyCudaDeviceSelection(
  selectedDevice: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  rememberInheritedCudaVisibility(env);
  const selected = sanitizeSelectedCudaDevice(selectedDevice);
  if (selected) {
    env.CUDA_VISIBLE_DEVICES = selected;
    return selected;
  }

  const original = env[ORIGINAL_VALUE];
  if (original === undefined || original === UNSET_SENTINEL) {
    delete env.CUDA_VISIBLE_DEVICES;
  } else {
    env.CUDA_VISIBLE_DEVICES = original;
  }
  return '';
}

export function validateSelectedCudaDevice(
  selectedDevice: unknown,
  gpus: readonly GpuInfo[],
): string {
  const selected = sanitizeSelectedCudaDevice(selectedDevice);
  if (!selected) return '';
  return resolveSelectedCudaGpu(gpus, selected)?.uuid ?? '';
}

interface NvidiaGpuEnumerationSnapshot {
  status: 'success' | 'failed';
  gpus: readonly GpuInfo[];
}

export interface StartupCudaDeviceResolution {
  selectedDevice: string;
  clearPersistedSelection: boolean;
}

export function resolveStartupCudaDeviceSelection(
  selectedDevice: unknown,
  enumeration: NvidiaGpuEnumerationSnapshot,
): StartupCudaDeviceResolution {
  const selected = sanitizeSelectedCudaDevice(selectedDevice);
  if (!selected || enumeration.status === 'failed') {
    return {
      selectedDevice: selected,
      clearPersistedSelection: false,
    };
  }

  const validated = validateSelectedCudaDevice(selected, enumeration.gpus);
  return {
    selectedDevice: validated,
    clearPersistedSelection: !validated,
  };
}
