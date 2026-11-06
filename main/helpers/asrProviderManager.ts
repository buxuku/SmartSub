import type { AsrProvider } from '../../types/asrProvider';
import { store } from './store';
import { assertProviderList } from '../../types/providerPersistence';

/**
 * 云端听写（在线 ASR）服务商实例的读写管理。
 *
 * 与翻译服务商 providerManager 不同：ASR 实例必须携带用户凭据，故**不**自动初始化任何
 * 内置实例（避免 electron-store 回灌空凭据实例污染下拉/就绪判定）。缺省即空列表。
 */
export function getAsrProviders(): AsrProvider[] {
  const stored = store.get('asrProviders');
  const providers = stored === undefined ? [] : stored;
  assertProviderList(providers);
  return providers;
}

export function setAsrProviders(providers: AsrProvider[]): void {
  assertProviderList(providers);
  store.set('asrProviders', providers);
}

export function getAsrProviderById(
  id: string | undefined,
): AsrProvider | undefined {
  if (!id) return undefined;
  return getAsrProviders().find((p) => p.id === id);
}
