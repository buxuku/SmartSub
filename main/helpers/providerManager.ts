import {
  Provider,
  PROVIDER_TYPES,
  defaultSystemPrompt,
} from '../../types/provider';
import { store } from './store';
import { logMessage } from './logger';

const CURRENT_PROVIDER_VERSION = 8; // 如果新增或者修改了翻译服务商，请更新版本号

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

function migrateProviders(oldProviders: any[]): Provider[] {
  // 分离内置和自定义服务商
  const builtinProviders = oldProviders
    .filter((p) => PROVIDER_TYPES.some((type) => type.id === p.id))
    .map((p) => {
      const template = PROVIDER_TYPES.find((type) => type.id === p.id)!;
      return {
        ...p,
        type: p.id, // 确保 type 与 id 一致
        isAi: template.isAi || false,
        // 为不同服务商设置默认批量大小
        ...(p.id === 'baidu' && { batchSize: 18 }),
        ...(p.id === 'volc' && { batchSize: 16 }),
        ...(p.id === 'azure' && { batchSize: 50 }),
        // 为 AI 提供商添加新字段
        ...(template.isAi && {
          useBatchTranslation: false,
          batchTranslationSize: 10,
          systemPrompt: defaultSystemPrompt,
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
      systemPrompt: defaultSystemPrompt,
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
