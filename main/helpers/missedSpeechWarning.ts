import {
  associateMissedSpeechWarnings,
  type MissedSpeechSignal,
  type MissedSpeechWarning,
  type SpeechInterval,
} from '../../types/missedSpeech';

export interface TranscriptionDiagnostics {
  /** Actual VAD output only. Recognition segments are not independent speech evidence. */
  vadSegments?: SpeechInterval[];
  /** Whether the selected engine actually ran a VAD pass for this transcription. */
  vadAvailable?: boolean;
  /** Only reliable word timestamps; absent for coarse/interpolated segment timing. */
  wordSegments?: SpeechInterval[];
}

/** Convert engine-provided intervals to finite, non-negative millisecond ranges. */
export function normalizeSpeechIntervals(input: unknown): SpeechInterval[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const startMs = Number((value as { startMs?: unknown }).startMs);
    const endMs = Number((value as { endMs?: unknown }).endMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    )
      return [];
    return [{ startMs: Math.max(0, startMs), endMs }];
  });
}

export const MISSED_SPEECH_MIN_MS = 800;
const EDGE_PADDING_MS = 150;

export function mergeSpeechIntervals(
  intervals: readonly SpeechInterval[],
  durationMs: number,
  bridgeMs = 0,
): SpeechInterval[] {
  const sorted = intervals
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
    .map((s) => ({
      startMs: Math.max(0, s.startMs),
      endMs: Math.min(durationMs, s.endMs),
    }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: SpeechInterval[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.startMs <= last.endMs + bridgeMs) {
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else merged.push({ ...segment });
  }
  return merged;
}

function gaps(
  intervals: SpeechInterval[],
  durationMs: number,
): SpeechInterval[] {
  let cursor = 0;
  const result: SpeechInterval[] = [];
  for (const interval of intervals) {
    if (interval.startMs > cursor)
      result.push({ startMs: cursor, endMs: interval.startMs });
    cursor = interval.endMs;
  }
  if (cursor < durationMs) result.push({ startMs: cursor, endMs: durationMs });
  return result;
}

function intersection(
  a: SpeechInterval[],
  b: SpeechInterval[],
): SpeechInterval[] {
  const result: SpeechInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i].startMs, b[j].startMs);
    const endMs = Math.min(a[i].endMs, b[j].endMs);
    if (endMs > startMs) result.push({ startMs, endMs });
    if (a[i].endMs < b[j].endMs) i++;
    else j++;
  }
  return result;
}

export function detectMissedSpeech(
  input: TranscriptionDiagnostics & {
    durationMs: number;
    energySegments: SpeechInterval[];
    cues: Array<SpeechInterval & { id: string; text: string }>;
  },
): MissedSpeechWarning[] {
  const { durationMs } = input;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const cues = input.cues.filter(
    (cue) => cue.text.trim() && cue.endMs > cue.startMs,
  );
  const padded = (items: SpeechInterval[]) =>
    mergeSpeechIntervals(
      items.map((s) => ({
        startMs: s.startMs - EDGE_PADDING_MS,
        endMs: s.endMs + EDGE_PADDING_MS,
      })),
      durationMs,
    );
  const cueCoverage = padded(cues);
  const cueGaps = gaps(cueCoverage, durationMs);
  const words = input.wordSegments?.length ? padded(input.wordSegments) : [];
  // Interior word gaps can reveal an omission hidden by a long subtitle cue.
  // Clip to the word timeline extent; missing word metadata at either end is not a gap.
  const wordGaps =
    words.length > 1
      ? gaps(words, durationMs).filter(
          (g) => g.startMs > 0 && g.endMs < durationMs,
        )
      : [];
  const uncovered = mergeSpeechIntervals([...cueGaps, ...wordGaps], durationMs);
  const energy = mergeSpeechIntervals(
    normalizeSpeechIntervals(input.energySegments),
    durationMs,
  );
  const vad = mergeSpeechIntervals(
    normalizeSpeechIntervals(input.vadSegments),
    durationMs,
  );
  const candidates = intersection(energy, uncovered).filter(
    (s) => s.endMs - s.startMs >= MISSED_SPEECH_MIN_MS,
  );
  const warnings: MissedSpeechWarning[] = [];
  for (const range of candidates) {
    const length = range.endMs - range.startMs;
    const coverage = (segments: SpeechInterval[]) =>
      intersection([range], segments).reduce(
        (sum, s) => sum + s.endMs - s.startMs,
        0,
      );
    const vadSupport =
      input.vadAvailable === true &&
      coverage(vad) >= Math.max(MISSED_SPEECH_MIN_MS, length * 0.6);
    const internalGap =
      cueCoverage.length > 1 &&
      range.startMs >= cueCoverage[0].endMs &&
      range.endMs <= cueCoverage[cueCoverage.length - 1].startMs &&
      coverage(cueGaps) >= length * 0.8;
    const wordGap = coverage(wordGaps) >= length * 0.8;
    if (!vadSupport && !internalGap && !wordGap) continue;
    const signals: MissedSpeechSignal[] = ['energySpeech'];
    if (vadSupport) signals.push('engineVad');
    if (internalGap) signals.push('subtitleGap');
    if (wordGap) signals.push('wordGap');
    warnings.push({
      id: `missed-speech:${Math.round(range.startMs)}:${Math.round(range.endMs)}`,
      startMs: Math.round(range.startMs),
      endMs: Math.round(range.endMs),
      // Keep the most meaningful independent signal as the severity. A word
      // gap can coexist with a subtitle coverage gap; the latter is stronger
      // evidence and must not be downgraded to low.
      level: vadSupport ? 'high' : internalGap ? 'medium' : 'low',
      signals,
      cueIds: [],
    });
  }
  return associateMissedSpeechWarnings(warnings, cues);
}
