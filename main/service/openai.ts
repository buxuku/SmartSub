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
  useJsonMode?: boolean;
  providerType?: string;
  id?: string;
};

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
 * 判断是否为Gemini风格的API
 */
function isGeminiProvider(provider: OpenAIProvider): boolean {
  return (
    provider.providerType === 'gemini' ||
    provider.id === 'Gemini' ||
    provider.apiUrl?.includes('generativelanguage.googleapis.com')
  );
}

/**
 * 判断是否应该使用JSON模式
 */
function shouldUseJsonMode(provider: OpenAIProvider): boolean {
  return provider.useJsonMode !== false;
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
 * 使用Gemini风格的API（带zod schema解析）
 */
async function callWithGeminiStyle(
  openai: OpenAI,
  baseParams: any,
): Promise<string | undefined> {
  console.log('Using Gemini-style API with zod schema');
  try {
    const completion = await openai.beta.chat.completions.parse({
      ...baseParams,
      response_format: zodResponseFormat(
        TranslationResultSchema,
        'translation',
      ),
    });

    console.log('Gemini completion:', completion?.choices);
    const parsed = completion?.choices?.[0]?.message?.parsed;
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed);
    }
    return parsed ? String(parsed) : undefined;
  } catch (parseError) {
    console.warn(
      'Gemini-style parse failed, falling back to regular API:',
      parseError,
    );
    // 回退到标准API
    const fallbackCompletion = (await openai.chat.completions.create({
      ...baseParams,
      response_format: { type: 'json_object' },
    })) as OpenAI.Chat.Completions.ChatCompletion;
    return fallbackCompletion?.choices?.[0]?.message?.content?.trim();
  }
}

/**
 * 使用标准OpenAI API
 */
async function callWithStandardAPI(
  openai: OpenAI,
  baseParams: any,
  provider: OpenAIProvider,
): Promise<string | undefined> {
  console.log('Using standard OpenAI-compatible API');

  const requestParams: any = { ...baseParams };

  // 添加JSON响应格式
  if (shouldUseJsonMode(provider)) {
    requestParams.response_format = { type: 'json_object' };

    // 对于官方OpenAI API，添加schema
    if (provider.providerType === 'openai' || provider.id === 'openai') {
      requestParams.response_format.schema = TRANSLATION_JSON_SCHEMA;
    }
  }

  const completion = (await openai.chat.completions.create(
    requestParams,
  )) as OpenAI.Chat.Completions.ChatCompletion;
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
  try {
    console.log('Provider config:', {
      id: provider.id,
      apiUrl: provider.apiUrl,
      modelName: provider.modelName,
    });

    // Get custom headers for the request
    const customHeaders = getCustomHeaders(provider);

    const openai = new OpenAI({
      baseURL: provider.apiUrl,
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

    // 根据provider类型选择合适的API调用方式
    if (isGeminiProvider(provider) && shouldUseJsonMode(provider)) {
      return await callWithGeminiStyle(openai, baseParams);
    } else {
      return await callWithStandardAPI(openai, baseParams, provider);
    }
  } catch (error) {
    console.error('OpenAI translation error:', error);
    throw new Error(
      `OpenAI translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export default translateWithOpenAI;
