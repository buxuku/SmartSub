import {
  Provider,
  PROVIDER_TYPES,
  defaultSystemPrompt,
  HISTORICAL_DEFAULT_PROMPTS,
} from '../../types/provider';
import { store } from './store';
import { logMessage } from './logger';

const CURRENT_PROVIDER_VERSION = 15;

export async function getAndInitializeProviders(): Promise<Provider[]> {
  try {
    const savedProviders = store.get('translationProviders') || [];
    const savedVersion = store.get('providerVersion');
    // 如果是新安装或已经是最新版本，直接初始化
    if (savedProviders.length === 0) {
      logMessage('Initializing default providers', 'info');
      return initializeDefaultProviders();
    }

    if (savedVersion === CURRENT_PROVIDER_VERSION) {
      return savedProviders;
    }

    // 需要迁移的情况
    logMessage('Migrating providers', 'info');
    const migratedProviders = migrateProviders(savedProviders);
    store.set('translationProviders', migratedProviders);
    store.set('providerVersion', CURRENT_PROVIDER_VERSION);

    return migratedProviders;
  } catch (error) {
    logMessage(`Error initializing providers: ${error.message}`, 'error');
    return [] as Provider[];
  }
}

function initializeDefaultProviders(): Provider[] {
  const providers = PROVIDER_TYPES.filter((type) => type.isBuiltin).map(
    (type) => ({
      id: type.id,
      name: type.name,
      type: type.id,
      isAi: type.isAi || false,
      ...Object.fromEntries(
        type.fields
          .filter((field) => field.defaultValue !== undefined)
          .map((field) => [field.key, field.defaultValue]),
      ),
    }),
  );

  store.set('translationProviders', providers);
  store.set('providerVersion', CURRENT_PROVIDER_VERSION);
  return providers;
}

/**
 * 判断用户的 systemPrompt 是否需要更新为新的默认值
 * 如果用户的值为空、等于当前默认值、或匹配任意历史默认值 → 更新
 * 否则说明用户自定义过 → 保留
 */
function shouldUpdateSystemPrompt(currentPrompt: string | undefined): boolean {
  if (!currentPrompt) return true;
  const trimmed = currentPrompt.trim();
  if (trimmed === defaultSystemPrompt.trim()) return false;
  return HISTORICAL_DEFAULT_PROMPTS.some(
    (historical) => trimmed === historical.trim(),
  );
}

function migrateProviders(oldProviders: any[]): Provider[] {
  // 分离内置和自定义服务商
  const builtinProviders = oldProviders
    .filter((p) => PROVIDER_TYPES.some((type) => type.id === p.id))
    .map((p) => {
      const template = PROVIDER_TYPES.find((type) => type.id === p.id)!;
      return {
        ...p,
        type: p.id,
        isAi: template.isAi || false,
        ...(p.id === 'baidu' && { batchSize: 18 }),
        ...(p.id === 'volc' && { batchSize: 16 }),
        ...(p.id === 'azure' && { batchSize: 50 }),
        ...(template.isAi && {
          useBatchTranslation: false,
          batchTranslationSize: 10,
          systemPrompt: shouldUpdateSystemPrompt(p.systemPrompt)
            ? defaultSystemPrompt
            : p.systemPrompt,
          structuredOutput:
            p.structuredOutput ||
            template.fields.find((f) => f.key === 'structuredOutput')
              ?.defaultValue ||
            'json_object',
        }),
      };
    });

  const customProviders = oldProviders
    .filter(
      (p) =>
        p.type === 'openai' && !PROVIDER_TYPES.some((type) => type.id === p.id),
    )
    .map((p) => ({
      ...p,
      isAi: true,
      useBatchTranslation: false,
      batchTranslationSize: 10,
      systemPrompt: shouldUpdateSystemPrompt(p.systemPrompt)
        ? defaultSystemPrompt
        : p.systemPrompt,
      structuredOutput: p.structuredOutput || 'json_schema',
    }));

  // 添加缺失的内置服务商
  const existingIds = builtinProviders.map((p) => p.id);
  const missingProviders = PROVIDER_TYPES.filter(
    (type) => type.isBuiltin && !existingIds.includes(type.id),
  ).map((type) => ({
    id: type.id,
    name: type.name,
    type: type.id,
    isAi: type.isAi || false,
    ...Object.fromEntries(
      type.fields
        .filter((field) => field.defaultValue !== undefined)
        .map((field) => [field.key, field.defaultValue]),
    ),
  }));

  return [
    ...builtinProviders,
    ...missingProviders,
    ...customProviders,
  ] as Provider[];
}
