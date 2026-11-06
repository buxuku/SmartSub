import type { Subtitle } from '../hooks/useSubtitles';

export type AiIntent = 'polish' | 'shorten';
export interface InlineAiSuggestion {
  requestId: string;
  index: number;
  snapshot: string;
  structure: string;
  original: string;
  field: 'sourceContent' | 'targetContent';
  intent: AiIntent;
  status: 'loading' | 'ready' | 'error';
  proposed?: string;
  error?: string;
}

export const cueSnapshot = (cue: Subtitle): string => JSON.stringify(cue);

// IDs are renumbered after structural edits. Include timing and order so an old
// index cannot silently identify a different cue after a split/merge/reorder.
export const cueStructure = (cues: Subtitle[]): string =>
  JSON.stringify(
    cues.map((cue) => [cue.id, cue.startTimeInSeconds, cue.endTimeInSeconds]),
  );

export function canAcceptSuggestion(
  suggestion: InlineAiSuggestion,
  cues: Subtitle[],
): boolean {
  return (
    suggestion.status === 'ready' &&
    !!suggestion.proposed?.trim() &&
    cueStructure(cues) === suggestion.structure &&
    !!cues[suggestion.index] &&
    cueSnapshot(cues[suggestion.index]) === suggestion.snapshot
  );
}

export function aiPrompt(
  mode: 'translation' | 'transcript',
  batch: boolean,
  intent: AiIntent,
): string {
  const task =
    intent === 'shorten'
      ? 'Shorten the subtitle text while preserving names, facts, meaning, and tone. Use fewer characters. Do not add information.'
      : mode === 'transcript'
        ? 'Correct transcription errors, punctuation, and casing. Preserve the original meaning and wording. Do not translate or summarize.'
        : 'Improve the translation for accuracy, natural wording, and concise subtitle display. Preserve the original meaning and tone.';
  const language =
    mode === 'transcript' ? '{{sourceLanguage}}' : '{{targetLanguage}}';
  return (
    `You are a professional subtitle editor. ${task}\nOutput language: ${language}.\n` +
    (batch
      ? 'Return ONLY a valid JSON object with subtitle IDs as keys and edited texts as string values.'
      : 'Original text ({{sourceLanguage}}):\n{{sourceText}}\nCurrent translation ({{targetLanguage}}):\n{{targetText}}\nReturn ONLY the edited subtitle text, no quotes or explanation.')
  );
}
