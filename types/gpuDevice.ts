import type { GpuInfo } from './addon';

/**
 * NVIDIA UUIDs are stable across restarts and accepted directly by
 * CUDA_VISIBLE_DEVICES. Persisting an index would silently select a different
 * card when PCI enumeration order changes.
 */
const NVIDIA_GPU_UUID_RE = /^GPU-[A-Za-z0-9-]+$/;

/** Parse `nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader`. */
export function parseNvidiaSmiGpuList(output: string): GpuInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): GpuInfo | null => {
      const [indexRaw, uuidRaw, ...nameParts] = line.split(',');
      const index = Number(indexRaw?.trim());
      const uuid = uuidRaw?.trim();
      const name = nameParts.join(',').trim();
      if (
        !Number.isInteger(index) ||
        !NVIDIA_GPU_UUID_RE.test(uuid || '') ||
        !name
      ) {
        return null;
      }
      return { name, vendor: 'nvidia' as const, index, uuid };
    })
    .filter((gpu): gpu is GpuInfo => gpu !== null);
}

export function sanitizeSelectedCudaDevice(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return NVIDIA_GPU_UUID_RE.test(normalized) ? normalized : '';
}

export function selectableNvidiaGpus(gpus: readonly GpuInfo[]): GpuInfo[] {
  return gpus.filter(
    (gpu) =>
      gpu.vendor === 'nvidia' &&
      Number.isInteger(gpu.index) &&
      !!sanitizeSelectedCudaDevice(gpu.uuid),
  );
}

export function resolveSelectedCudaGpu(
  gpus: readonly GpuInfo[],
  selectedDevice: unknown,
): GpuInfo | null {
  const uuid = sanitizeSelectedCudaDevice(selectedDevice);
  if (!uuid) return null;
  return (
    selectableNvidiaGpus(gpus).find(
      (gpu) => gpu.uuid?.toLowerCase() === uuid.toLowerCase(),
    ) ?? null
  );
}
