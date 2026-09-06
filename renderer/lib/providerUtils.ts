export { isProviderConfigured } from '../../types/provider';
import type { Provider } from '../../types/provider';

export function isFallbackProviderInstance(
  providers: Provider[],
  providerId: string,
): boolean {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return false;
  return (
    (provider.type !== 'openai' && provider.id !== provider.type) ||
    provider.id.startsWith(`provider_${provider.type}_`) ||
    providers.some(
      (item) =>
        Array.isArray(item.fallbackProviderIds) &&
        item.fallbackProviderIds.includes(providerId),
    )
  );
}
