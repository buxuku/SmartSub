import { PROVIDER_TYPES, type Provider } from '../../types/provider';

/**
 * 服务商是否已完成必填配置。
 * 按类型模板的 required 字段逐一检查实例值；无必填字段的服务商（如本地服务）视为已配置。
 */
export function isProviderConfigured(provider: Provider): boolean {
  const template = PROVIDER_TYPES.find((type) => type.id === provider.type);
  if (!template) return true;
  return template.fields
    .filter((field) => field.required)
    .every((field) => {
      const value = provider[field.key];
      return (
        value !== undefined && value !== null && String(value).trim() !== ''
      );
    });
}
