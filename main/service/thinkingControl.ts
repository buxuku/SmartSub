/**
 * AI 翻译思考模式控制（openspec: ai-thinking-mode-control）。
 *
 * 字幕翻译场景思考几乎零收益高成本，provider 的 enableThinking 开关默认关闭
 * （= 主动禁用思考）。本模块是所有思考控制逻辑的单点：
 *
 * - L1 resolveThinkingParams：服务商感知参数映射（design D2），未知服务商不发参数（零 400 风险）；
 * - 拒绝降级 isThinkingParamRejectedError + 会话级拒绝缓存（design D4）：
 *   参数被服务端拒绝时去参重试一次，并缓存 provider+model 避免逐批次重复失败；
 * - L2 appendNoThinkSoftSwitch：参数路径不可用且型号为 qwen3 混合系列时，
 *   提示词追加 /no_think 官方软开关（design D5）；
 * - L3（不在本模块）：aiResponseParser 的 <think> 正则剥离保持兜底。
 *
 * 纯思考模型检测的模式常量放在 types/provider.ts（isThinkingOnlyModelName），
 * 主进程与渲染层 UI 提示共用单一来源，此处 re-export 供服务层使用。
 */

import { isThinkingOnlyModelName } from '../../types/provider';
import type { TranslationResponseMeta } from '../translate/types';

export { isThinkingOnlyModelName };
export type { TranslationResponseMeta };

export interface ThinkingControlProvider {
  id?: string;
  type?: string;
  providerType?: string;
  apiUrl?: string;
  modelName?: string;
  enableThinking?: boolean;
}

// ============================================================
// 会话级拒绝缓存（design D4）
// ============================================================

/** 主进程存活期内有效；命中则 L1 直接跳过发参，避免每个批次都吃一次 400 往返 */
const rejectedParamCache = new Set<string>();

function cacheIdPart(provider: ThinkingControlProvider): string {
  return provider.id || provider.apiUrl || 'unknown';
}

function cacheKey(provider: ThinkingControlProvider): string {
  return `${cacheIdPart(provider)}:${provider.modelName || ''}`;
}

export function markThinkingParamRejected(
  provider: ThinkingControlProvider,
): void {
  rejectedParamCache.add(cacheKey(provider));
}

export function hasThinkingParamRejection(
  provider: ThinkingControlProvider,
): boolean {
  return rejectedParamCache.has(cacheKey(provider));
}

/**
 * 清除某服务商的拒绝缓存（测试面板用，保证「测试」永远是新鲜探测——
 * 用户可能已升级后端）。按 id 前缀清除以覆盖 azure 等 model 键不一致的场景。
 */
export function clearThinkingParamRejection(
  provider: ThinkingControlProvider,
): void {
  const prefix = `${cacheIdPart(provider)}:`;
  for (const key of Array.from(rejectedParamCache)) {
    if (key.startsWith(prefix)) rejectedParamCache.delete(key);
  }
}

// ============================================================
// L1：服务商感知参数映射（design D2）
// ============================================================

function matchesUrl(provider: ThinkingControlProvider, needle: string) {
  return provider.apiUrl?.toLowerCase().includes(needle) ?? false;
}

/** o1/o3/o4 系推理模型（避免误伤 gpt-4o 等含 "o" 型号，锚定开头） */
const O_SERIES_MODEL_REGEX = /^o[134]([.:-]|$)/;

/** GPT-5.6 系列不支持旧 GPT-5 的 minimal 档位，关闭思考应使用 none。 */
const GPT_5_6_MODEL_REGEX = /^gpt-5\.6([.:-]|$)/;

/** 已知不接受 reasoning_effort:none 的 Gemini OpenAI-compatible 型号。 */
const GEMINI_NONE_UNSUPPORTED_MODEL_REGEX =
  /^gemini-(?:3\.5-flash-lite|3\.6-flash(?:-lite)?)([.:-]|$)/;

/**
 * 解析应注入请求体的思考关闭参数。
 * 返回 undefined 表示不干预：开关为开、纯思考模型、已缓存拒绝、或未命中映射
 * （deepseek 靠选模型控制思考、DeerAPI 等聚合商与未知自定义服务商不发参数）。
 */
