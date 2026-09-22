import type { TtsProvider } from '../../types/ttsProvider';
import { store } from './store';
import { assertProviderList } from '../../types/providerPersistence';

/**
 * 云端配音（TTS）服务商实例的读写管理（形制 asrProviderManager）。
 * 不自动初始化内置实例（Edge 等零凭据类型也由用户显式添加），缺省即空列表。
 */
export function getTtsProviders(): TtsProvider[] {
  const stored = store.get('ttsProviders');
  const providers = stored === undefined ? [] : stored;
  assertProviderList(providers);
  return providers;
}

export function setTtsProviders(providers: TtsProvider[]): void {
  assertProviderList(providers);
  store.set('ttsProviders', providers);
}

export function getTtsProviderById(
  id: string | undefined,
): TtsProvider | undefined {
  if (!id) return undefined;
  return getTtsProviders().find((p) => p.id === id);
}
