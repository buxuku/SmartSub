import { createHash } from 'crypto';
import { DUBBING_ALIGNMENT_RULES_VERSION } from '../../../types/dubbing';
import type {
  DubbingConfig,
  DubbingSpeakerSettings,
} from '../../../types/dubbing';
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
  speakerSettings?: DubbingSpeakerSettings,
  interval?: { startMs: number; endMs: number },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        engine: config.engine,
        alignment: DUBBING_ALIGNMENT_RULES_VERSION,
        interval,
        voice,
        text,
        language: normalizeTtsLanguage(language),
        rules: config.engine.kind === 'local' ? TTS_TEXT_RULES_VERSION : 1,
        speed: config.globalSpeed || 1,
        speaker:
          speakerSettings &&
          (speakerSettings.speed !== 1 || speakerSettings.pitch !== 0)
            ? {
                speed: speakerSettings.speed,
                pitch: speakerSettings.pitch,
                processing: 1,
              }
            : undefined,
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
  _config: DubbingConfig,
): boolean {
  if (previous) return previous !== current;
  // Legacy audio may already have been sped up or fitted to implicit silence.
  // Retain it for playback, but require regeneration under current rules.
  return true;
}
