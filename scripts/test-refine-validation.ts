/// <reference path="./test-globals.d.ts" />
/**
 * AI 字幕精修前置校验纯逻辑单元测试（无 Electron / 无网络）。
 *
 * 覆盖 renderer/lib/subtitleRefineValidation.ts:
 *  - 场景 1：未开启 AI 精修（aiSegmentation/aiCorrection 均关）
 *  - 场景 2：跟随翻译 - 翻译未开启（translateOn = false）
 *  - 场景 3：跟随翻译 - 翻译服务商不存在
 *  - 场景 4：跟随翻译 - 翻译服务商非 AI 类型（如谷歌翻译）
 *  - 场景 5：跟随翻译 - 翻译服务商为 AI 类型但未配置密钥
 *  - 场景 6：跟随翻译 - 翻译服务商为 AI 类型且已配置完整
 *  - 场景 7：显式指定 - 服务商不存在（已删除）
 *  - 场景 8：显式指定 - 服务商存在但非 AI 类型
 *  - 场景 9：显式指定 - 服务商为 AI 类型但未配置密钥
 *  - 场景 10：显式指定 - 服务商为 AI 类型且已配置完整
 *  - 场景 11：错误文案多语言拼接测试（点名功能与服务商）
 *
 * 运行：tsc scripts/test-refine-validation.ts ... && node ...
 */
import {
  validateRefineProviderConfig,
  getRefineValidationErrorMessage,
} from '../renderer/lib/subtitleRefineValidation';
import type { Provider } from '../types/provider';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond: boolean, name: string): void {
  eq(!!cond, true, name);
}

// 模拟测试服务商池
const mockGoogle: Provider = {
  id: 'google',
  name: 'Google Translate',
  type: 'google',
  isAi: false,
};

const mockUnconfiguredDeepseek: Provider = {
  id: 'deepseek-empty',
  name: 'DeepSeek',
  type: 'deepseek',
  isAi: true,
  apiKey: '', // 未配置
};

const mockConfiguredDeepseek: Provider = {
  id: 'deepseek-ready',
  name: 'DeepSeek',
  type: 'deepseek',
  isAi: true,
  apiUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test123456',
  modelName: 'deepseek-chat',
};

const mockConfiguredQwen: Provider = {
  id: 'qwen-ready',
  name: 'Qwen',
  type: 'qwen',
  isAi: true,
  apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'sk-qwen123456',
  modelName: 'qwen-turbo',
};

const testProviders = [
  mockGoogle,
  mockUnconfiguredDeepseek,
  mockConfiguredDeepseek,
  mockConfiguredQwen,
];

// ── 场景 1：未开启精修 ──────────────────────────────────────────
{
  const res = validateRefineProviderConfig({
    formData: { aiSegmentation: false, aiCorrection: false },
    providers: testProviders,
    translateOn: false,
  });
  ok(res.valid, 'scenario 1: valid when refine is off');
  eq(res.isRefineActive, false, 'scenario 1: isRefineActive is false');
  eq(res.feature, null, 'scenario 1: feature is null');
}

// ── 场景 2：跟随翻译 - 翻译未开启 ────────────────────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'follow-translation',
      translateProvider: 'deepseek-ready',
    },
    providers: testProviders,
    translateOn: false,
  });
  ok(!res.valid, 'scenario 2: invalid when translation is off');
  eq(res.reason, 'translation-off', 'scenario 2: reason is translation-off');
  eq(res.feature, 'correction', 'scenario 2: feature is correction');
}

// ── 场景 3：跟随翻译 - 翻译服务商不存在 ──────────────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiSegmentation: true,
      refineProvider: 'follow-translation',
      translateProvider: 'non-existent-provider',
    },
    providers: testProviders,
    translateOn: true,
  });
  ok(!res.valid, 'scenario 3: invalid when translate provider missing');
  eq(res.reason, 'translation-off', 'scenario 3: reason is translation-off');
  eq(res.feature, 'segmentation', 'scenario 3: feature is segmentation');
}

// ── 场景 4：跟随翻译 - 翻译服务商为非 AI 类型（如谷歌） ─────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiSegmentation: true,
      aiCorrection: true,
      refineProvider: 'follow-translation',
      translateProvider: 'google',
    },
    providers: testProviders,
    translateOn: true,
  });
  ok(!res.valid, 'scenario 4: invalid when translate provider is non-AI');
  eq(
    res.reason,
    'translation-needs-ai',
    'scenario 4: reason is translation-needs-ai',
  );
  eq(res.feature, 'both', 'scenario 4: feature is both');
  eq(res.provider?.id, 'google', 'scenario 4: provider is google');
}

