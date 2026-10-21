import { getNumericSetting } from './transcribeShared';

/**
 * Qwen3-ASR 专属参数映射：SmartSub 统一 settings → sherpa-onnx addon 参数。
 *
 * 解码参数默认值对齐 sherpa-onnx 上游 `OfflineQwen3ASRModelConfig`：
 *   max_total_len=512, max_new_tokens=128, temperature=1e-6, top_p=0.8, seed=42。
 * 注意：Node 绑定对该 config 先 memset(0) 再覆盖存在的键，故每个字段都必须显式给值。
 *
 * 当前范围：0.6B / 1.7B、CPU、段级时间戳。语言由 Qwen 内部 prompt 处理，
 * sherpa 的 qwen3Asr 配置不暴露 language 字段，故此处不接收/不映射 sourceLanguage。
 *
 * 段长安全闸（openspec fix-qwen-asr-long-segments，design D2/D3）：音频、提示词与生成文本
 * 共用同一个 max_total_len，单个 VAD 段太长时文本会被静默截断，再长则音频被截断、只剩首个
 * token（常见是 `language`）。故 qwen **不沿用 SmartSub「0=不限制」约定**：0/未设/非法 →
 * 默认 15s，显式值硬钳到 ≤20s。VAD 的最长语音只是软限制，这只能降低超预算的概率，不能消除。
 * 因此另给 worker 一个硬切分上限 segment_hard_max_s（openspec split-qwen-asr-long-segments）：
 * 超过它的 VAD 段在最安静处切开、逐片解码，才能保证解码单元放得进预算。
 * 数值取自 sherpa-onnx v1.13.2 的默认预算（512/128）与本机探针，升级 sherpa 时需复核。
 */

/** 默认最长语音段长（秒）：用于未设置 / 0（SmartSub「不限制」）/ 非法值。 */
export const QWEN_DEFAULT_MAX_SPEECH_S = 15;
/** 最长语音段长硬上限（秒）：显式设置超过此值时收敛到它。 */
export const QWEN_HARD_MAX_SPEECH_S = 20;
/** 音频每秒占用的 token 数（约 13）。取自 sherpa-onnx v1.13.2，升级时需复核。 */
export const QWEN_AUDIO_TOKENS_PER_SECOND = 13;
/** 提示词脚手架占用的 token 数（约 15）。取自 sherpa-onnx v1.13.2，升级时需复核。 */
export const QWEN_PROMPT_TOKENS = 15;
/** 硬切分上限的下限（秒）：预算放不下 1 秒音频的离谱配置也取它，由超预算告警兜底。 */
export const QWEN_MIN_SEGMENT_HARD_MAX_S = 1;

export interface QwenEngineSettings {
  /** sherpa-onnx provider；P2 仅 cpu 落地，cuda 预留未来阶段。 */
  qwenProvider?: 'cpu' | 'cuda';
  qwenNumThreads?: number;
  qwenMaxTotalLen?: number;
  qwenMaxNewTokens?: number;
  qwenTemperature?: number;
  qwenTopP?: number;
  qwenSeed?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  vadMinSilenceDuration?: number;
  vadMinSpeechDuration?: number;
  vadMaxSpeechDuration?: number;
}

export interface QwenAddonParams {
  provider: string;
  num_threads: number;
  max_total_len: number;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  seed: number;
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
  /** worker 硬切分上限（秒）：超过它的 VAD 段在最安静处被切成多片再解码（design D3）。 */
  segment_hard_max_s: number;
}

/**
 * 段长安全闸：把任意输入收敛到 Qwen3-ASR 可承受的范围。
 * - 未设/非数值/非有限/0（SmartSub「不限制」语义）/负数 → 默认 15s；
 * - > 20 → 硬上限 20s；
 * - (0, 20] → 原样采用。
 * 与 FireRed 不同：0 取默认值而不是钳到上限，因为「自动」应取更保守的那个。
 */
export function clampQwenMaxSpeech(raw: unknown): number {
  const v = getNumericSetting(raw, 0);
  if (v <= 0) return QWEN_DEFAULT_MAX_SPEECH_S;
  return Math.min(v, QWEN_HARD_MAX_SPEECH_S);
}

type QwenBudget = Pick<QwenAddonParams, 'max_total_len' | 'max_new_tokens'>;

/** 当前解码预算放得下的最长音频（秒，向下取一位小数，不为负）。超预算告警与硬切分共用同一口径。 */
export function qwenFitSeconds(budget: QwenBudget): number {
  return (
    Math.floor(
      Math.max(
        0,
        (budget.max_total_len - QWEN_PROMPT_TOKENS - budget.max_new_tokens) /
          QWEN_AUDIO_TOKENS_PER_SECOND,
      ) * 10,
    ) / 10
  );
}

