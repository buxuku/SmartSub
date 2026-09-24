/**
 * 摘要服务商表单校验单测。由 test-summary.ts 调用，计数写进 summaryTestHarness。
 */
import type { Provider } from '../types/provider';
import { FOLLOW_TRANSLATION_PROVIDER } from '../types/summaryPrompt';
import {
  isUsableSummaryProvider,
  validateSummaryProvider,
} from '../types/summaryProvider';
import { equal } from './summaryTestHarness';

function openaiProvider(id: string, apiKey: string): Provider {
  return {
    id,
    name: 'custom',
    type: 'openai',
    isAi: true,
    apiUrl: 'https://api.example/v1',
    apiKey,
    modelName: 'm',
  };
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

function expectValidate(
  formData: Record<string, unknown> | undefined,
  providers: Provider[],
  expected: null | 'follow' | 'invalid',
  name: string,
): void {
  equal(validateSummaryProvider(formData, providers), expected, name);
}

function testFollowConfigured(): void {
  expectValidate(
    {
      summaryProvider: FOLLOW_TRANSLATION_PROVIDER,
      translateProvider: 'translate-1',
    },
    [openaiProvider('translate-1', 'sk-test')],
    null,
    'follow + configured AI translate provider passes',
  );
}

function testFollowRejected(): void {
  const ready = openaiProvider('translate-1', 'sk-test');
  expectValidate(
    { summaryProvider: FOLLOW_TRANSLATION_PROVIDER, translateProvider: 'mt' },
    [machineProvider('mt')],
    'follow',
    'follow + non-AI translate provider is follow',
  );
  expectValidate(
    {
      summaryProvider: FOLLOW_TRANSLATION_PROVIDER,
      translateProvider: 'custom-1',
    },
    [openaiProvider('custom-1', '')],
    'follow',
    'follow + unconfigured translate provider is follow',
  );
  expectValidate(
    {
      summaryProvider: FOLLOW_TRANSLATION_PROVIDER,
      translateProvider: 'missing',
    },
    [ready],
    'follow',
    'follow + missing translate provider is follow',
  );
  expectValidate(
    { summaryProvider: FOLLOW_TRANSLATION_PROVIDER, translateProvider: '-1' },
    [ready],
    'follow',
    'follow + translate provider -1 is follow',
  );
}

function testExplicit(): void {
  expectValidate(
    { summaryProvider: 'summary-1' },
    [openaiProvider('summary-1', 'sk-test')],
    null,
    'explicit configured AI provider passes',
  );
  expectValidate(
    { summaryProvider: 'gone' },
    [openaiProvider('summary-1', 'sk-test')],
    'invalid',
    'explicit missing provider is invalid',
  );
  expectValidate(
    { summaryProvider: 'mt' },
    [machineProvider('mt')],
    'invalid',
    'explicit non-AI provider is invalid',
  );
  expectValidate(
    { summaryProvider: 'custom-1' },
    [openaiProvider('custom-1', '   ')],
    'invalid',
    'explicit unconfigured provider is invalid',
  );
}

function testUndefinedSummaryProvider(): void {
  expectValidate(
    { summaryProvider: undefined, translateProvider: 'mt' },
    [machineProvider('mt')],
    'follow',
    'undefined summaryProvider behaves as follow',
  );
  expectValidate(
    { translateProvider: 'translate-1' },
    [openaiProvider('translate-1', 'sk-test')],
    null,
    'omitted summaryProvider follows a configured AI translate provider',
  );
}

function testIsUsableSummaryProvider(): void {
  equal(
    isUsableSummaryProvider(openaiProvider('ai', 'sk-test')),
    true,
    'configured AI provider is usable',
  );
  equal(
    isUsableSummaryProvider(machineProvider('mt')),
    false,
    'non-AI provider is not usable',
  );
  equal(
    isUsableSummaryProvider(openaiProvider('ai', '')),
    false,
    'unconfigured AI provider is not usable',
  );
  equal(
    isUsableSummaryProvider(undefined),
    false,
    'missing provider is not usable',
  );
}

export function runSummaryValidateTests(): void {
  testFollowConfigured();
  testFollowRejected();
  testExplicit();
  testUndefinedSummaryProvider();
  testIsUsableSummaryProvider();
}
