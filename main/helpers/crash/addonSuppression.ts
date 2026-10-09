/**
 * 把熔断结果用到 whisper addon 的候选列表上：筛掉被抑制的、说明为什么、全被抑制时给出可操作的错误。
 * 纯逻辑、不依赖 electron 与 store，addonLoader 只负责把候选和语言传进来。
 */
import { candidateKey, type Suppression } from './breaker';

export interface LoaderCandidateLike {
  backend: string;
  variant: string | null;
  source: string;
  path: string;
}

export const candidateKeyOf = (c: LoaderCandidateLike): string =>
  candidateKey(c.source, c.backend, c.variant);

export interface SkippedCandidate<C> {
  candidate: C;
  suppression: Suppression;
}

/** 按熔断结果分成能用的和被抑制的，保持原有优先级顺序。 */
export function partitionCandidates<C extends LoaderCandidateLike>(
  candidates: C[],
  lookup: (key: string) => Suppression | null,
): { usable: C[]; skipped: Array<SkippedCandidate<C>> } {
  const usable: C[] = [];
  const skipped: Array<SkippedCandidate<C>> = [];
  for (const candidate of candidates) {
    const suppression = lookup(candidateKeyOf(candidate));
    if (suppression) skipped.push({ candidate, suppression });
    else usable.push(candidate);
  }
  return { usable, skipped };
}

/** 写进日志与“加载失败详情”里的一句话（英文，与其他加载错误一致）。 */
export function describeSuppressed(s: Suppression): string {
  const why =
    s.reason === 'isa'
      ? 'the CPU does not support an instruction set the addon needs'
      : s.evidence === 'weak'
        ? 'the app ended abnormally twice in a row while it was running'
        : 'it crashed the app';
  return `Suppressed after a previous run (${why})${s.detail ? `: ${s.detail}` : ''}`;
}

/** 显卡指纹：显卡名 + NVIDIA 驱动版本。显卡或驱动一换，之前因它崩溃的记录就该重新验证。 */
export function gpuFingerprint(env: {
  gpus?: Array<{ name: string }>;
  nvidia?: { gpuSupport?: { driverVersion?: string | null } } | null;
}): string {
  const names = (env.gpus ?? [])
    .map((g) => g.name)
    .filter(Boolean)
    .sort()
    .join(' / ');
  const driver = env.nvidia?.gpuSupport?.driverVersion ?? '';
  return `${names}@${driver}`;
}

export class WhisperUnavailableError extends Error {
  readonly code = 'WHISPER_SUPPRESSED';
  constructor(
    message: string,
    /** isa：CPU 指令集不满足；crash：其他崩溃 */
    readonly reason: 'isa' | 'crash',
  ) {
    super(message);
    this.name = 'WhisperUnavailableError';
  }
}

export type MessageLanguage = 'zh' | 'en';

function backendNames(skipped: Array<SkippedCandidate<LoaderCandidateLike>>) {
  const names = skipped.map(({ candidate: c }) =>
    c.variant && c.variant !== c.backend
      ? `${c.backend} ${c.variant}`
      : c.backend,
  );
  return [...new Set(names)].join(', ');
}

/**
 * 所有候选都被抑制时抛出的错误。
 * GPU-only 模式保持“不静默落到 CPU”的语义：照样报错，只是说明原因；其余情况引导用云端听写。
 */
export function buildAllSuppressedError(
  skipped: Array<SkippedCandidate<LoaderCandidateLike>>,
  options: { language: MessageLanguage; gpuOnly: boolean },
): WhisperUnavailableError {
  const isa = skipped.some(
    ({ suppression: s }) => s.scope === 'family' && s.reason === 'isa',
  );
  const names = backendNames(skipped);
  const detail = skipped.find(({ suppression }) => suppression.detail)
    ?.suppression.detail;
  const zh = options.language === 'zh';

  let message: string;
  if (isa) {
    message = zh
      ? `内置语音识别加速包在这台电脑上崩溃过${detail ? `（${detail}）` : ''}，通常是 CPU 不支持它需要的指令集。为避免应用反复闪退，已自动停用。请改用云端听写或其他语音识别引擎；更换硬件或升级应用后，可在 GPU 加速设置里点「重新尝试被停用的后端」。`
      : `The built-in speech recognition addon crashed on this computer${detail ? ` (${detail})` : ''}, usually because the CPU lacks an instruction set it needs. It was disabled so the app does not keep crashing. Use cloud transcription or another engine; after changing hardware or upgrading, use "Retry disabled backends" in the GPU acceleration settings.`;
  } else if (options.gpuOnly) {
    message = zh
      ? `仅 GPU 模式下没有可用的加速后端：${names} 上次运行时导致应用崩溃，已被自动停用。请切换到「自动」模式使用 CPU，或在 GPU 加速设置里点「重新尝试被停用的后端」。`
      : `GPU acceleration unavailable in GPU-only mode: ${names} crashed the app during a previous run and was disabled. Switch to Auto mode to use the CPU, or use "Retry disabled backends" in the GPU acceleration settings.`;
  } else {
    message = zh
      ? `语音识别加速包（${names}）上次运行时导致应用崩溃，已被自动停用，当前没有可用的后端。请改用云端听写，或在 GPU 加速设置里点「重新尝试被停用的后端」。`
      : `The speech recognition addon (${names}) crashed the app during a previous run and was disabled, so no backend is available. Use cloud transcription, or use "Retry disabled backends" in the GPU acceleration settings.`;
  }
  return new WhisperUnavailableError(message, isa ? 'isa' : 'crash');
}
