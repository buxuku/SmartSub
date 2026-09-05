import { detectAll, validateISO2 } from 'tinyld';
import path from 'path';
import { normalizeTtsLanguage } from '../../../types/ttsLanguage';
import { findDubbingProofreadDataFile } from './speakerMetadata';
import { normalizeDubbingSpeechText } from './textNormalization';

/** Detect across the subtitle, never independently on short/numeric cues. */
export function detectDubbingLanguage(text: string): string | undefined {
  const sample = normalizeDubbingSpeechText(text).slice(0, 12000);
  const letters = sample.match(new RegExp('\\p{L}', 'gu')) || [];
  if (letters.length < 8) return undefined;
  const [best, next] = detectAll(sample);
  // tinyld scores are rankings, not probabilities. Reject close/weak matches.
  if (
    !best ||
    best.accuracy < 0.05 ||
    (next && best.accuracy < next.accuracy * 1.5)
  )
    return undefined;
  return normalizeTtsLanguage(best.lang);
}

/** Sidecar language is authoritative only when its path identifies the text column. */
export function dubbingSubtitleLanguage(
  subtitlePath: string,
  sidecarPath?: string,
): string | undefined {
  const found = findDubbingProofreadDataFile(subtitlePath, sidecarPath);
  const meta = found?.data.meta;
  const same = (p?: string) =>
    p && path.resolve(p) === path.resolve(subtitlePath);
  if (meta) {
    if (same(meta.sourceFile)) return normalizeTtsLanguage(meta.sourceLanguage);
    if (
      same(meta.targetFile) ||
      (same(meta.finalTargetFile) && meta.translateContent === 'onlyTranslate')
    ) {
      return normalizeTtsLanguage(meta.targetLanguage);
    }
  }
  // Keep regional tags; a bare/ambiguous filename supplies no language.
  const match =
    /[._]([a-z]{2,3}(?:[-_][a-z]{2,8})*)\.(?:srt|vtt|ass|ssa|lrc)$/i.exec(
      path.basename(subtitlePath),
    );
  const language = match ? normalizeTtsLanguage(match[1]) : undefined;
  return language && validateISO2(language.split('-')[0])
    ? language
    : undefined;
}
