/**
 * 模型无关的 ASR 重复护栏。
 *
 * 解码器偶尔会在长音频后段进入「滑动窗口循环」：相邻字幕反复复用同一组词，
 * 只改变起点或把开头挪到结尾。这里不匹配任何特定文案，只依据字幕文本、顺序和
 * 时间邻近性识别高置信度循环，并至少保留前两次出现，避免把正常强调、歌词副歌或
 * 很短的口头重复直接抹掉。
 *
 * 本模块保持纯函数，所有引擎可在写字幕前共用，也便于无模型单测。
 */

export type AsrSubtitleCue = [string, string, string];

export type RepetitionGuardReason = 'sliding' | 'exact' | 'cycle';

export interface RepetitionGuardStats {
  inputCues: number;
  outputCues: number;
  removedCues: number;
  detectedRuns: number;
  removedDurationSeconds: number;
  removedByReason: Record<RepetitionGuardReason, number>;
}

export interface RepetitionGuardResult {
  cues: AsrSubtitleCue[];
  stats: RepetitionGuardStats;
}

export interface RepetitionGuardOptions {
  enabled?: boolean;
  /**
   * standard：只压制四连以上、词序呈滑动/轮转的循环。
   * aggressive：另压制五连完全重复与三轮窗口周期（clean/reduceRepetition 意图）。
   */
  mode?: RepetitionGuardMode;
  /** 两条字幕之间允许的最大静音间隔；超过后不再视为同一循环。 */
  maxGapSeconds?: number;
  /** 三轮窗口循环允许的最大总跨度。 */
  maxCycleSpanSeconds?: number;
}

export type RepetitionGuardMode = 'standard' | 'aggressive';
export type TaskRepetitionGuardMode = RepetitionGuardMode | 'off';

type TextSignature = {
  key: string;
  compact: string;
  units: string[];
  contentChars: number;
  cjkUnits: number;
  wordUnits: number;
};

type SimilarityProfile = {
  similar: boolean;
  exact: boolean;
  cyclic: boolean;
  unigramDice: number;
  shingleDice: number;
};

const DEFAULT_MAX_GAP_SECONDS = 20;
const DEFAULT_MAX_CYCLE_SPAN_SECONDS = 90;
const MIN_CONTENT_CHARS = 12;
const MIN_CJK_UNITS = 8;
const MIN_WORD_UNITS = 4;
const MIN_GENERAL_UNITS = 8;
const MIN_EXACT_RUN = 5;
const MIN_SLIDING_RUN = 4;
const CYCLE_REPETITIONS = 3;
const MAX_CYCLE_PERIOD = 3;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function emptyReasonCounts(): Record<RepetitionGuardReason, number> {
  return { sliding: 0, exact: 0, cycle: 0 };
}

function emptyStats(inputCues: number): RepetitionGuardStats {
  return {
    inputCues,
    outputCues: inputCues,
    removedCues: 0,
    detectedRuns: 0,
    removedDurationSeconds: 0,
    removedByReason: emptyReasonCounts(),
  };
}

function isCjkLike(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7a3)
  );
}

function isLetterOrNumber(ch: string): boolean {
  return LETTER_OR_NUMBER.test(ch);
}

/**
 * 拉丁文字按词、CJK/假名/谚文按字形成单元；标点和空白不参与比较。
 * NFKC 会把全角字母数字等价到半角，但不会改变原字幕。
 */
export function normalizeAsrText(text: string): TextSignature {
  let normalized = String(text ?? '');
  try {
    normalized = normalized.normalize('NFKC');
  } catch {
    // 极旧 JS 运行时没有 normalize 时仍可按原文工作。
  }
  normalized = normalized.toLowerCase();

  const units: string[] = [];
  let pendingWord = '';
  let compact = '';
  let cjkUnits = 0;
  let wordUnits = 0;

  const flushWord = () => {
    if (!pendingWord) return;
    units.push(pendingWord);
    wordUnits += 1;
    pendingWord = '';
  };

  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjkLike(code)) {
      flushWord();
      units.push(ch);
      compact += ch;
      cjkUnits += 1;
      continue;
    }
    if (isLetterOrNumber(ch)) {
      pendingWord += ch;
      compact += ch;
      continue;
    }
    flushWord();
  }
  flushWord();

  return {
    key: units.join('\u0001'),
    compact,
    units,
    contentChars: Array.from(compact).length,
    cjkUnits,
    wordUnits,
  };
}

