import { createHash } from 'crypto';
import type { DubbingConfig } from '../../../types/dubbing';
import {
  TTS_TEXT_RULES_VERSION,
  normalizeTtsLanguage,
} from '../../../types/ttsLanguage';

/** Identifies the final speech input and the deterministic rules that consume it. */
export function dubbingInputKey(
  config: DubbingConfig,
  voice: string,
  text: string,
  language?: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        engine: config.engine,
        voice,
        text,
        language: normalizeTtsLanguage(language),
        rules: config.engine.kind === 'local' ? TTS_TEXT_RULES_VERSION : 1,
        speed: config.globalSpeed || 1,
        quality:
          config.engine.kind === 'local' &&
          config.engine.modelId === 'zipvoice-distill-zh-en'
            ? (config.cloneQuality ?? 'standard')
            : undefined,
      }),
    )
    .digest('hex');
}

export function dubbingInputNeedsUpdate(
  previous: string | undefined,
  current: string,
  config: DubbingConfig,
): boolean {
  if (previous) return previous !== current;
  // Legacy local audio predates the language-aware frontend. Preserve the WAV,
  // but require regeneration instead of silently exporting unverifiable audio.
  return (
    config.engine.kind === 'local' ||
    Boolean(normalizeTtsLanguage(config.language))
  );
}
