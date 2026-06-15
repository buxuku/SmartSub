import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  TRANSLATION_JSON_SCHEMA,
  TranslationResultSchema,
} from '../translate/constants/schema';
import { ParameterProcessor } from '../helpers/parameterProcessor';
import { ExtendedProvider } from '../../types/provider';

type OpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
  useJsonMode?: boolean; // 保留向后兼容
  structuredOutput?: 'disabled' | 'json_object' | 'json_schema';
  providerType?: string;
  id?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

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

function isStructuredOutputUnsupportedError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const mentionsStructuredOutput =
    message.includes('response_format') ||
    message.includes('json_schema') ||
    message.includes('json_object') ||
    message.includes('structured output');

  if (!mentionsStructuredOutput) {
    return false;
  }

  return [
    'unsupported',
    'not support',
    'invalid',
    'unrecognized',
    'unknown',
    'not allowed',
    'extra_forbidden',
    '不支持',
    '无效',
    '未知',
    '不允许',
  ].some((keyword) => message.includes(keyword));
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
 * 获取结构化输出配置
 */
function getStructuredOutputMode(
  provider: OpenAIProvider,
): 'disabled' | 'json_object' | 'json_schema' {
  // 优先使用新的structuredOutput配置
  if (provider.structuredOutput) {
    return provider.structuredOutput;
  }

  // 兼容旧的useJsonMode配置
  if (provider.useJsonMode === false) {
    return 'disabled';
  }

  // 根据provider类型设置默认值，保持向后兼容
  if (
    provider.providerType === 'gemini' ||
    provider.id === 'Gemini' ||
    provider.apiUrl?.includes('generativelanguage.googleapis.com')
  ) {
    return 'json_schema';
  }

  if (provider.id === 'deepseek' || provider.apiUrl?.includes('deepseek.com')) {
    return 'json_object';
  }

  // 默认使用json_object
  return 'json_object';
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
function createBaseParams(text: string[], provider: OpenAIProvider) {
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
 * 使用JSON Schema方式调用API（支持结构化解析）
 */
async function callWithJsonSchema(
  openai: OpenAI,
  baseParams: any,
): Promise<string | undefined> {
  console.log('Using JSON Schema API with zod schema');
  try {
    const completion = await openai.beta.chat.completions.parse({
      ...baseParams,
      response_format: zodResponseFormat(
        TranslationResultSchema,
        'translation',
      ),
    });

    console.log('JSON Schema completion:', completion?.choices);
    const parsed = completion?.choices?.[0]?.message?.parsed;
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed);
    }
    return parsed ? String(parsed) : undefined;
  } catch (parseError) {
    console.warn(
      'JSON Schema parse failed, falling back to json_object API:',
      parseError,
    );
    // 回退到json_object模式
    try {
      const fallbackCompletion = (await openai.chat.completions.create({
        ...baseParams,
        response_format: { type: 'json_object' },
      })) as OpenAI.Chat.Completions.ChatCompletion;
      return fallbackCompletion?.choices?.[0]?.message?.content?.trim();
    } catch (fallbackError) {
      if (isStructuredOutputUnsupportedError(fallbackError)) {
        console.warn(
          'json_object response format failed, retrying without structured output:',
          fallbackError,
        );
        return await callWithStandardAPI(openai, baseParams, 'disabled');
      }
      throw fallbackError;
    }
  }
}

/**
 * 使用标准OpenAI API（支持json_object和disabled模式）
 */
async function callWithStandardAPI(
  openai: OpenAI,
  baseParams: any,
  structuredOutputMode: 'disabled' | 'json_object' | 'json_schema',
): Promise<string | undefined> {
  console.log(
    `Using standard OpenAI-compatible API with mode: ${structuredOutputMode}`,
  );

  const requestParams: any = { ...baseParams };

  // 根据结构化输出模式设置response_format
  if (structuredOutputMode === 'json_object') {
    requestParams.response_format = { type: 'json_object' };
    console.log('Using json_object response format');
  } else if (structuredOutputMode === 'disabled') {
    // 不设置response_format，让模型自由输出
    console.log('Structured output disabled, using free-form response');
  }
  // json_schema模式由callWithJsonSchema函数处理

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = (await openai.chat.completions.create(
      requestParams,
    )) as OpenAI.Chat.Completions.ChatCompletion;
  } catch (error) {
    if (
      structuredOutputMode === 'json_object' &&
      isStructuredOutputUnsupportedError(error)
    ) {
      console.warn(
        'json_object response format failed, retrying without structured output:',
        error,
      );
      completion = (await openai.chat.completions.create(
        baseParams,
      )) as OpenAI.Chat.Completions.ChatCompletion;
    } else {
      throw error;
    }
  }
  console.log('Standard completion:', completion?.choices);
  return completion?.choices?.[0]?.message?.content?.trim();
}

/**
 * 主要的翻译函数 (Enhanced with Parameter Processor)
 */
export async function translateWithOpenAI(
  text: string[],
  provider: OpenAIProvider,
): Promise<string | undefined> {
  if (!provider.apiKey) {
    throw new Error('OpenAI API key is required');
  }
  const normalizedApiUrl = normalizeOpenAIBaseURL(provider.apiUrl);
  console.log('translateWithOpenAI', text, provider);
  try {
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

    // 根据结构化输出配置选择合适的API调用方式
    const structuredOutputMode = getStructuredOutputMode(provider);

    if (structuredOutputMode === 'json_schema') {
      return await callWithJsonSchema(openai, baseParams);
    } else {
      return await callWithStandardAPI(
        openai,
        baseParams,
        structuredOutputMode,
      );
    }
  } catch (error) {
    console.error('OpenAI translation error:', error);
    throw new Error(
      `OpenAI translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export default translateWithOpenAI;
