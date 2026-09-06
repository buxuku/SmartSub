import {
  cloneProviderForFallback,
  nextProviderInstanceName,
  type Provider,
  type ProviderType,
} from '../types/provider';
import {
  migrateProviders,
  normalizeFallbackProviderIds,
  resolveProviderFallbacks,
} from '../main/helpers/providerMigration';
import {
  ProviderFallbackExhaustedError,
  ProviderFallbackRunner,
} from '../main/translate/services/providerFallback';
import { isFallbackEligibleError } from '../main/translate/utils/error';
import { isFallbackProviderInstance } from '../renderer/lib/providerUtils';
import { ParameterProcessor } from '../main/helpers/parameterProcessor';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'primary',
    name: 'Primary',
    type: 'openai',
    isAi: true,
    apiKey: 'primary-key',
    apiUrl: 'https://example.test/v1',
    modelName: 'test-model',
    ...overrides,
  };
}

async function testRunnerSwitchesAndSticks() {
  const primary = provider();
  const backup = provider({
    id: 'backup',
    name: 'Backup',
    apiKey: 'backup-key',
  });
  const otherType = provider({ id: 'gemini', type: 'Gemini', name: 'Gemini' });
  const calls: string[] = [];
  let primaryCalls = 0;
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [backup, otherType],
    resolveTranslator: (candidate) => async () => {
      calls.push(candidate.id);
      if (candidate.id === primary.id && primaryCalls++ === 0) {
        throw new Error('HTTP 429 quota exceeded');
      }
      return `ok:${candidate.id}`;
    },
    log: () => undefined,
  });

  const first = await runner.run((candidate, translator) =>
    translator('text', candidate, 'en', 'zh'),
  );
  const second = await runner.run((candidate, translator) =>
    translator('text', candidate, 'en', 'zh'),
  );

  assert(first === 'ok:backup', 'first request should use backup');
  assert(second === 'ok:backup', 'runner should stick to successful backup');
  assert(
    JSON.stringify(calls) === JSON.stringify(['primary', 'backup', 'backup']),
    'unexpected call order',
  );
}

async function testRunnerDoesNotSwitchForBadRequest() {
  const primary = provider();
  const backup = provider({ id: 'backup', name: 'Backup' });
  let backupCalled = false;
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [backup],
    resolveTranslator: (candidate) => async () => {
      if (candidate.id === backup.id) backupCalled = true;
      throw new Error('HTTP 400 unsupported language');
    },
    log: () => undefined,
  });

  let failed = false;
  try {
    await runner.run((candidate, translator) =>
      translator('text', candidate, 'en', 'xx'),
    );
  } catch {
    failed = true;
  }
  assert(failed, 'bad request should fail');
  assert(!backupCalled, 'bad request must not switch provider');
}

async function testConcurrentFailuresNotifyOnce() {
  const primary = provider();
  const backup = provider({ id: 'backup', name: 'Backup' });
  let fallbackEvents = 0;
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [backup],
    resolveTranslator: (candidate) => async () => {
      await Promise.resolve();
      if (candidate.id === primary.id) throw new Error('HTTP 429 rate limit');
      return 'ok';
    },
    onFallback: () => {
      fallbackEvents += 1;
    },
    log: () => undefined,
  });

  const results = await Promise.all([
    runner.run((candidate, translator) =>
      translator('first', candidate, 'en', 'zh'),
    ),
    runner.run((candidate, translator) =>
      translator('second', candidate, 'en', 'zh'),
    ),
  ]);
  assert(
    results.every((result) => result === 'ok'),
    'backup should succeed',
  );
  assert(fallbackEvents === 1, 'concurrent failures should notify only once');
}