function isGuardable(signature: TextSignature): boolean {
  return (
    signature.contentChars >= MIN_CONTENT_CHARS &&
    (signature.cjkUnits >= MIN_CJK_UNITS ||
      signature.wordUnits >= MIN_WORD_UNITS ||
      signature.units.length >= MIN_GENERAL_UNITS)
  );
}

function multisetDice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const item of b) {
    const remaining = counts.get(item) ?? 0;
    if (remaining <= 0) continue;
    overlap += 1;
    counts.set(item, remaining - 1);
  }
  return (2 * overlap) / (a.length + b.length);
}

function shingles(units: string[]): string[] {
  if (units.length < 2) return units;
  const width = units.length >= 6 ? 3 : 2;
  if (units.length < width) return units;
  const result: string[] = [];
  for (let i = 0; i <= units.length - width; i += 1) {
    result.push(units.slice(i, i + width).join('\u0002'));
  }
  return result;
}

function isCyclicContainment(a: string, b: string): boolean {
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length / longer.length < 0.75) return false;
  return (longer + longer).includes(shorter);
}

function similarity(a: TextSignature, b: TextSignature): SimilarityProfile {
  const exact = a.key.length > 0 && a.key === b.key;
  const unigramDice = multisetDice(a.units, b.units);
  const shingleDice = multisetDice(shingles(a.units), shingles(b.units));
  const cyclic = !exact && isCyclicContainment(a.compact, b.compact);
  const similar =
    exact || (unigramDice >= 0.84 && (shingleDice >= 0.55 || cyclic));
  return { similar, exact, cyclic, unigramDice, shingleDice };
}

