import type { AsrProvider } from '../../types/asrProvider';
import { store } from './store';

/**
 * 云端听写（在线 ASR）服务商实例的读写管理。
 *
 * 与翻译服务商 providerManager 不同：ASR 实例必须携带用户凭据，故**不**自动初始化任何
 * 内置实例（避免 electron-store 回灌空凭据实例污染下拉/就绪判定）。缺省即空列表。
 */
export function getAsrProviders(): AsrProvider[] {
  return store.get('asrProviders') || [];
}

export function setAsrProviders(providers: AsrProvider[]): void {
  store.set('asrProviders', Array.isArray(providers) ? providers : []);
}

export function getAsrProviderById(
  id: string | undefined,
): AsrProvider | undefined {
  if (!id) return undefined;
  return getAsrProviders().find((p) => p.id === id);
}