// ── 场景 5：跟随翻译 - 翻译服务商为 AI 类型但未配置密钥 ─────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'follow-translation',
      translateProvider: 'deepseek-empty',
    },
    providers: testProviders,
    translateOn: true,
  });
  ok(!res.valid, 'scenario 5: invalid when translate provider unconfigured');
  eq(
    res.reason,
    'translation-unconfigured',
    'scenario 5: reason is translation-unconfigured',
  );
}

// ── 场景 6：跟随翻译 - 翻译服务商为 AI 类型且已配置完整 ─────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'follow-translation',
      translateProvider: 'deepseek-ready',
    },
    providers: testProviders,
    translateOn: true,
  });
  ok(res.valid, 'scenario 6: valid when translate provider is configured AI');
  eq(res.provider?.id, 'deepseek-ready', 'scenario 6: resolved provider id');
  eq(res.isFollow, true, 'scenario 6: isFollow is true');
}

// ── 场景 7：显式指定 - 服务商不存在（已删除） ─────────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'deleted-provider-id',
    },
    providers: testProviders,
    translateOn: false,
  });
  ok(!res.valid, 'scenario 7: invalid when explicit provider missing');
  eq(res.reason, 'provider-invalid', 'scenario 7: reason is provider-invalid');
  eq(res.isFollow, false, 'scenario 7: isFollow is false');
}

// ── 场景 8：显式指定 - 服务商存在但非 AI 类型 ─────────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'google',
    },
    providers: testProviders,
    translateOn: false,
  });
  ok(!res.valid, 'scenario 8: invalid when explicit provider is non-AI');
  eq(
    res.reason,
    'provider-needs-ai',
    'scenario 8: reason is provider-needs-ai',
  );
}

// ── 场景 9：显式指定 - 服务商为 AI 类型但未配置密钥 ─────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiSegmentation: true,
      refineProvider: 'deepseek-empty',
    },
    providers: testProviders,
    translateOn: false,
  });
  ok(!res.valid, 'scenario 9: invalid when explicit provider unconfigured');
  eq(
    res.reason,
    'provider-unconfigured',
    'scenario 9: reason is provider-unconfigured',
  );
}

// ── 场景 10：显式指定 - 服务商为 AI 类型且已配置完整 ────────────────
{
  const res = validateRefineProviderConfig({
    formData: {
      aiSegmentation: true,
      refineProvider: 'qwen-ready',
    },
    providers: testProviders,
    translateOn: false,
  });
  ok(res.valid, 'scenario 10: valid when explicit provider configured AI');
  eq(res.provider?.id, 'qwen-ready', 'scenario 10: resolved provider id');
  eq(res.isFollow, false, 'scenario 10: isFollow is false');
}

// ── 场景 11：错误文案渲染与插值 ──────────────────────────────────
{
  const mockT = (key: string, opts?: any) => {
    if (key === 'wizard.refineFeatureCorrection') return 'AI 文本校正';
    if (key === 'wizard.refineFeatureBoth') return 'AI 语义断句与文本校正';
    if (key === 'wizard.blockRefineFollowNeedsAi') {
      return `已开启「${opts.feature}」，需要大语言模型（LLM）支持，而当前选中的「${opts.provider}」为传统接口无法执行该功能`;
    }
    if (key === 'wizard.blockRefineFollowTranslationOff') {
      return `已开启「${opts.feature}」，但未开启翻译服务（无法跟随），请开启翻译或显式指定精修服务商`;
    }
    return key;
  };
  const mockCommonT = (_key: string, opts?: any) =>
    opts?.defaultValue || opts?.name || '';

  const resNeedsAi = validateRefineProviderConfig({
    formData: {
      aiCorrection: true,
      refineProvider: 'follow-translation',
      translateProvider: 'google',
    },
    providers: testProviders,
    translateOn: true,
  });
  const msgNeedsAi = getRefineValidationErrorMessage(
    resNeedsAi,
    mockT,
    mockCommonT,
  );
  ok(
    msgNeedsAi.includes('AI 文本校正') &&
      msgNeedsAi.includes('Google Translate'),
    'scenario 11: message names feature and provider',
  );

  const resOff = validateRefineProviderConfig({
    formData: {
      aiSegmentation: true,
      aiCorrection: true,
      refineProvider: 'follow-translation',
    },
    providers: testProviders,
    translateOn: false,
  });
  const msgOff = getRefineValidationErrorMessage(resOff, mockT, mockCommonT);
  ok(
    msgOff.includes('AI 语义断句与文本校正') &&
      msgOff.includes('未开启翻译服务'),
    'scenario 11: message names both features and translation off',
  );
}

console.log(`\nrefine validation units: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