/**
 * worker 硬切分上限：不超过 20 秒（与 VAD 硬上限一致，也是 sherpa-onnx 维护者的建议）与
 * 当前预算放得下的秒数中的较小者，且不小于 1 秒。
 */
export function qwenSegmentHardMaxSeconds(budget: QwenBudget): number {
  return Math.max(
    QWEN_MIN_SEGMENT_HARD_MAX_S,
    Math.min(QWEN_HARD_MAX_SPEECH_S, qwenFitSeconds(budget)),
  );
}

/** 组装 qwen 的可选参数（不含 audio_file / 模型文件，由 adapter 注入）。 */
export function buildQwenParams(
  settings: Record<string, unknown>,
): QwenAddonParams {
  const s = settings as QwenEngineSettings;
  const maxTotalLen = getNumericSetting(s.qwenMaxTotalLen, 512);
  const maxNewTokens = getNumericSetting(s.qwenMaxNewTokens, 128);
  return {
    // P2 仅 cpu 落地（design D7）；非法/未设回退 cpu。
    provider: s.qwenProvider === 'cuda' ? 'cuda' : 'cpu',
    num_threads: Number(s.qwenNumThreads) > 0 ? Number(s.qwenNumThreads) : 2,
    max_total_len: maxTotalLen,
    max_new_tokens: maxNewTokens,
    temperature: getNumericSetting(s.qwenTemperature, 1e-6),
    top_p: getNumericSetting(s.qwenTopP, 0.8),
    seed: getNumericSetting(s.qwenSeed, 42),
    // VAD 调参复用 SmartSub 统一开关（与 funasr / faster-whisper 一致）。
    vad_threshold: getNumericSetting(s.vadThreshold, 0.5),
    vad_min_silence_duration_ms: getNumericSetting(
      s.vadMinSilenceDuration,
      100,
    ),
    vad_min_speech_duration_ms: getNumericSetting(s.vadMinSpeechDuration, 250),
    // 段长安全闸：Qwen 的 token 预算装不下长段，不允许「不限制」；默认 15s、硬钳 ≤20s。
    vad_max_speech_duration_s: clampQwenMaxSpeech(s.vadMaxSpeechDuration),
    // 硬切分兜底：VAD 的最长语音只是软限制，仍切不开的段由 worker 在最安静处切开。
    segment_hard_max_s: qwenSegmentHardMaxSeconds({
      max_total_len: maxTotalLen,
      max_new_tokens: maxNewTokens,
    }),
  };
}

/**
 * 估算解码一个 VAD 段所需的 token 数：提示词 + 音频 + 满额生成预留。
 * 超过 max_total_len 时，文本会在生成循环触顶处被静默截断；更长时音频本身也被截断，
 * 生成循环首步即退出，只剩首个 token（见 openspec fix-qwen-asr-long-segments design Context）。
 */
export function estimateQwenTokens(
  durationS: number,
  maxNewTokens: number,
): number {
  return (
    QWEN_PROMPT_TOKENS +
    Math.ceil(durationS * QWEN_AUDIO_TOKENS_PER_SECOND) +
    maxNewTokens
  );
}

export interface QwenOverBudget {
  /** 超出解码预算的段数。 */
  count: number;
  /** 参与判断的有效 VAD 段总数（时长非正或非有限的段不计）。 */
  total: number;
  /** 估算 token 最多的那一段（秒）。 */
  longest: { start: number; end: number; tokens: number };
  /** 当前预算下能放下的最长段长（秒，向下取一位小数）。 */
  fitSeconds: number;
}

/**
 * 在转写结果的 VAD 段里找出超出解码预算的段。没有 VAD 信息或没有超限段时返回 null。
 * 只用于日志告警，不改变转写结果。
 */
export function findQwenOverBudgetSegments(
  params: Pick<QwenAddonParams, 'max_total_len' | 'max_new_tokens'>,
  vadSegments: ReadonlyArray<{ start: number; end: number }> | undefined,
): QwenOverBudget | null {
  if (!vadSegments?.length) return null;
  let count = 0;
  let total = 0;
  let longest: QwenOverBudget['longest'] | null = null;
  for (const segment of vadSegments) {
    const start = Number(segment.start);
    const end = Number(segment.end);
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    total += 1;
    const tokens = estimateQwenTokens(duration, params.max_new_tokens);
    if (tokens <= params.max_total_len) continue;
    count += 1;
    if (!longest || tokens > longest.tokens) longest = { start, end, tokens };
  }
  if (!longest) return null;
  return { count, total, longest, fitSeconds: qwenFitSeconds(params) };
}
