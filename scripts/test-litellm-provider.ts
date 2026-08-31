/// <reference path="./test-globals.d.ts" />
/**
 * LiteLLM provider unit tests.
 *
 * Covers:
 * - litellm is registered as a built-in AI provider in PROVIDER_TYPES with the
 *   expected OpenAI-compatible fields (apiUrl default, apiKey, modelName)
 * - resolveThinkingParams never injects provider-specific thinking params for a
 *   litellm provider (issue #439): the gateway normalizes/drops them, so we let
 *   it handle cross-provider compatibility instead of guessing per model
 * - regression: non-litellm providers keep their existing thinking-param mapping
 */
import { resolveThinkingParams } from '../main/service/thinkingControl';
import { PROVIDER_TYPES } from '../types/provider';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `x ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function run(): void {
  // ==========================================================
  // Registration in PROVIDER_TYPES
  // ==========================================================
  const litellm = PROVIDER_TYPES.find((t) => t.id === 'litellm');
  eq(Boolean(litellm), true, 'registered: litellm exists in PROVIDER_TYPES');
  eq(litellm?.isAi, true, 'registered: litellm is an AI provider');
  eq(litellm?.isBuiltin, true, 'registered: litellm is built-in');

  const apiUrlField = litellm?.fields.find((f) => f.key === 'apiUrl');
  eq(
    apiUrlField?.defaultValue,
    'http://localhost:4000/v1',
    'field: apiUrl defaults to the local LiteLLM proxy',
  );
  eq(
    litellm?.fields.some((f) => f.key === 'apiKey'),
    true,
    'field: litellm has an apiKey field',
  );
  eq(
    litellm?.fields.some((f) => f.key === 'modelName'),
    true,
    'field: litellm has a modelName field',
  );

  // ==========================================================
  // resolveThinkingParams: litellm always routes params through the gateway
  // (issue #439 — never inject reasoning_effort/enable_thinking ourselves)
  // ==========================================================
  eq(
    resolveThinkingParams({ id: 'litellm', modelName: 'gpt-5-mini' }),
    undefined,
    'litellm: gpt-5 model does not get reasoning_effort injected',
  );
  eq(
    resolveThinkingParams({ id: 'litellm', modelName: 'o3-mini' }),
    undefined,
    'litellm: o-series model does not get reasoning_effort injected',
  );
  eq(
    resolveThinkingParams({ type: 'litellm', modelName: 'gemini-2.5-flash' }),
    undefined,
    'litellm: gemini model does not get reasoning_effort:none injected',
  );

  // ==========================================================
  // Regression: non-litellm providers keep their existing mapping
  // ==========================================================
  eq(
    resolveThinkingParams({ id: 'Gemini', modelName: 'gemini-2.5-flash' }),
    { reasoning_effort: 'none' },
    'regression: native Gemini provider still maps to reasoning_effort:none',
  );
  eq(
    resolveThinkingParams({ id: 'openai', modelName: 'gpt-5-mini' }),
    { reasoning_effort: 'minimal' },
    'regression: non-litellm gpt-5 still maps to reasoning_effort:minimal',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