export function resolveThinkingParams(
  provider: ThinkingControlProvider,
): Record<string, any> | undefined {
  if (provider.enableThinking === true) return undefined;
  if (isThinkingOnlyModelName(provider.modelName)) return undefined;
  if (hasThinkingParamRejection(provider)) return undefined;

  const id = provider.id || '';
  const type = provider.type || provider.providerType || '';
  const model = (provider.modelName || '').toLowerCase();

  if (id === 'qwen' || matchesUrl(provider, 'dashscope.aliyuncs.com')) {
    return { enable_thinking: false };
  }
  if (id === 'siliconflow' || matchesUrl(provider, 'siliconflow')) {
    return { enable_thinking: false };
  }
  if (
    matchesUrl(provider, 'volces.com') ||
    matchesUrl(provider, 'volcengine')
  ) {
    return { thinking: { type: 'disabled' } };
  }
  if (id === 'ollama' || type === 'ollama') {
    return { think: false };
  }
  const isGemini =
    id === 'Gemini' ||
    type === 'gemini' ||
    matchesUrl(provider, 'generativelanguage.googleapis.com');
  if (isGemini) {
    // 这些型号关闭思考时不发参数：none 会被端点拒绝，low 又不等价于关闭。
    if (GEMINI_NONE_UNSUPPORTED_MODEL_REGEX.test(model)) return undefined;
    return { reasoning_effort: 'none' };
  }
  // deepseek 官方无思考参数：deepseek-chat 不思考 / deepseek-reasoner 必思考，
  // 「关闭思考」由 UI 引导换模型（design D6）
  if (id === 'deepseek' || matchesUrl(provider, 'api.deepseek.com')) {
    return undefined;
  }
  // 型号嗅探（OpenAI 官方/Azure 部署/聚合商透传均适用，design D9）
  if (GPT_5_6_MODEL_REGEX.test(model)) {
    return { reasoning_effort: 'none' };
  }
  if (model.startsWith('gpt-5')) {
    return { reasoning_effort: 'minimal' };
  }
  if (O_SERIES_MODEL_REGEX.test(model)) {
    return { reasoning_effort: 'low' };
  }

  return undefined;
}

// ============================================================
// 拒绝错误判定（design D4，镜像 isStructuredOutputUnsupportedError）
// ============================================================

function stringifyErrorPart(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getErrorMessage(error: any): string {
  // 同时收集 SDK / axios / 数组响应体，避免第三方兼容端点的真实错误被
  // "400 status code (no body)" 覆盖。
  return [
    error?.response?.data,
    error?.body,
    error?.error,
    error?.message,
    error,
  ]
    .map(stringifyErrorPart)
    .filter(Boolean)
    .join(' ');
}

function getErrorStatus(error: any): number | undefined {
  const status = Number(
    error?.status ?? error?.response?.status ?? error?.response?.statusCode,
  );
  return Number.isFinite(status) ? status : undefined;
}

/**
 * 判断错误是否为「服务端拒绝思考控制参数」：
 * 消息需同时命中参数主题词与拒绝类关键词，鉴权/网络错误不会误判。
 * 覆盖 OpenAI 「Unrecognized request argument」与旧版 Ollama
 * 「json: unknown field "think"」等形态。
 */
export function isThinkingParamRejectedError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const mentionsThinkingParam =
    message.includes('think') || // think / thinking / enable_thinking
    message.includes('reasoning_effort') ||
    message.includes('reasoning.effort') ||
    // Gemini 2.5 Pro 拒绝 reasoning_effort:'none' 的报错形态
    // （"Budget 0 is invalid for this model"）不含 think 字样
    message.includes('budget');

  if (!mentionsThinkingParam) return false;

  return [
    'unsupported',
    'not support',
    'unrecognized',
    'unknown',
    'invalid',
    'not allowed',
    'unexpected',
    'extra_forbidden',
    // dashscope 纯思考新型号未被模式预判时的报错形态：
    // "parameter.enable_thinking must be set to true for model ..."
    'must be set to true',
    '不支持',
    '无效',
    '未知',
    '不允许',
  ].some((keyword) => message.includes(keyword));
}

/**
 * 自动思考参数是否值得去参重试。
 *
 * 除明确的参数拒绝外，仅兼容 400/422 下两类常见不透明错误。认证、限流、
 * 网络及服务端错误不会触发，避免把真正故障伪装成能力探测。
 */