async function testExhaustionPreservesLastError() {
  const primary = provider();
  const backup = provider({ id: 'backup', name: 'Backup' });
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [backup],
    resolveTranslator: (candidate) => async () => {
      throw new Error(`HTTP 429 ${candidate.id}`);
    },
    log: () => undefined,
  });

  let firstError: unknown;
  let secondError: unknown;
  try {
    await runner.run((candidate, translator) =>
      translator('text', candidate, 'en', 'zh'),
    );
  } catch (error) {
    firstError = error;
  }
  try {
    await runner.run((candidate, translator) =>
      translator('text', candidate, 'en', 'zh'),
    );
  } catch (error) {
    secondError = error;
  }

  assert(
    firstError instanceof ProviderFallbackExhaustedError,
    'all failed providers should produce an exhausted error',
  );
  assert(
    secondError === firstError,
    'later calls should preserve terminal error',
  );
  assert(
    firstError.causeError instanceof Error &&
      firstError.causeError.message === 'HTTP 429 backup',
    'exhausted error should preserve the final provider error',
  );
}

function testErrorClassifier() {
  assert(
    isFallbackEligibleError(new Error('HTTP 429 quota exceeded')),
    '429 should fallback',
  );
  assert(
    isFallbackEligibleError(new Error('fetch failed')),
    'network failure should fallback',
  );
  for (const status of [401, 403, 408, 500, 503]) {
    assert(
      isFallbackEligibleError(new Error(`HTTP ${status}`)),
      `HTTP ${status} should fallback`,
    );
  }
  assert(
    isFallbackEligibleError(new Error('Access denied')),
    'access denied should fallback when a service strips its HTTP status',
  );
  assert(
    isFallbackEligibleError(new Error('网络连接失败')),
    'localized network failure should fallback',
  );
  assert(
    isFallbackEligibleError(new Error('APIKEY余额不足')),
    'localized balance failure should fallback',
  );
  assert(
    !isFallbackEligibleError(new Error('unsupported language')),
    'language failure should not fallback',
  );
  assert(
    !isFallbackEligibleError(new Error('TASK_CANCELLED')),
    'cancel should not fallback',
  );
  assert(
    !isFallbackEligibleError(new Error('OpenAI API key is required')),
    'missing credentials should not fallback',
  );
  assert(
    !isFallbackEligibleError(new Error('HTTP 400 invalid model')),
    'invalid models should not fallback',
  );
}

async function testFallbackReasonIsSanitized() {
  const secret = 'sk-primary-secret-123456';
  const primary = provider({ apiKey: secret });
  const backup = provider({ id: 'backup', name: 'Backup' });
  let observedReason = '';
  let observedLog = '';
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [backup],
    resolveTranslator: (candidate) => async () => {
      if (candidate.id === primary.id) {
        throw new Error(`HTTP 401 Incorrect API key: ${secret}`);
      }
      return 'ok';
    },
    onFallback: ({ reason }) => {
      observedReason = reason;
    },
    log: (message) => {
      observedLog = message;
    },
  });

  await runner.run((candidate, translator) =>
    translator('text', candidate, 'en', 'zh'),
  );
  assert(
    !observedReason.includes(secret) && observedReason.includes('[redacted]'),
    'fallback event reason should redact credentials',
  );
  assert(
    !observedLog.includes(secret),
    'fallback logs should redact credentials',
  );
}

function testFallbackConfigNormalization() {
  const primary = provider({
    fallbackProviderIds: [
      'primary',
      'missing',
      'other-type',
      'backup',
      'backup',
    ],
  });
  const backup = provider({ id: 'backup', name: 'Backup' });
  const otherType = provider({
    id: 'other-type',
    name: 'Other type',
    type: 'deepseek',
  });
  const malformed = provider({
    id: 'malformed',
    fallbackProviderIds: 'backup' as any,
  });
  const normalized = normalizeFallbackProviderIds([
    primary,
    backup,
    otherType,
    malformed,
  ]);
  const normalizedPrimary = normalized.find(
    (candidate) => candidate.id === primary.id,
  )!;

  assert(
    JSON.stringify(normalizedPrimary.fallbackProviderIds) ===
      JSON.stringify(['backup']),
    'normalization should remove invalid and duplicate fallback ids',
  );
  assert(
    normalized.find((candidate) => candidate.id === malformed.id)
      ?.fallbackProviderIds === undefined,
    'malformed fallback config should be removed',
  );
  assert(
    JSON.stringify(
      resolveProviderFallbacks(normalized, normalizedPrimary).map(
        (candidate) => candidate.id,
      ),
    ) === JSON.stringify(['backup']),
    'runtime resolution should preserve valid same-type order',
  );
}

