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
  providerType?: 'openai' | 'gemini' | 'generic';
};

async function callGeminiAPI(
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
    return typeof parsed === 'object'
      ? JSON.stringify(parsed)
      : parsed?.toString();
  } catch (parseError) {
    console.warn(
      'Gemini-style parse failed, falling back to regular API:',
      parseError,
    );
    const fallbackCompletion = await openai.chat.completions.create({
      ...baseParams,
      response_format: { type: 'json_object' },
    });
    return fallbackCompletion?.choices?.[0]?.message?.content?.trim();
  }
}

async function callStandardAPI(
  openai: OpenAI,
  baseParams: any,
  provider: OpenAIProvider,
): Promise<string | undefined> {
  console.log('Using standard OpenAI API');
  const requestParams: any = { ...baseParams };

  if (provider.useJsonMode !== false) {
    requestParams.response_format = { type: 'json_object' };

    if (provider.modelName && provider.providerType === 'openai') {
      requestParams.response_format.schema = TRANSLATION_JSON_SCHEMA;
    }
  }

  const completion = await openai.chat.completions.create(requestParams);
  console.log('Standard completion:', completion?.choices);
  return completion?.choices?.[0]?.message?.content?.trim();
}

function isGeminiProvider(provider: OpenAIProvider): boolean {
  return (
    provider.providerType === 'gemini' ||
    provider.apiUrl?.includes('generativelanguage.googleapis.com')
  );
}

export async function translateWithOpenAI(
  text: string[],
  provider: OpenAIProvider,
) {
  try {
    const openai = new OpenAI({
      baseURL: provider.apiUrl,
      apiKey: provider.apiKey,
    });

    const sysPrompt =
      provider.systemPrompt ||
      'You are a professional subtitle translation tool';
    const userPrompt = Array.isArray(text) ? text.join('\n') : text;
    console.log('sysPrompt:', sysPrompt);
    console.log('userPrompt:', userPrompt);

    // 根据provider类型确定是否使用beta API和zod格式
    const isGeminiStyle = isGeminiProvider(provider);

    // 创建基础请求参数
    const baseParams = {
      model: provider.modelName || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: 0.3,
    };

    let result: string | undefined;

    if (isGeminiStyle && provider.useJsonMode !== false) {
      result = await callGeminiAPI(openai, baseParams);
    } else {
      result = await callStandardAPI(openai, baseParams, provider);
    }

    return result;
  } catch (error) {
    console.error('OpenAI translation error:', error);
    throw new Error(
      `OpenAI translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export default translateWithOpenAI;
