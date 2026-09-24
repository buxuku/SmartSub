/**
 * 摘要服务商解析单测。由 test-summary.ts 调用，计数写进 summaryTestHarness。
 */
import fs from 'fs';
import path from 'path';
import type { Provider } from '../types/provider';
import {
  FOLLOW_TRANSLATION_PROVIDER,
  type SummaryErrorCode,
} from '../types/summaryPrompt';
import { isProviderConfigured } from '../types/providerUtils';
import {
  pickSummaryProvider,
  shouldReuseTranslationProvider,
  type SummaryProviderResolution,
} from '../main/helpers/episodeSummaryCore';
import { equal } from './summaryTestHarness';

function openaiProvider(fields: Record<string, string>): Provider {
  return {
    id: 'custom-1',
    name: 'custom',
    type: 'openai',
    isAi: true,
    ...fields,
  };
}

function testIsProviderConfigured(): void {
  equal(
    isProviderConfigured(undefined),
    false,
    'missing provider is not configured',
  );
  equal(
    isProviderConfigured(
      openaiProvider({
        apiUrl: 'https://api.example/v1',
        apiKey: '',
        modelName: 'm',
      }),
    ),
    false,
    'empty required field is not configured',
  );
  equal(
    isProviderConfigured(
      openaiProvider({
        apiUrl: 'https://api.example/v1',
        apiKey: '   ',
        modelName: 'm',
      }),
    ),
    false,
    'whitespace required field is not configured',
  );
}

function testIsProviderConfiguredWhenComplete(): void {
  equal(
    isProviderConfigured(
      openaiProvider({
        apiUrl: 'https://api.example/v1',
        apiKey: 'sk-test',
        modelName: 'm',
      }),
    ),
    true,
    'all required fields filled is configured',
  );
  equal(
    isProviderConfigured({
      id: 'local-1',
      name: 'local',
      type: 'not-a-template',
      isAi: true,
    }),
    true,
    'type with no template is configured',
  );
}

function configuredAi(id: string): Provider {
  return openaiProvider({
    apiUrl: 'https://api.example/v1',
    apiKey: 'sk-test',
    modelName: 'm',
    id,
  });
}

function machineProvider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'baidu',
    isAi: false,
    apiKey: '',
    apiSecret: '',
  };
}

function expectPick(
  formData: Record<string, unknown>,
  providers: Provider[],
  expected: SummaryProviderResolution,
  name: string,
): void {
  equal(pickSummaryProvider(formData, providers), expected, name);
}

function testFollowSummaryProvider(): void {
  const ready = configuredAi('translate-1');
  expectPick(
    {
      summaryProvider: FOLLOW_TRANSLATION_PROVIDER,
      translateProvider: 'missing',
    },
    [ready],
    { provider: null, source: 'follow', reason: 'provider-unresolved' },
    'follow: missing translation provider is unresolved',
  );
  expectPick(
    { summaryProvider: FOLLOW_TRANSLATION_PROVIDER, translateProvider: 'mt' },
    [machineProvider('mt')],
    { provider: null, source: 'follow', reason: 'provider-not-ai' },
    'follow: non-AI provider is rejected before the config check',
  );
  expectPick(
    {
      summaryProvider: FOLLOW_TRANSLATION_PROVIDER,
      translateProvider: 'custom-1',
    },
    [
      openaiProvider({
        apiUrl: 'https://api.example/v1',
        apiKey: '   ',
        modelName: 'm',
      }),
    ],
    { provider: null, source: 'follow', reason: 'provider-unconfigured' },
    'follow: whitespace required field is unconfigured',
  );
  expectPick(
    { translateProvider: 'translate-1' },
    [ready],
    { provider: ready, source: 'follow' },
    'follow: omitted summary provider uses the configured translation provider',
  );
}

function testExplicitSummaryProvider(): void {
  const ready = configuredAi('summary-1');
  expectPick(
    { summaryProvider: 'gone' },
    [ready],
    { provider: null, source: 'explicit', reason: 'provider-unresolved' },
    'explicit: missing provider is unresolved',
  );
  expectPick(
    { summaryProvider: 'mt' },
    [machineProvider('mt')],
    { provider: null, source: 'explicit', reason: 'provider-not-ai' },
    'explicit: non-AI provider is rejected before the config check',
  );
  expectPick(
    { summaryProvider: 'custom-1' },
    [
      openaiProvider({
        apiUrl: 'https://api.example/v1',
        apiKey: '',
        modelName: 'm',
      }),
    ],
    { provider: null, source: 'explicit', reason: 'provider-unconfigured' },
    'explicit: empty required field is unconfigured',
  );
  expectPick(
    { summaryProvider: 'summary-1' },
    [ready],
    { provider: ready, source: 'explicit' },
    'explicit: configured AI provider is used',
  );
}

function localeSummaryError(locale: string, code: string): string | undefined {
  const file = path.join(
    process.cwd(),
    'renderer/public/locales',
    locale,
    'tasks.json',
  );
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    summarize?: { error?: Record<string, string> };
  };
  return data.summarize?.error?.[code];
}

function summaryErrorCode(code: SummaryErrorCode): SummaryErrorCode {
  return code;
}

function testProviderUnconfiguredCode(): void {
  equal(
    summaryErrorCode('provider-unconfigured'),
    'provider-unconfigured',
    'provider-unconfigured is a summary error code',
  );
}

function testProviderUnconfiguredCopy(): void {
  equal(
    localeSummaryError('zh', 'provider-unconfigured'),
    '摘要服务未完成配置，已跳过',
    'zh provider-unconfigured copy',
  );
  equal(
    localeSummaryError('en', 'provider-unconfigured'),
    'Summary provider is not fully configured; skipped',
    'en provider-unconfigured copy',
  );
}

function testShouldReuseTranslationProvider(): void {
  equal(
    shouldReuseTranslationProvider('summary-1', undefined),
    false,
    'missing translation provider is not reused',
  );
  equal(
    shouldReuseTranslationProvider('summary-1', { id: 'translate-1' }),
    false,
    'different provider is not reused',
  );
  const extended = {
    id: 'summary-1',
    customParameters: { headerParameters: { 'X-Test': '1' } },
  };
  equal(
    shouldReuseTranslationProvider('summary-1', extended),
    true,
    'same id reuses the translation provider that already has custom parameters',
  );
}

export function runSummaryProviderTests(): void {
  testIsProviderConfigured();
  testIsProviderConfiguredWhenComplete();
  testFollowSummaryProvider();
  testExplicitSummaryProvider();
  testProviderUnconfiguredCode();
  testProviderUnconfiguredCopy();
  testShouldReuseTranslationProvider();
}
