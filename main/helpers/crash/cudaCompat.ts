/**
 * CUDA 加速包与显卡算力（compute capability）的兼容判断。纯函数，不碰 electron。
 *
 * 为什么要有：CUDA 包按固定的 GPU 架构列表编译，显卡的算力不在列表里时，
 * 加载也许成功，真正跑核函数时却会以 “no kernel image is available” 中止进程。
 * 这里在加载之前就把这样的候选剔掉，让降级链（Vulkan / CPU）接手。
 *
 * 判断原则同 CPU 指令集预警：只在“确凿”时才剔除——
 * 要求相关显卡的算力全都已知，且全都低于该包的最低算力；任何一块未知或达标就保留。
 */
import type { GpuInfo } from '../../../types/addon';
import { sanitizeSelectedCudaDevice } from '../../../types/gpuDevice';

/**
 * 各 CUDA 加速包支持的最低算力。
 *
 * 只收录核对过构建配置的包：buxuku/whisper.cpp 分支 builder 的 .github/workflows/builder.yml
 * （2026-10-09 读取）里，13.0.2 的 CMAKE_CUDA_ARCHITECTURES 是 75;80;86;89;90;90-virtual，
 * CUDA 13 去掉了 Turing 之前的架构，所以最低 7.5。
 *
 * 12.4.0 用 all-major（CUDA 12.4 下为 50 到 90），最低 5.0；而算力低于 5.0 的显卡驱动只到 CUDA 11 时代，
 * 本来就推荐不到 12.x 包，所以不收录。11.8.0 与 12.2.0 是旧包，当前构建流程里已没有，
 * 核对不到就不过滤。
 */
export const CUDA_PACKAGE_MIN_COMPUTE_CAPABILITY: Readonly<
  Record<string, number>
> = {
  '13.0.2': 7.5,
};

/**
 * 解析 `nvidia-smi --query-gpu=uuid,compute_cap --format=csv,noheader,nounits`。
 * 旧驱动不认识 compute_cap 字段（整条查询失败，由调用方当作“全部未知”），
 * 个别显卡会给出 [N/A] 之类的值，同样跳过。
 */
export function parseNvidiaSmiComputeCaps(output: string): Map<string, number> {
  const caps = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const [uuidRaw, capRaw] = line.split(',').map((field) => field.trim());
    if (!uuidRaw || !capRaw || !/^\d+\.\d+$/.test(capRaw)) continue;
    caps.set(uuidRaw.toLowerCase(), Number(capRaw));
  }
  return caps;
}

/** 把算力写到对应显卡上（按 UUID 对应）；查不到的显卡保持未知。 */
export function attachComputeCapabilities(
  gpus: GpuInfo[],
  caps: Map<string, number>,
): GpuInfo[] {
  return gpus.map((gpu) => {
    const cap = gpu.uuid ? caps.get(gpu.uuid.toLowerCase()) : undefined;
    return cap === undefined ? gpu : { ...gpu, computeCapability: cap };
  });
}

export interface CudaIncompatibility {
  minComputeCapability: number;
  /** 人读的说明，同时写进日志与加载失败记录 */
  reason: string;
}

/**
 * 该 CUDA 包能否在这些显卡上运行。返回 null 表示“没有确凿的不兼容”（含未知）。
 *
 * 用户在设置里选了某块显卡时只看那一块（它会成为 CUDA 的 0 号设备）；
 * 否则看所有 NVIDIA 显卡——只要有一块达标，就不能断定会出问题。
 */
export function findCudaIncompatibility(
  variant: string | null,
  gpus: readonly GpuInfo[],
  selectedDevice?: unknown,
): CudaIncompatibility | null {
  if (!variant) return null;
  const min = CUDA_PACKAGE_MIN_COMPUTE_CAPABILITY[variant];
  if (min === undefined) return null;

  const nvidia = gpus.filter((gpu) => gpu.vendor === 'nvidia');
  const selected = sanitizeSelectedCudaDevice(selectedDevice).toLowerCase();
  const relevant = selected
    ? nvidia.filter((gpu) => gpu.uuid?.toLowerCase() === selected)
    : nvidia;
  if (relevant.length === 0) return null;
  if (relevant.some((gpu) => typeof gpu.computeCapability !== 'number')) {
    return null;
  }
  if (relevant.some((gpu) => (gpu.computeCapability as number) >= min)) {
    return null;
  }

  const cards = relevant
    .map((gpu) => `${gpu.name} (${gpu.computeCapability})`)
    .join(', ');
  return {
    minComputeCapability: min,
    reason: `CUDA ${variant} addon needs compute capability >= ${min}; GPU: ${cards}`,
  };
}

export interface CudaCandidateLike {
  backend: string;
  variant: string | null;
}

/** 从候选里剔除“显卡算力不够”的 CUDA 包；其余（Vulkan、CPU、自定义）原样保留。 */
export function partitionByCudaCompat<T extends CudaCandidateLike>(
  candidates: readonly T[],
  gpus: readonly GpuInfo[],
  selectedDevice?: unknown,
): {
  kept: T[];
  incompatible: Array<{ candidate: T; incompatibility: CudaIncompatibility }>;
} {
  const kept: T[] = [];
  const incompatible: Array<{
    candidate: T;
    incompatibility: CudaIncompatibility;
  }> = [];
  for (const candidate of candidates) {
    const incompatibility =
      candidate.backend === 'cuda'
        ? findCudaIncompatibility(candidate.variant, gpus, selectedDevice)
        : null;
    if (incompatibility) incompatible.push({ candidate, incompatibility });
    else kept.push(candidate);
  }
  return { kept, incompatible };
}