function parseTimeSeconds(value: string): number | null {
  const parts = String(value ?? '')
    .trim()
    .replace(',', '.')
    .split(':')
    .map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function cueStart(cue: AsrSubtitleCue): number | null {
  return parseTimeSeconds(cue[0]);
}

function cueEnd(cue: AsrSubtitleCue): number | null {
  return parseTimeSeconds(cue[1]);
}

function areAdjacent(
  previous: AsrSubtitleCue,
  current: AsrSubtitleCue,
  maxGapSeconds: number,
): boolean {
  const previousEnd = cueEnd(previous);
  const currentStart = cueStart(current);
  if (previousEnd === null || currentStart === null) return true;
  return currentStart - previousEnd <= maxGapSeconds;
}

function rangeSpanSeconds(
  cues: AsrSubtitleCue[],
  start: number,
  end: number,
): number | null {
  const first = cueStart(cues[start]);
  const last = cueEnd(cues[end]);
  if (first === null || last === null) return null;
  return Math.max(0, last - first);
}

function markRange(
  removed: Map<number, RepetitionGuardReason>,
  start: number,
  end: number,
  reason: RepetitionGuardReason,
): void {
  for (let i = start; i <= end; i += 1) {
    if (!removed.has(i)) removed.set(i, reason);
  }
}

function detectAdjacentRuns(
  cues: AsrSubtitleCue[],
  signatures: TextSignature[],
  removed: Map<number, RepetitionGuardReason>,
  maxGapSeconds: number,
  mode: RepetitionGuardMode,
): void {
  let runStart = 0;

  const inspectRun = (start: number, end: number) => {
    const length = end - start + 1;
    if (length < MIN_SLIDING_RUN) return;
    const unique = new Set(
      signatures.slice(start, end + 1).map((signature) => signature.key),
    );

    if (unique.size === 1) {
      if (mode === 'aggressive' && length >= MIN_EXACT_RUN) {
        // 即便是病态循环也保留前两条；短强调/歌词重复在达到五连前完全不动。
        markRange(removed, start + 2, end, 'exact');
      }
      return;
    }

    let strongSlidingEdges = 0;
    for (let i = start + 1; i <= end; i += 1) {
      const profile = similarity(signatures[i - 1], signatures[i]);
      if (
        profile.cyclic ||
        (profile.unigramDice >= 0.82 && profile.shingleDice >= 0.8)
      ) {
        strongSlidingEdges += 1;
      }
    }
    // 不因四句普通近义改写触发；要求大部分边都呈现词袋近乎不变且顺序滑动。
    if (strongSlidingEdges >= length - 2) {
      markRange(removed, start + 2, end, 'sliding');
    }
  };

  for (let i = 1; i < cues.length; i += 1) {
    const profile = similarity(signatures[i - 1], signatures[i]);
    const continues =
      isGuardable(signatures[i - 1]) &&
      isGuardable(signatures[i]) &&
      profile.similar &&
      areAdjacent(cues[i - 1], cues[i], maxGapSeconds);
    if (continues) continue;
    inspectRun(runStart, i - 1);
    runStart = i;
  }
  inspectRun(runStart, cues.length - 1);
}

function cycleBlockIsLongEnough(
  signatures: TextSignature[],
  start: number,
  period: number,
): boolean {
  const block = signatures.slice(start, start + period);
  const contentChars = block.reduce(
    (sum, signature) => sum + signature.contentChars,
    0,
  );
  const units = block.reduce(
    (sum, signature) => sum + signature.units.length,
    0,
  );
  return contentChars >= 18 || units >= 8;
}

function correspondingCycleCuesMatch(
  signatures: TextSignature[],
  first: number,
  second: number,
  period: number,
): boolean {
  for (let offset = 0; offset < period; offset += 1) {
    const a = signatures[first + offset];
    const b = signatures[second + offset];
    const profile = similarity(a, b);
    // 短句允许精确匹配，但模糊匹配仍需达到单条长文本门槛。
    if (
      !profile.exact &&
      !(isGuardable(a) && isGuardable(b) && profile.similar)
    ) {
      return false;
    }
  }
  return true;
}

function detectWindowCycles(
  cues: AsrSubtitleCue[],
  signatures: TextSignature[],
  removed: Map<number, RepetitionGuardReason>,
  maxGapSeconds: number,
  maxCycleSpanSeconds: number,
): void {
  for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
    const windowSize = period * CYCLE_REPETITIONS;
    for (let start = 0; start + windowSize <= cues.length; start += 1) {
      const end = start + windowSize - 1;
      let adjacent = true;
      for (let i = start + 1; i <= end; i += 1) {
        if (!areAdjacent(cues[i - 1], cues[i], maxGapSeconds)) {
          adjacent = false;
          break;
        }
      }
      if (!adjacent || !cycleBlockIsLongEnough(signatures, start, period)) {
        continue;
      }
      const span = rangeSpanSeconds(cues, start, end);
      if (span !== null && span > maxCycleSpanSeconds) continue;

      const second = start + period;
      const third = second + period;
      if (
        correspondingCycleCuesMatch(signatures, start, second, period) &&
        correspondingCycleCuesMatch(signatures, second, third, period)
      ) {
        // 两个完整周期保留，仅从第三个周期开始压制。
        markRange(removed, third, end, 'cycle');
      }
    }
  }
}

function countRemovedRuns(indices: number[]): number {
  let runs = 0;
  let previous = -2;
  for (const index of indices) {
    if (index !== previous + 1) runs += 1;
    previous = index;
  }
  return runs;
}

/**
 * 对字幕 cue 应用高置信度重复护栏。禁用或未命中时文本和数组元素均原样返回。
 */
