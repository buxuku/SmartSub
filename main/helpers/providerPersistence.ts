import isEqual from 'lodash/isEqual';
import { assertProviderList } from '../../types/providerPersistence';

/** Compare and commit synchronously so another window cannot overwrite newer credentials. */
export function saveProviderList(
  request: unknown,
  read: () => unknown,
  write: (providers: any[]) => void,
): { success: true } {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('INVALID_PROVIDER_SAVE_REQUEST');
  const { providers, expectedProviders } = request as Record<string, unknown>;
  assertProviderList(providers);
  assertProviderList(expectedProviders);
  const current = read();
  assertProviderList(current);
  // Idempotent replay also repairs a lost acknowledgement without rewriting disk.
  if (isEqual(current, providers)) return { success: true };
  if (!isEqual(current, expectedProviders))
    throw new Error('PROVIDER_SETTINGS_CONFLICT');
  write(providers);
  return { success: true };
}
