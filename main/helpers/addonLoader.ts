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
import {
  buildAllSuppressedError,
  candidateKeyOf,
  describeSuppressed,
  gpuFingerprint,
  partitionCandidates,
} from './crash/addonSuppression';
import { usesGpu } from './crash/breaker';
import { partitionByCudaCompat } from './crash/cudaCompat';
import {
  beginNativeCall,
  isBreakerDisabledByEnv,
  lookupSuppression,
  recordNativeSuccess,
} from './crash/nativeGuard';
import type {
  AddonVariant,
  GpuEnvironment,
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
 * 按推荐矩阵生成加载候选列表
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

  // custom 无条件最高优先级（修复旧版非 NVIDIA 环境忽略自定义路径的问题）
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
 * 尝试加载单个候选（调用方负责 try/catch）
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

/**
 * 给每次原生转写登记在途标记：进程在调用期间崩溃的话，下次启动据此知道崩在哪个后端上。
 * 三个调用点（内置引擎、分片转写、参考音频转写）都经由这里，无需各自改动。
 */
function guardNativeCall(
  native: WhisperAsyncFn,
  candidate: AddonCandidate,
): WhisperAsyncFn {
  const key = candidateKeyOf(candidate);
  return async (params) => {
    const model =
      typeof params?.model === 'string' ? path.basename(params.model) : '';
    const end = beginNativeCall({
      engine: 'whisper',
      backend: candidate.backend,
      candidateKey: key,
      candidatePath: candidate.path,
      phase: 'transcribe',
      ...(model ? { model } : {}),
    });
    try {
      const result = await native(params);
      // 顺利跑完一次：这个后端之前累计的“异常退出”计数不再算数
      recordNativeSuccess(key);
      return result;
    } finally {
      end();
    }
  };
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

  let gpuEnv: GpuEnvironment | null = null;
  if (candidates.some((c) => usesGpu(candidateKeyOf(c)))) {
    try {
      gpuEnv = await getGpuEnvironment();
    } catch {
      // 拿不到显卡信息不影响其余判断
    }
  }
  const gpuFp = gpuEnv ? gpuFingerprint(gpuEnv) : undefined;

  // 显卡算力低于 CUDA 包的最低要求：加载也许成功，一跑核函数就会中止进程，
  // 所以在加载前剔除、交给降级链；算力未知时不剔。回退开关同时关闭这一步。
  const { kept, incompatible } = isBreakerDisabledByEnv()
    ? { kept: candidates, incompatible: [] }
    : partitionByCudaCompat(
        candidates,
        gpuEnv?.gpus ?? [],
        store.get('settings')?.selectedCudaDevice,
      );
  for (const { candidate, incompatibility } of incompatible) {
    logMessage(
      `Skipping addon candidate (${candidate.backend} @ ${candidate.path}): ${incompatibility.reason}`,
      'warning',
    );
    failedAttempts.push({
      backend: candidate.backend,
      path: candidate.path,
      error: incompatibility.reason,
      timestamp: new Date().toISOString(),
    });
  }

  // 崩溃熔断：上次因某个后端崩溃（或连续异常退出）的候选不再尝试，直接走降级链
  const { usable, skipped } = partitionCandidates(kept, (key) =>
    lookupSuppression(key, gpuFp),
  );
  for (const { candidate, suppression } of skipped) {
    const reason = describeSuppressed(suppression);
    logMessage(
      `Skipping addon candidate (${candidate.backend} @ ${candidate.path}): ${reason}`,
      'warning',
    );
    failedAttempts.push({
      backend: candidate.backend,
      path: candidate.path,
      error: reason,
      timestamp: new Date().toISOString(),
    });
  }
  if (usable.length === 0 && skipped.length > 0) {
    throw buildAllSuppressedError(skipped, {
      language: store.get('settings')?.language === 'zh' ? 'zh' : 'en',
      gpuOnly: ctx.gpuMode === 'gpu-only',
    });
  }

  for (const candidate of usable) {
    try {
      // dlopen 阶段也可能崩（静态初始化里就用到了不支持的指令）
      const endLoad = beginNativeCall({
        engine: 'whisper-load',
        backend: candidate.backend,
        candidateKey: candidateKeyOf(candidate),
        candidatePath: candidate.path,
        phase: 'dlopen',
      });
      let whisper: WhisperFn;
      try {
        whisper = tryLoadCandidate(candidate);
      } finally {
        endLoad();
      }
      const loadedAt = new Date().toISOString();
      const result: AddonLoadResult = {
        whisperAsync: guardNativeCall(
          promisify(whisper) as WhisperAsyncFn,
          candidate,
        ),
        backend: candidate.backend,
        variant: candidate.variant,
        source: candidate.source,
        path: candidate.path,
        // 首选被抑制而落到后面的候选，同样算降级
        fallback: candidate !== candidates[0],
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
