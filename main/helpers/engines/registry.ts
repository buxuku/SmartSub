import { builtinEngineAdapter } from './builtinEngine';
import { fasterWhisperEngineAdapter } from './fasterWhisperEngine';
import { localCliEngineAdapter } from './localCliEngine';
import { resolveTranscriptionEngine } from '../transcriptionEngine';
import { store } from '../storeManager';
import type { TranscriptionEngine } from '../../../types/engine';
import type { TranscriptionEngineAdapter } from './types';

const adapters: TranscriptionEngineAdapter[] = [
  builtinEngineAdapter,
  fasterWhisperEngineAdapter,
  localCliEngineAdapter,
];

export function getEngineAdapter(
  id: TranscriptionEngine,
): TranscriptionEngineAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

export function getActiveEngineAdapter(): TranscriptionEngineAdapter {
  const id = resolveTranscriptionEngine(store.get('settings'));
  return getEngineAdapter(id) ?? builtinEngineAdapter;
}

export function listEngineAdapters(): TranscriptionEngineAdapter[] {
  return adapters;
}