function testMigrationPreservesProviderInstances() {
  const oldProviders: Provider[] = [
    provider({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'deepseek',
      fallbackProviderIds: ['deepseek-backup'],
    }),
    provider({
      id: 'deepseek-backup',
      name: 'DeepSeek Backup',
      type: 'deepseek',
    }),
    provider({ id: 'openai-a', name: 'OpenAI A', type: 'openai' }),
    provider({ id: 'openai-b', name: 'OpenAI B', type: 'openai' }),
  ];
  const migrated = migrateProviders(oldProviders);
  const ids = migrated.map((candidate) => candidate.id);

  assert(
    ids.filter((id) => id === 'deepseek').length === 1 &&
      ids.filter((id) => id === 'deepseek-backup').length === 1,
    'migration should preserve duplicate built-in instances exactly once',
  );
  assert(
    ids.filter((id) => id === 'openai-a').length === 1 &&
      ids.filter((id) => id === 'openai-b').length === 1,
    'migration should preserve custom OpenAI instances exactly once',
  );
  assert(
    JSON.stringify(
      migrated.find((candidate) => candidate.id === 'deepseek')
        ?.fallbackProviderIds,
    ) === JSON.stringify(['deepseek-backup']),
    'migration should preserve a valid built-in fallback chain',
  );
}

async function testDraftFallbackIsSkipped() {
  const primary = provider({ fallbackProviderIds: ['draft', 'backup'] });
  const draft = provider({ id: 'draft', apiKey: '  ' });
  const backup = provider({ id: 'backup' });
  const providers = [primary, draft, backup];
  assert(
    JSON.stringify(
      resolveProviderFallbacks(providers, primary).map((item) => item.id),
    ) === JSON.stringify(['backup']),
    'runtime resolution should skip draft credentials',
  );
  assert(
    primary.fallbackProviderIds?.includes('draft'),
    'draft should remain editable in the saved chain',
  );
  const calls: string[] = [];
  const runner = new ProviderFallbackRunner({
    primary,
    fallbacks: [
      draft,
      provider({ id: 'missing-url', apiUrl: '' }),
      provider({ id: 'missing-model', modelName: '' }),
      backup,
    ],
    resolveTranslator: (candidate) => async () => {
      calls.push(candidate.id);
      if (candidate.id === primary.id) throw new Error('HTTP 429');
      return 'ok';
    },
    log: () => {},
  });
  await runner.run((candidate, translator) =>
    translator('text', candidate, 'en', 'zh'),
  );
  assert(
    JSON.stringify(calls) === JSON.stringify(['primary', 'backup']),
    'drafts must not block configured fallbacks',
  );
}

function testLocalizedInstanceNames() {
  const existing = [
    { name: 'DeepSeek' },
    { name: 'DeepSeek Backup 1' },
    { name: 'DeepSeek Backup 2' },
  ];
  assert(
    nextProviderInstanceName(existing, 'DeepSeek Backup 1', 'Backup') ===
      'DeepSeek Backup 3',
    'localized suffix should produce a stable root name',
  );
  assert(
    nextProviderInstanceName(
      [{ name: 'baidu' }],
      '\u767e\u5ea6\u7ffb\u8bd1',
      '\u5907\u7528',
    ) === '\u767e\u5ea6\u7ffb\u8bd1 \u5907\u7528 1',
    'localized built-in copies must always have a numbered suffix',
  );
  assert(
    nextProviderInstanceName(
      [{ name: 'DeepSeek Backup 1' }],
      'DeepSeek',
      'Backup',
    ) === 'DeepSeek Backup 2',
    'suffix must remain unique even without a matching root name',
  );
}

