import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { TranslationResultSchema } from '../translate/constants/schema';
import { ParameterProcessor } from '../helpers/parameterProcessor';
import { ExtendedProvider } from '../../types/provider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';
import {
  isStructuredOutputUnsupportedError,
  resolveStructuredOutputMode,
  runWithStructuredOutputFallback,
  type StructuredOutputMode,
} from './structuredOutputFallback';

type OpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
  useJsonMode?: boolean; // 保留向后兼容
  structuredOutput?: StructuredOutputMode;
  strictStructuredOutput?: boolean;
  providerType?: string;
  id?: string;
};

/**
 * OpenAI 兼容服务的健壮性增强：Base URL 规范化 + 结构化输出失败自动回退
 * （回退链已收敛到 structuredOutputFallback.ts，源自 @nightt5879 的 PR #328）。
 */

/**
 * 规范化 OpenAI 兼容服务的 Base URL：
 * - 去除误粘的 /chat/completions 后缀（SDK 会自动拼接）
 * - 对模型详情页 / 模型端点（/models、/models/xxx）给出可读报错
 */
function normalizeOpenAIBaseURL(apiUrl?: string): string {
  const trimmedUrl = apiUrl?.trim();
  if (!trimmedUrl) {
    throw new Error('OpenAI-compatible API base URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new Error(
      'OpenAI-compatible API base URL must start with http:// or https://',
    );
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(
      'OpenAI-compatible API base URL must start with http:// or https://',
    );
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
  if (/\/models(\/[^/]+)?$/i.test(normalizedPath)) {
    throw new Error(
      'OpenAI-compatible API base URL looks like a model page or model endpoint. Use the provider API base URL, usually ending in /v1, and put the model id in Model Name.',
    );
  }

  if (/\/chat\/completions$/i.test(normalizedPath)) {
    parsedUrl.pathname =
      normalizedPath.replace(/\/chat\/completions$/i, '') || '/';
  } else {
    parsedUrl.pathname = normalizedPath || '/';
  }
  parsedUrl.hash = '';
  parsedUrl.search = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

/**
 * Convert OpenAIProvider to ExtendedProvider for parameter processing
 */
function toExtendedProvider(provider: OpenAIProvider): ExtendedProvider {
  return {
    id: provider.id || 'unknown',
    name: provider.id || 'Unknown Provider',
    type: provider.providerType || 'openai',
    isAi: true,
    apiKey: provider.apiKey,
    apiUrl: provider.apiUrl,
    modelName: provider.modelName,
    // Include any additional properties from the original provider
    ...provider,
  } as ExtendedProvider;
}

/**
 * 获取特定provider的额外参数 (Enhanced with Parameter Processor)
 */
function getProviderSpecificParams(
  provider: OpenAIProvider,
): Record<string, any> {
  // Convert to ExtendedProvider for parameter processing
  const extendedProvider = toExtendedProvider(provider);

  // Base parameters for backward compatibility
  const baseParams: Record<string, any> = {};

  // Original hard-coded logic (maintained for backward compatibility)
  // 通义千问需要禁用thinking模式
  if (
    provider.id === 'qwen' ||
    provider.apiUrl?.includes('dashscope.aliyuncs.com')
  ) {
    baseParams.enable_thinking = false;
  }

  // Process custom parameters if available
  if (extendedProvider.customParameters) {
    console.log('Processing custom parameters for provider:', provider.id);
    const processed = ParameterProcessor.processCustomParameters(
      extendedProvider,
      baseParams,
    );

    // Log parameter processing results
    if (processed.appliedParameters.length > 0) {
      console.log('Applied parameters:', processed.appliedParameters);
    }
    if (processed.skippedParameters.length > 0) {
      console.log('Skipped parameters:', processed.skippedParameters);
    }
    if (processed.validationErrors.length > 0) {
      console.warn('Parameter validation errors:', processed.validationErrors);
    }

    // Return the processed body parameters (headers will be handled separately)
    return processed.body;
  }

  // Fallback to base parameters if no custom parameters
  return baseParams;
}

/**
 * 获取结构化输出配置（未显式配置时按 provider 类型给默认值，保持向后兼容）
 */
function getStructuredOutputMode(
  provider: OpenAIProvider,
): StructuredOutputMode {
  const isGemini =
    provider.providerType === 'gemini' ||
    provider.id === 'Gemini' ||
    provider.apiUrl?.includes('generativelanguage.googleapis.com');
  return resolveStructuredOutputMode(
    provider,
    isGemini ? 'json_schema' : 'json_object',
  );
}

/**
 * 获取自定义HTTP头部参数
 */
function getCustomHeaders(provider: OpenAIProvider): Record<string, string> {
  const extendedProvider = toExtendedProvider(provider);

  if (extendedProvider.customParameters) {
    const processed = ParameterProcessor.processCustomParameters(
      extendedProvider,
      {},
    );

    // Convert header values to strings for HTTP headers
    const headers: Record<string, string> = {};
    Object.entries(processed.headers).forEach(([key, value]) => {
      headers[key] = String(value);
    });

    return headers;
  }

  return {};
}

/**
 * 创建基础请求参数 (Enhanced with Parameter Processor)
 */
function createBaseParams(text: string | string[], provider: OpenAIProvider) {
  const sysPrompt =
    provider.systemPrompt || 'You are a professional subtitle translation tool';
  const userPrompt = Array.isArray(text) ? text.join('\n') : text;

  const baseParams = {
    model: provider.modelName || 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: 0.3,
    stream: false,
    ...getProviderSpecificParams(provider),
  };

  return baseParams;
}

/**
 * 使用JSON Schema方式调用API（支持结构化解析）；失败由共享回退链降级
 */
async function callWithJsonSchema(
  openai: OpenAI,
  baseParams: any,
  options?: TranslationRequestOptions,
): Promise<string | undefined> {
  console.log('Using JSON Schema API with zod schema');
  throwIfSignalCancelled(options?.signal);
  const completion = await openai.beta.chat.completions.parse(
    {
      ...baseParams,
      response_format: zodResponseFormat(
        TranslationResultSchema,
        'translation',
      ),
    },
    { signal: options?.signal },
  );

  console.log('JSON Schema completion:', completion?.choices);
  throwIfSignalCancelled(options?.signal);
  const parsed = completion?.choices?.[0]?.message?.parsed;
  if (parsed && typeof parsed === 'object') {
    return JSON.stringify(parsed);
  }
  return parsed ? String(parsed) : undefined;
}

/**
 * 使用标准OpenAI API（json_object和disabled模式）；失败由共享回退链降级
 */
async function callWithStandardAPI(
  openai: OpenAI,
  baseParams: any,
  structuredOutputMode: StructuredOutputMode,
  options?: TranslationRequestOptions,
): Promise<string | undefined> {
  console.log(
    `Using standard OpenAI-compatible API with mode: ${structuredOutputMode}`,
  );

  const requestParams: any = { ...baseParams };
  if (structuredOutputMode === 'json_object') {
    requestParams.response_format = { type: 'json_object' };
  }

  throwIfSignalCancelled(options?.signal);
  const completion = (await openai.chat.completions.create(requestParams, {
    signal: options?.signal,
  })) as OpenAI.Chat.Completions.ChatCompletion;
  console.log('Standard completion:', completion?.choices);
  throwIfSignalCancelled(options?.signal);
  return completion?.choices?.[0]?.message?.content?.trim();
}

/**
 * 主要的翻译函数 (Enhanced with Parameter Processor)
 */
export async function translateWithOpenAI(
  text: string | string[],
  provider: OpenAIProvider,
  _sourceLanguage?: string,
  _targetLanguage?: string,
  options?: TranslationRequestOptions,
): Promise<string | undefined> {
  if (!provider.apiKey) {
    throw new Error('OpenAI API key is required');
  }
  const normalizedApiUrl = normalizeOpenAIBaseURL(provider.apiUrl);
  console.log('translateWithOpenAI', text, provider);
  try {
    throwIfSignalCancelled(options?.signal);
    console.log('Provider config:', {
      id: provider.id,
      apiUrl: normalizedApiUrl,
      modelName: provider.modelName,
    });

    // Get custom headers for the request
    const customHeaders = getCustomHeaders(provider);

    const openai = new OpenAI({
      baseURL: normalizedApiUrl,
      apiKey: provider.apiKey,
      defaultHeaders: {
        ...customHeaders, // Apply custom headers from parameter processor
      },
    });

    const baseParams = createBaseParams(text, provider);

    // Get detailed parameter processing information
    const extendedProvider = toExtendedProvider(provider);
    const processedParams = extendedProvider.customParameters
      ? ParameterProcessor.processCustomParameters(extendedProvider, {})
      : null;

    console.log('Request params:', {
      model: baseParams.model,
      temperature: baseParams.temperature,
      additionalParams: getProviderSpecificParams(provider),
      customHeaders:
        Object.keys(customHeaders).length > 0 ? customHeaders : 'none',
    });

    // Enhanced logging for custom parameters
    if (processedParams) {
      console.log('Custom parameter processing results:', {
        appliedParameters: processedParams.appliedParameters,
        skippedParameters: processedParams.skippedParameters,
        validationErrors:
          processedParams.validationErrors.length > 0
            ? processedParams.validationErrors
            : 'none',
        finalBodyParams:
          Object.keys(processedParams.body).length > 0
            ? processedParams.body
            : 'none',
      });
    } else {
      console.log('No custom parameters configured for this provider');
    }

    // 根据结构化输出配置选择调用方式，失败时按共享回退链降级：
    // json_schema 任何失败都值得降级重试；json_object 仅在服务明确不支持时降级
    return await runWithStructuredOutputFallback({
      startMode: getStructuredOutputMode(provider),
      strict: provider.strictStructuredOutput === true,
      signal: options?.signal,
      shouldFallback: (from, error) =>
        from === 'json_schema' || isStructuredOutputUnsupportedError(error),
      onFallback: (from, to, error) =>
        console.warn(
          `Structured output ${from} failed, falling back to ${to}:`,
          error,
        ),
      attempt: (mode) =>
        mode === 'json_schema'
          ? callWithJsonSchema(openai, baseParams, options)
          : callWithStandardAPI(openai, baseParams, mode, options),
    });
  } catch (error) {
    if (options?.signal?.aborted) throw new TaskCancelledError();
    console.error('OpenAI translation error:', error);
    throw new Error(
      `OpenAI translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export default translateWithOpenAI;
