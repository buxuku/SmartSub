import type { TranscriptionEngine } from '../../types/engine';
import type { StoreType } from './store/types';

export function resolveTranscriptionEngine(
  settings: StoreType['settings'] | undefined,
): TranscriptionEngine {
  if (settings?.transcriptionEngine) return settings.transcriptionEngine;
  return settings?.useLocalWhisper ? 'localCli' : 'builtin';
}