function testFallbackBrowsing() {
  const primary = provider({ fallbackProviderIds: ['existing-custom'] });
  const existing = provider({ id: 'existing-custom' });
  const detachedClone = provider({ id: 'provider_openai_detached' });
  const builtinClone = provider({ id: 'qwen-backup', type: 'qwen' });
  const independent = provider({ id: 'openai_123' });
  const providers = [
    primary,
    existing,
    detachedClone,
    builtinClone,
    independent,
  ];
  for (const backup of [existing, detachedClone, builtinClone]) {
    assert(
      isFallbackProviderInstance(providers, backup.id),
      'all fallback browsing entries must preserve the default provider',
    );
  }
  assert(
    !isFallbackProviderInstance(providers, primary.id),
    'primary selection should retain its existing behavior',
  );
  assert(
    !isFallbackProviderInstance(providers, independent.id),
    'independent custom providers should remain selectable as default',
  );
}

function testParameterCompatibilityUsesType() {
  const qwen = provider({ id: 'provider_qwen_copy', type: 'qwen' });
  assert(
    ParameterProcessor.validateParameter('top_k', 10, qwen).isValid,
    'Qwen clones must accept top_k',
  );
  assert(
    ParameterProcessor.validateParameter('enable_thinking', true, qwen).isValid,
    'Qwen clones must accept enable_thinking',
  );
  assert(
    !ParameterProcessor.validateParameter(
      'top_k',
      10,
      provider({ id: 'qwen', type: 'openai' }),
    ).isValid,
    'instance IDs must not grant capabilities of another type',
  );
  assert(
    ParameterProcessor.getSupportedParameters(qwen.type).some(
      (item) => item.key === 'top_k',
    ),
    'supported parameters should use the resolved type',
  );
}

function testCloneClearsCredentials() {
  const source = provider({
    appId: 'app',
    apiSecret: 'secret',
    apiUrl: 'https://example.test/v1',
    modelName: 'model-a',
    fallbackProviderIds: ['old'],
  });
  const typeDefinition: ProviderType = {
    id: 'openai_template',
    name: 'OpenAI API',
    isAi: true,
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'appId', label: 'APPID', type: 'password', required: true },
      { key: 'apiSecret', label: 'Secret', type: 'password', required: true },
      { key: 'apiUrl', label: 'URL', type: 'url', required: true },
    ],
  };
  const clone = cloneProviderForFallback(
    source,
    typeDefinition,
    () => 'backup',
  );
  assert(clone.id === 'backup', 'clone should use generated id');
  assert(clone.apiKey === '', 'api key should be cleared');
  assert(clone.appId === '', 'appid should be cleared');
  assert(clone.apiSecret === '', 'api secret should be cleared');
  assert(clone.apiUrl === source.apiUrl, 'endpoint should be copied');
  assert(
    clone.fallbackProviderIds === undefined,
    'fallback chain should not be copied',
  );
}

export async function runProviderFallbackTests() {
  await testRunnerSwitchesAndSticks();
  await testRunnerDoesNotSwitchForBadRequest();
  await testConcurrentFailuresNotifyOnce();
  await testExhaustionPreservesLastError();
  await testFallbackReasonIsSanitized();
  testErrorClassifier();
  testCloneClearsCredentials();
  testFallbackConfigNormalization();
  testMigrationPreservesProviderInstances();
  await testDraftFallbackIsSkipped();
  testLocalizedInstanceNames();
  testFallbackBrowsing();
  testParameterCompatibilityUsesType();
  console.log('provider fallback tests passed');
}

if (require.main === module) {
  runProviderFallbackTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
