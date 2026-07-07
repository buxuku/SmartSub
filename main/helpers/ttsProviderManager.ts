import type { TtsProvider } from '../../types/ttsProvider';
import { store } from './store';

export function getTtsProviders(): TtsProvider[] {
  return store.get('ttsProviders') || [];
}

export function setTtsProviders(providers: TtsProvider[]): void {
  store.set('ttsProviders', Array.isArray(providers) ? providers : []);
}

export function getTtsProviderById(
  id: string | undefined,
): TtsProvider | undefined {
  if (!id) return undefined;
  return getTtsProviders().find((p) => p.id === id);
}
