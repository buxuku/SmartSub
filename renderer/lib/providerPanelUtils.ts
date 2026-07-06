import { PROVIDER_TYPES, type Provider } from '../../types/provider';
import { isProviderConfigured } from './providerUtils';

export const LAST_PROVIDER_STORAGE_KEY = 'resourcesProvidersSelectedId';

/** AI / 限流类表单项，折叠到「高级选项」 */
export const PROVIDER_ADVANCED_FIELD_KEYS = new Set([
  'systemPrompt',
  'prompt',
  'structuredOutput',
  'windowMaxRequests',
]);

/** 批量翻译三参数：不折叠，在表单主体并排一行直显（顺序即展示顺序） */
export const PROVIDER_BATCH_ROW_FIELD_KEYS = [
  'batchSize',
  'batchConcurrency',
  'requestInterval',
] as const;

export function sortProvidersCustomFirst(list: Provider[]): Provider[] {
  const custom = list
    .filter((p) => p.type === 'openai')
    .sort((a, b) => {
      const ta = Number.parseInt(a.id.replace('openai_', ''), 10) || 0;
      const tb = Number.parseInt(b.id.replace('openai_', ''), 10) || 0;
      return tb - ta;
    });
  const rest = list.filter((p) => p.type !== 'openai');
  return [...custom, ...rest];
}

export function providersOrderChanged(a: Provider[], b: Provider[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((p, i) => p.id !== b[i]?.id);
}

export function readStoredProviderId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LAST_PROVIDER_STORAGE_KEY);
    if (!raw) return null;
    const id = JSON.parse(raw);
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export function resolveSelectedProviderId(
  list: Provider[],
  preferredId?: string | null,
): string | null {
  const preferred = preferredId ?? readStoredProviderId();
  if (preferred && list.some((p) => p.id === preferred)) return preferred;
  if (list.some((p) => p.id === 'google')) return 'google';
  return (
    list.find((p) => PROVIDER_TYPES.some((t) => t.id === p.id))?.id ??
    list[0]?.id ??
    null
  );
}

export async function resolveSelectedProviderIdAsync(
  list: Provider[],
  preferredId?: string | null,
): Promise<string | null> {
  const stored = preferredId ?? readStoredProviderId();
  if (stored && list.some((p) => p.id === stored)) return stored;

  try {
    const cfg = await window?.ipc?.invoke('getUserConfig');
    const fromConfig = cfg?.translateProvider;
    if (
      fromConfig &&
      fromConfig !== '-1' &&
      list.some((p) => p.id === fromConfig)
    ) {
      return fromConfig;
    }
  } catch {
    /* ignore */
  }

  return resolveSelectedProviderId(list, null);
}

export function resolveDefaultTranslateProviderId(
  providers: Provider[],
  preferredId?: string | null,
): string {
  const pick = (id: string | null | undefined) => {
    if (!id) return null;
    const p = providers.find((x) => x.id === id);
    return p && isProviderConfigured(p) ? id : null;
  };
  return (
    pick(preferredId) ??
    pick(readStoredProviderId()) ??
    pick('google') ??
    providers.find((p) => isProviderConfigured(p))?.id ??
    ''
  );
}

export function getTestSampleText(sourceLanguage: string): string {
  return sourceLanguage?.startsWith('zh') ? '你好' : 'Hello';
}

const PROVIDER_ERROR_KEYS = [
  'missingKeyOrSecret',
  'not supported language',
  'Unknown translation provider',
] as const;

export function formatProviderError(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? 'unknown');
  for (const code of PROVIDER_ERROR_KEYS) {
    if (raw.includes(code)) {
      const key = `providerError.${code.replace(/\s+/g, '_')}`;
      const text = t(key);
      if (text !== key) return text;
    }
  }
  if (raw.includes('401') || raw.toLowerCase().includes('unauthorized')) {
    const text = t('providerError.unauthorized');
    if (text !== 'providerError.unauthorized') return text;
  }
  if (raw.toLowerCase().includes('api key not valid')) {
    const text = t('providerError.api_key_not_valid');
    if (text !== 'providerError.api_key_not_valid') return text;
  }
  return raw;
}

export async function syncTranslateProviderToUserConfig(
  providerId: string,
): Promise<void> {
  const cfg = await window?.ipc?.invoke('getUserConfig');
  if (!cfg || cfg.translateProvider === providerId) return;
  window?.ipc?.send('setUserConfig', {
    ...cfg,
    translateProvider: providerId,
  });
}

export async function syncTestLangsToUserConfig(
  source: string,
  target: string,
): Promise<void> {
  const cfg = await window?.ipc?.invoke('getUserConfig');
  if (
    !cfg ||
    (cfg.sourceLanguage === source && cfg.targetLanguage === target)
  ) {
    return;
  }
  window?.ipc?.send('setUserConfig', {
    ...cfg,
    sourceLanguage: source,
    targetLanguage: target,
  });
}