export function shouldRetryWithoutAutomaticThinkingParams(
  error: unknown,
): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  if (isThinkingParamRejectedError(error)) return true;

  if (status !== 400 && status !== 422) return false;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('status code (no body)') ||
    message.includes('request contains an invalid argument')
  );
}

function hasExplicitThinkingParamOverride(
  automaticParams: Record<string, any>,
  explicitBodyParams?: Record<string, unknown>,
): boolean {
  if (!explicitBodyParams) return false;
  const explicitKeys = new Set(Object.keys(explicitBodyParams));
  return Object.keys(automaticParams).some((key) => {
    if (explicitKeys.has(key)) return true;
    // 参数编辑器中的通用 thinking 会按 provider 转成以下两种格式。
    return key === 'enable_thinking' && explicitKeys.has('thinking');
  });
}

export interface ThinkingParamFallbackOptions<T> {
  provider: ThinkingControlProvider;
  /** 用户显式配置的请求体参数；命中自动参数时禁止应用自行去参。 */
  explicitBodyParams?: Record<string, unknown>;
  signal?: AbortSignal;
  attempt: () => Promise<T>;
  onFallback?: (error: unknown) => void;
}

/**
 * 同一请求模式内执行一次受控能力降级：自动参数失败后去参重试一次并缓存。
 * 第二次失败直接透传，不循环，也不修改用户显式配置。
 */
export async function runWithThinkingParamFallback<T>(
  options: ThinkingParamFallbackOptions<T>,
): Promise<T> {
  const { provider, explicitBodyParams, signal, attempt, onFallback } = options;
  const automaticParams = resolveThinkingParams(provider);
  const canRemoveAutomaticParams =
    automaticParams !== undefined &&
    !hasExplicitThinkingParamOverride(automaticParams, explicitBodyParams);

  try {
    return await attempt();
  } catch (error) {
    const rejectionWasExplicit = isThinkingParamRejectedError(error);
    if (
      !canRemoveAutomaticParams ||
      signal?.aborted ||
      !shouldRetryWithoutAutomaticThinkingParams(error)
    ) {
      throw error;
    }

    markThinkingParamRejected(provider);
    onFallback?.(error);
    try {
      return await attempt();
    } catch (retryError) {
      // 不透明 400/422 可能来自别的参数；只有去参后成功才能确认能力不兼容。
      // 明确的参数拒绝已经是充分证据，即使第二次暴露出另一个请求错误也保留缓存。
      if (!rejectionWasExplicit) rejectedParamCache.delete(cacheKey(provider));
      throw retryError;
    }
  }
}

// ============================================================
// L2：提示词软开关（design D5）
// ============================================================

const NO_THINK_SWITCH = '/no_think';

/**
 * L1 参数路径不可用（未命中映射或已缓存拒绝）且型号为 qwen3 混合系列时，
 * 向 system prompt 末尾追加 /no_think（Qwen3 官方软开关，其他模型不注入）。
 */
export function appendNoThinkSoftSwitch(
  systemPrompt: string,
  provider: ThinkingControlProvider,
): string {
  if (provider.enableThinking === true) return systemPrompt;
  if (!/qwen3/i.test(provider.modelName || '')) return systemPrompt;
  // 纯思考型号（qwen3-*-thinking-*）会忽略软开关，不注入无意义文本
  if (isThinkingOnlyModelName(provider.modelName)) return systemPrompt;
  if (resolveThinkingParams(provider) !== undefined) return systemPrompt;
  if (systemPrompt.includes(NO_THINK_SWITCH)) return systemPrompt;
  return `${systemPrompt}\n${NO_THINK_SWITCH}`;
}

// ============================================================
// 响应元数据提取（design D7）
// ============================================================

/** 从 OpenAI 兼容响应提取思考元数据，openai/azureOpenai 共用 */
export function extractOpenAIResponseMeta(
  completion: any,
): TranslationResponseMeta {
  const message = completion?.choices?.[0]?.message;
  const reasoningContent = message?.reasoning_content;
  const content = typeof message?.content === 'string' ? message.content : '';
  return {
    reasoningContentPresent:
      typeof reasoningContent === 'string' && reasoningContent.trim() !== '',
    reasoningTokens:
      completion?.usage?.completion_tokens_details?.reasoning_tokens || 0,
    completionTokens: completion?.usage?.completion_tokens || 0,
    contentThinkTagPresent: /<think>/i.test(content),
  };
}
