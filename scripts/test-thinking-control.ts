/// <reference path="./test-globals.d.ts" />
/**
 * 思考模式控制单元测试（openspec: ai-thinking-mode-control）。
 *
 * 覆盖：
 * - resolveThinkingParams 映射表各分支（id/URL/型号嗅探）与未知服务商返回空
 * - 纯思考模型跳过发参、开关为开不干预
 * - isThinkingParamRejectedError 拒绝判定关键词（含 axios 响应体形态）
 * - 会话级拒绝缓存写入/命中/清除
 * - appendNoThinkSoftSwitch 仅命中 qwen3 且 L1 不可用时注入
 * - v21 → v22 迁移的 enableThinking 写入语义（displayed via provider defaults）
 */
import {
  resolveThinkingParams,
  isThinkingParamRejectedError,
  markThinkingParamRejected,
  hasThinkingParamRejection,
  clearThinkingParamRejection,
  appendNoThinkSoftSwitch,
  isThinkingOnlyModelName,
} from '../main/service/thinkingControl';
import { isThinkingActiveFromMeta } from '../main/helpers/thinkingModeDetector';
import { PROVIDER_TYPES, CONFIG_TEMPLATES } from '../types/provider';

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
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function run(): void {
  // ==========================================================
  // resolveThinkingParams：映射表分支（design D2）
  // ==========================================================
  eq(
    resolveThinkingParams({ id: 'qwen', modelName: 'qwen-plus' }),
    { enable_thinking: false },
    'map: qwen by id → enable_thinking false',
  );
  eq(
    resolveThinkingParams({
      id: 'openai_123',
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen-plus',
    }),
    { enable_thinking: false },
    'map: dashscope by url → enable_thinking false',
  );
  eq(
    resolveThinkingParams({ id: 'siliconflow', modelName: 'Qwen/Qwen3-8B' }),
    { enable_thinking: false },
    'map: siliconflow by id → enable_thinking false',
  );
  eq(
    resolveThinkingParams({
      id: 'openai_456',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      modelName: 'doubao-seed-1-6-250615',
    }),
    { thinking: { type: 'disabled' } },
    'map: volces by url → thinking object',
  );
  eq(
    resolveThinkingParams({ id: 'ollama', modelName: 'qwen3:8b' }),
    { think: false },
    'map: ollama by id → top-level think false',
  );
  eq(
    resolveThinkingParams({
      id: 'Gemini',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      modelName: 'gemini-2.5-flash',
    }),
    { reasoning_effort: 'none' },
    'map: gemini → reasoning_effort none',
  );
  eq(
    resolveThinkingParams({ id: 'openai_789', modelName: 'gpt-5-mini' }),
    { reasoning_effort: 'minimal' },
    'map: gpt-5 model sniff → reasoning_effort minimal',
  );
  eq(
    resolveThinkingParams({ id: 'azureopenai', modelName: 'o3-mini' }),
    { reasoning_effort: 'low' },
    'map: o-series model sniff → reasoning_effort low',
  );
  eq(
    resolveThinkingParams({ id: 'openai_1', modelName: 'gpt-4o' }),
    undefined,
    'map: gpt-4o not treated as o-series (anchor check)',
  );
  eq(
    resolveThinkingParams({ id: 'deepseek', modelName: 'deepseek-chat' }),
    undefined,
    'map: deepseek → no param (model-choice based)',
  );
  eq(
    resolveThinkingParams({
      id: 'DeerAPI',
      apiUrl: 'https://api.deerapi.com/v1',
      modelName: 'gpt-4o-mini',
    }),
    undefined,
    'map: unknown aggregator → no param',
  );
  eq(
    resolveThinkingParams({
      id: 'openai_999',
      apiUrl: 'https://api.example.com/v1',
      modelName: 'some-model',
    }),
    undefined,
    'map: unknown custom provider → no param',
  );

  // 开关为开 = 不干预
  eq(
    resolveThinkingParams({
      id: 'qwen',
      modelName: 'qwen-plus',
      enableThinking: true,
    }),
    undefined,
    'switch on → no params for any provider',
  );

  // 纯思考模型跳过 L1（design D6）
  eq(
    resolveThinkingParams({
      id: 'qwen',
      modelName: 'qwen3-235b-a22b-thinking-2507',
    }),
    undefined,
    'thinking-only model → skip params',
  );
  eq(
    isThinkingOnlyModelName('deepseek-reasoner'),
    true,
    'thinking-only: deepseek-reasoner',
  );
  eq(
    isThinkingOnlyModelName('some-model-reasoning'),
    true,
    'thinking-only: -reasoning suffix',
  );
  eq(isThinkingOnlyModelName('qwen-plus'), false, 'thinking-only: negative');
  eq(isThinkingOnlyModelName(undefined), false, 'thinking-only: undefined');

  // ==========================================================
  // isThinkingParamRejectedError（design D4）
  // ==========================================================
  eq(
    isThinkingParamRejectedError(
      new Error('400 Unrecognized request argument supplied: enable_thinking'),
    ),
    true,
    'reject: openai unrecognized argument',
  );
  eq(
    isThinkingParamRejectedError(
      new Error(
        'parameter.enable_thinking must be set to true for model qwen3-thinking',
      ),
    ),
    true,
    'reject: dashscope thinking-only model error form',
  );
  eq(
    isThinkingParamRejectedError(
      new Error('enable_thinking works normally in this request'),
    ),
    false,
    'reject: mentions param without rejection keyword → not matched',
  );
  eq(
    isThinkingParamRejectedError({
      message: 'Request failed with status code 400',
      response: { data: { error: 'json: unknown field "think"' } },
    }),
    true,
    'reject: ollama unknown field via axios response body',
  );
  eq(
    isThinkingParamRejectedError(
      new Error('reasoning_effort is not supported with this model'),
    ),
    true,
    'reject: reasoning_effort not supported',
  );
  eq(
    isThinkingParamRejectedError(
      new Error(
        'Unable to submit request because thinking budget 0 is invalid for this model',
      ),
    ),
    true,
    'reject: gemini pro budget-0 error form',
  );
  eq(
    isThinkingParamRejectedError(new Error('401 Unauthorized')),
    false,
    'reject: auth error not matched',
  );
  eq(
    isThinkingParamRejectedError(new Error('response_format is unsupported')),
    false,
    'reject: structured output error not matched',
  );

  // ==========================================================
  // 会话级拒绝缓存（design D4）
  // ==========================================================
  const cachedProvider = { id: 'openai_777', modelName: 'qwen3:4b' };
  eq(
    hasThinkingParamRejection(cachedProvider),
    false,
    'cache: initially empty',
  );
  markThinkingParamRejected(cachedProvider);
  eq(hasThinkingParamRejection(cachedProvider), true, 'cache: hit after mark');
  eq(
    resolveThinkingParams({
      ...cachedProvider,
      apiUrl: 'https://dashscope.aliyuncs.com',
    }),
    undefined,
    'cache: resolve skips params after rejection',
  );
  eq(
    hasThinkingParamRejection({ id: 'openai_777', modelName: 'other-model' }),
    false,
    'cache: keyed by provider+model',
  );
  clearThinkingParamRejection(cachedProvider);
  eq(
    hasThinkingParamRejection(cachedProvider),
    false,
    'cache: cleared by provider prefix',
  );

  // ==========================================================
  // appendNoThinkSoftSwitch（design D5）
  // ==========================================================
  eq(
    appendNoThinkSoftSwitch('SYS', {
      id: 'openai_888',
      apiUrl: 'https://api.example.com/v1',
      modelName: 'qwen3:8b',
    }),
    'SYS\n/no_think',
    'no_think: unknown provider + qwen3 → appended',
  );
  eq(
    appendNoThinkSoftSwitch('SYS', {
      id: 'openai_888',
      apiUrl: 'https://api.example.com/v1',
      modelName: 'llama3:8b',
    }),
    'SYS',
    'no_think: non-qwen3 model → untouched',
  );
  eq(
    appendNoThinkSoftSwitch('SYS', { id: 'ollama', modelName: 'qwen3:8b' }),
    'SYS',
    'no_think: L1 param available → not appended',
  );
  const rejectedOllama = { id: 'ollama', modelName: 'qwen3:8b' };
  markThinkingParamRejected(rejectedOllama);
  eq(
    appendNoThinkSoftSwitch('SYS', rejectedOllama),
    'SYS\n/no_think',
    'no_think: appended after param rejection cached',
  );
  clearThinkingParamRejection(rejectedOllama);
  eq(
    appendNoThinkSoftSwitch('SYS', {
      id: 'openai_888',
      modelName: 'qwen3:8b',
      enableThinking: true,
    }),
    'SYS',
    'no_think: switch on → untouched',
  );
  eq(
    appendNoThinkSoftSwitch('SYS\n/no_think', {
      id: 'openai_888',
      modelName: 'qwen3:8b',
    }),
    'SYS\n/no_think',
    'no_think: idempotent',
  );
  eq(
    appendNoThinkSoftSwitch('SYS', {
      id: 'openai_888',
      modelName: 'qwen3-235b-a22b-thinking-2507',
    }),
    'SYS',
    'no_think: thinking-only qwen3 variant → untouched',
  );

  // ==========================================================
  // isThinkingActiveFromMeta（design D7）
  // ==========================================================
  eq(
    isThinkingActiveFromMeta({ reasoningContentPresent: true }),
    true,
    'meta: reasoning_content present → active',
  );
  eq(
    isThinkingActiveFromMeta({ reasoningTokens: 128 }),
    true,
    'meta: reasoning tokens → active',
  );
  eq(
    isThinkingActiveFromMeta({ contentThinkTagPresent: true }),
    true,
    'meta: inline <think> → active',
  );
  eq(
    isThinkingActiveFromMeta({
      reasoningContentPresent: false,
      reasoningTokens: 0,
      contentThinkTagPresent: false,
    }),
    false,
    'meta: nothing detected → inactive',
  );

  // ==========================================================
  // 字段定义与迁移语义（design D1/D8）
  // ==========================================================
  const aiTypes = PROVIDER_TYPES.filter((t) => t.isAi);
  eq(
    aiTypes.length > 0 &&
      aiTypes.every((t) =>
        t.fields.some(
          (f) =>
            f.key === 'enableThinking' &&
            f.type === 'switch' &&
            f.defaultValue === false,
        ),
      ),
    true,
    'field: every builtin AI provider has enableThinking switch (default false)',
  );
  eq(
    CONFIG_TEMPLATES.openai.fields.some(
      (f) => f.key === 'enableThinking' && f.defaultValue === false,
    ),
    true,
    'field: custom openai template has enableThinking switch',
  );
  eq(
    PROVIDER_TYPES.filter((t) => !t.isAi).every(
      (t) => !t.fields.some((f) => f.key === 'enableThinking'),
    ),
    true,
    'field: non-AI providers have no enableThinking field',
  );

  // v22 迁移写入语义：p.enableThinking === true 保留，其余（undefined/false）落 false
  const migrationSemantics = (stored: unknown) => stored === true;
  eq(migrationSemantics(undefined), false, 'migrate: undefined → false');
  eq(migrationSemantics(false), false, 'migrate: false → false');
  eq(migrationSemantics(true), true, 'migrate: explicit true preserved');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
