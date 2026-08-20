import { Provider, PROVIDER_TYPES } from '../../types/provider';
import { store } from './store';
import { logMessage } from './logger';
import {
  migrateProviders,
  normalizeFallbackProviderIds,
} from './providerMigration';

// v21：默认提示词升级为 src/tr 回显协议 + echoAnchoring 字段默认开启（openspec: ai-translation-alignment）
// v22：思考模式开关 enableThinking 默认关闭（= 主动禁用思考，openspec: ai-thinking-mode-control）
// v23：新增独立的 Qwen-MT 机器翻译服务商
// v24：同 type 服务实例与任务内回退链
const CURRENT_PROVIDER_VERSION = 24;

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
      const normalizedProviders = normalizeFallbackProviderIds(savedProviders);
      if (normalizedProviders !== savedProviders) {
        store.set('translationProviders', normalizedProviders);
      }
      return normalizedProviders;
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
