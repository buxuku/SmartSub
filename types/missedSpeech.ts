export interface SpeechInterval {
  startMs: number;
  endMs: number;
}

export type MissedSpeechWarningLevel = 'low' | 'medium' | 'high';
export type MissedSpeechSignal =
  | 'energySpeech'
  | 'engineVad'
  | 'subtitleGap'
  | 'wordGap'
  | 'timingMismatch'
  | 'textMismatch'
  | 'speechReview';

export interface MissedSpeechWarning extends SpeechInterval {
  id: string;
  level: MissedSpeechWarningLevel;
  signals: MissedSpeechSignal[];
  cueIds: string[];
  suggestedText?: string;
  originalText?: string;
}

export interface MissedSpeechSummary {
  count: number;
  highestLevel?: MissedSpeechWarningLevel;
  startMs?: number;
  endMs?: number;
  engineVadAvailable: boolean;
}

export function overlapsSpeechInterval(a: SpeechInterval, b: SpeechInterval) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** Persist time ranges as the authority; cue IDs may change during proofreading. */
export function associateMissedSpeechWarnings(
  warnings: readonly MissedSpeechWarning[],
  cues: readonly (SpeechInterval & { id: string })[],
): MissedSpeechWarning[] {
  return warnings.map((warning) => ({
    ...warning,
    cueIds: cues
      .filter((cue) => overlapsSpeechInterval(cue, warning))
      .map((cue) => cue.id),
  }));
}

export function summarizeMissedSpeech(
  warnings: readonly MissedSpeechWarning[],
  engineVadAvailable: boolean,
): MissedSpeechSummary {
  const rank = { low: 1, medium: 2, high: 3 };
  if (!warnings.length) return { count: 0, engineVadAvailable };
  return {
    count: warnings.length,
    highestLevel: warnings.reduce(
      (level, warning) =>
        rank[warning.level] > rank[level] ? warning.level : level,
      'low' as MissedSpeechWarningLevel,
    ),
    startMs: Math.min(...warnings.map((warning) => warning.startMs)),
    endMs: Math.max(...warnings.map((warning) => warning.endMs)),
    engineVadAvailable,
  };
}

export function normalizeMissedSpeechWarnings(
  input: unknown,
): MissedSpeechWarning[] {
  if (!Array.isArray(input)) return [];
  const validSignals = new Set<MissedSpeechSignal>([
    'energySpeech',
    'engineVad',
    'subtitleGap',
    'wordGap',
    'timingMismatch',
    'textMismatch',
    'speechReview',
  ]);
  const seen = new Set<string>();
  return input
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const { startMs, endMs, level } = value;
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs < 0 ||
        endMs <= startMs ||
        !['low', 'medium', 'high'].includes(level)
      )
        return [];
      const roundedStartMs = Math.round(startMs);
      const roundedEndMs = Math.round(endMs);
      if (
        !Number.isSafeInteger(roundedStartMs) ||
        !Number.isSafeInteger(roundedEndMs) ||
        roundedEndMs <= roundedStartMs
      )
        return [];
      const id = `missed-speech:${roundedStartMs}:${roundedEndMs}`;
      if (seen.has(id)) return [];
      const signals = Array.from(
        new Set<MissedSpeechSignal>(
          (Array.isArray(value.signals) ? value.signals : []).filter(
            (signal: MissedSpeechSignal) => validSignals.has(signal),
          ),
        ),
      );
      if (
        !signals.includes('speechReview') &&
        (!signals.includes('energySpeech') || signals.length < 2)
      )
        return [];
      seen.add(id);
      return [
        {
          id,
          startMs: roundedStartMs,
          endMs: roundedEndMs,
          level,
          signals,
          ...(typeof value.suggestedText === 'string' &&
          value.suggestedText.trim()
            ? { suggestedText: value.suggestedText.slice(0, 2000) }
            : {}),
          cueIds: Array.isArray(value.cueIds)
            ? Array.from(
                new Set(
                  value.cueIds.filter(
                    (id: unknown) => typeof id === 'string' && id.length > 0,
                  ),
                ),
              )
            : [],
          ...(typeof value.originalText === 'string' &&
          value.originalText.trim()
            ? { originalText: value.originalText.slice(0, 2000) }
            : {}),
        } as MissedSpeechWarning,
      ];
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
