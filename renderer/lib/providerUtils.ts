import { Provider, PROVIDER_TYPES, CONFIG_TEMPLATES } from '../../types';

/**
 * 「已配置」= 该服务商类型声明的全部 required 字段均非空。
 * 无 required 字段的类型按未配置处理，避免空对象被误判为已配置。
 */
export function isProviderConfigured(provider: Provider | undefined): boolean {
  if (!provider) return false;
  const typeDef =
    provider.type === 'openai'
      ? CONFIG_TEMPLATES.openai
      : PROVIDER_TYPES.find((t) => t.id === provider.type);
  const requiredFields = (typeDef?.fields || []).filter((f) => f.required);
  if (requiredFields.length === 0) return false;
  return requiredFields.every((f) => {
    const value = provider[f.key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}
