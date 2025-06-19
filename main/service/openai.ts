import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  TRANSLATION_JSON_SCHEMA,
  TranslationResultSchema,
} from '../translate/constants/schema';

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
 * 获取特定provider的额外参数
 */
function getProviderSpecificParams(
  provider: OpenAIProvider,
): Record<string, any> {
  const params: Record<string, any> = {};

  // 通义千问需要禁用thinking模式
  if (
    provider.id === 'qwen' ||
    provider.apiUrl?.includes('dashscope.aliyuncs.com')
  ) {
    params.enable_thinking = false;
  }

  return params;
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
 * 创建基础请求参数
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
 * 主要的翻译函数
 */
export async function translateWithOpenAI(
  text: string[],
  provider: OpenAIProvider,
): Promise<string | undefined> {
  try {
    console.log('Provider config:', {
      id: provider.id,
      apiUrl: provider.apiUrl,
      modelName: provider.modelName,
    });

    const openai = new OpenAI({
      baseURL: provider.apiUrl,
      apiKey: provider.apiKey,
    });

    const baseParams = createBaseParams(text, provider);
    console.log('Request params:', {
      model: baseParams.model,
      temperature: baseParams.temperature,
      additionalParams: getProviderSpecificParams(provider),
    });

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