export function applyAsrRepetitionGuard(
  cues: AsrSubtitleCue[],
  options: RepetitionGuardOptions = {},
): RepetitionGuardResult {
  const input = Array.isArray(cues) ? cues : [];
  if (options.enabled === false || input.length === 0) {
    return { cues: input, stats: emptyStats(input.length) };
  }

  const maxGapSeconds =
    typeof options.maxGapSeconds === 'number' &&
    Number.isFinite(options.maxGapSeconds)
      ? Math.max(0, options.maxGapSeconds)
      : DEFAULT_MAX_GAP_SECONDS;
  const maxCycleSpanSeconds =
    typeof options.maxCycleSpanSeconds === 'number' &&
    Number.isFinite(options.maxCycleSpanSeconds)
      ? Math.max(0, options.maxCycleSpanSeconds)
      : DEFAULT_MAX_CYCLE_SPAN_SECONDS;
  const mode = options.mode ?? 'standard';
  const signatures = input.map((cue) => normalizeAsrText(cue[2]));
  const removed = new Map<number, RepetitionGuardReason>();

  detectAdjacentRuns(input, signatures, removed, maxGapSeconds, mode);
  if (mode === 'aggressive') {
    detectWindowCycles(
      input,
      signatures,
      removed,
      maxGapSeconds,
      maxCycleSpanSeconds,
    );
  }

  const removedIndices = Array.from(removed.keys()).sort((a, b) => a - b);
  if (!removedIndices.length) {
    return { cues: input, stats: emptyStats(input.length) };
  }

  const removedByReason = emptyReasonCounts();
  let removedDurationSeconds = 0;
  for (const index of removedIndices) {
    removedByReason[removed.get(index)!] += 1;
    const start = cueStart(input[index]);
    const end = cueEnd(input[index]);
    if (start !== null && end !== null && end > start) {
      removedDurationSeconds += end - start;
    }
  }
  const output = input.filter((_, index) => !removed.has(index));
  return {
    cues: output,
    stats: {
      inputCues: input.length,
      outputCues: output.length,
      removedCues: removedIndices.length,
      detectedRuns: countRemovedRuns(removedIndices),
      removedDurationSeconds: Math.round(removedDurationSeconds * 1000) / 1000,
      removedByReason,
    },
  };
}

/**
 * 默认 balanced / accurate 严格关闭，避免滚动歌词、提词器等合法轮转文本被误删。
 * 仅 clean 或显式 reduceRepetition=true 才启用 aggressive；clean 对 sherpa 系虽无
 * 解码层抗重复参数，仍能表达共享后处理意图。
 */
export function getAsrRepetitionGuardMode(
  formData: Record<string, unknown> | undefined,
  effectiveSettings: Record<string, unknown> | undefined,
): TaskRepetitionGuardMode {
  const outcome =
    formData?.subtitleOutcome ?? effectiveSettings?.subtitleOutcome;
  if (outcome === 'clean') return 'aggressive';
  if (outcome === 'accurate' || outcome === 'balanced') return 'off';
  if (typeof formData?.reduceRepetition === 'boolean') {
    return formData.reduceRepetition ? 'aggressive' : 'off';
  }
  return effectiveSettings?.reduceRepetition === true ? 'aggressive' : 'off';
}

/** 不记录用户文本的结构化诊断，便于日志确认护栏是否命中及误杀排查。 */
export function formatRepetitionGuardDiagnostic(
  engine: string,
  stats: RepetitionGuardStats,
): string | null {
  if (stats.removedCues === 0) return null;
  const reasons = (
    Object.keys(stats.removedByReason) as RepetitionGuardReason[]
  )
    .filter((reason) => stats.removedByReason[reason] > 0)
    .map((reason) => `${reason}=${stats.removedByReason[reason]}`)
    .join(',');
  return (
    `ASR repetition guard (${engine}): removed ${stats.removedCues}/` +
    `${stats.inputCues} cues in ${stats.detectedRuns} run(s), ` +
    `removedDuration=${stats.removedDurationSeconds.toFixed(3)}s, ${reasons}`
  );
}
