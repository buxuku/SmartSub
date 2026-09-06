import {
  Provider,
  PROVIDER_TYPES,
  TENCENT_DEFAULT_REQUEST_INTERVAL_SECONDS,
  defaultSystemPrompt,
  HISTORICAL_DEFAULT_PROMPTS,
  isProviderConfigured,
} from '../../types/provider';

const FREE_PROVIDER_IDS = ['autoFree', 'bingFree', 'googleFree'];

function shouldUpdateSystemPrompt(currentPrompt: string | undefined): boolean {
  if (!currentPrompt) return true;
  const trimmed = currentPrompt.trim();
  if (trimmed === defaultSystemPrompt.trim()) return false;
  return HISTORICAL_DEFAULT_PROMPTS.some(
    (historical) => trimmed === historical.trim(),
  );
}

function withTencentRateLimitDefaults(provider: any): any {
  if (provider.type !== 'tencent') return provider;

  const currentInterval = Number(provider.requestInterval || 0);
  if (currentInterval > 0) return provider;

  return {
    ...provider,
    requestInterval: TENCENT_DEFAULT_REQUEST_INTERVAL_SECONDS,
  };
}

function withFreeRateLimitDefaults(provider: any): any {
  if (!FREE_PROVIDER_IDS.includes(provider.type)) return provider;

  const currentInterval = Number(provider.requestInterval || 0);
  if (currentInterval > 0) return provider;

  const template = PROVIDER_TYPES.find((type) => type.id === provider.type);
  const defaultInterval = template?.fields.find(
    (field) => field.key === 'requestInterval',
  )?.defaultValue;
  if (defaultInterval === undefined) return provider;

  return {
    ...provider,
    requestInterval: defaultInterval,
  };
}

/** 将旧服务配置升级为按 `type` 识别的独立实例，并保留同类型重复实例。 */
export function migrateProviders(oldProviders: any[]): Provider[] {
  const knownBuiltinTypeIds = new Set(
    PROVIDER_TYPES.filter((type) => type.isBuiltin).map((type) => type.id),
  );
  const normalized = oldProviders.map((provider) => {
    const legacyType =
      typeof provider?.type === 'string' && provider.type.trim()
        ? provider.type
        : provider?.id;
    return {
      ...provider,
      type: legacyType,
    };
  });

  const builtinProviders = normalized
    .filter((provider) => knownBuiltinTypeIds.has(provider.type))
    .map((provider) => {
      const template = PROVIDER_TYPES.find(
        (type) => type.id === provider.type,
      )!;
      return withTencentRateLimitDefaults(
        withFreeRateLimitDefaults({
          ...provider,
          isAi: template.isAi || false,
          batchConcurrency: provider.batchConcurrency || 1,
          ...(provider.type === 'baidu' && { batchSize: 18 }),
          ...(provider.type === 'volc' && { batchSize: 16 }),
          ...(provider.type === 'azure' && { batchSize: 50 }),
          ...(template.isAi && {
            useBatchTranslation: false,
            batchTranslationSize: 10,
            systemPrompt: shouldUpdateSystemPrompt(provider.systemPrompt)
              ? defaultSystemPrompt
              : provider.systemPrompt,
            structuredOutput:
              provider.structuredOutput ||
              template.fields.find((field) => field.key === 'structuredOutput')
                ?.defaultValue ||
              'json_object',
            echoAnchoring: provider.echoAnchoring !== false,
            enableThinking: provider.enableThinking === true,
            ...(provider.type === 'ollama' &&
              provider.structuredOutput !== 'disabled' && {
                structuredOutput: 'json_schema',
              }),
          }),
        }),
      );
    });

  const customProviders = normalized
    .filter((provider) => provider.type === 'openai')
    .map((provider) => ({
      ...provider,
      isAi: true,
      useBatchTranslation: false,
      batchTranslationSize: 10,
      batchConcurrency: provider.batchConcurrency || 1,
      systemPrompt: shouldUpdateSystemPrompt(provider.systemPrompt)
        ? defaultSystemPrompt
        : provider.systemPrompt,
      structuredOutput: provider.structuredOutput || 'json_object',
      echoAnchoring: provider.echoAnchoring !== false,
      enableThinking: provider.enableThinking === true,
    }));

  const existingTypes = new Set(
    builtinProviders.map((provider) => provider.type),
  );
  const missingProviders = PROVIDER_TYPES.filter(
    (type) => type.isBuiltin && !existingTypes.has(type.id),
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

  return normalizeFallbackProviderIds([
    ...builtinProviders,
    ...missingProviders,
    ...customProviders,
  ] as Provider[]);
}

/** 清理跨类型、自引用、重复和已删除实例形成的无效回退项。 */
export function normalizeFallbackProviderIds(
  providers: Provider[],
): Provider[] {
  const list = Array.isArray(providers) ? providers : [];
  let changed = !Array.isArray(providers);
  const typedProviders = list.map((provider) => {
    const legacyType =
      typeof provider?.type === 'string' && provider.type.trim()
        ? provider.type
        : provider?.id;
    if (provider.type === legacyType) return provider;
    changed = true;
    return { ...provider, type: legacyType };
  });
  const byId = new Map(
    typedProviders.map((provider) => [provider.id, provider]),
  );

  const normalized = typedProviders.map((provider) => {
    const raw = provider.fallbackProviderIds;
    if (raw === undefined) return provider;
    if (!Array.isArray(raw)) {
      changed = true;
      const copy = { ...provider };
      delete copy.fallbackProviderIds;
      return copy;
    }

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const rawId of raw) {
      const candidate = byId.get(String(rawId));
      if (
        !candidate ||
        candidate.id === provider.id ||
        candidate.type !== provider.type ||
        seen.has(candidate.id)
      ) {
        continue;
      }
      seen.add(candidate.id);
      ids.push(candidate.id);
    }

    if (
      ids.length === raw.length &&
      ids.every((id, index) => id === raw[index])
    ) {
      return provider;
    }

    changed = true;
    if (ids.length > 0) return { ...provider, fallbackProviderIds: ids };
    const copy = { ...provider };
    delete copy.fallbackProviderIds;
    return copy;
  });

  return changed ? normalized : providers;
}

/** 解析主实例的有序同类型备用实例；备用实例自身的链不会递归展开。 */
export function resolveProviderFallbacks(
  providers: Provider[],
  primary: Provider | undefined,
): Provider[] {
  if (!primary || !Array.isArray(primary.fallbackProviderIds)) return [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  return primary.fallbackProviderIds
    .map((id) => byId.get(id))
    .filter((candidate): candidate is Provider => {
      if (
        !candidate ||
        candidate.id === primary.id ||
        !isProviderConfigured(candidate)
      )
        return false;
      if (candidate.type !== primary.type || seen.has(candidate.id)) {
        return false;
      }
      seen.add(candidate.id);
      return true;
    });
}
