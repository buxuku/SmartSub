import OpenAI from 'openai';
import { TRANSLATION_JSON_SCHEMA } from '../translate/constants/schema';

type OpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
  useJsonMode?: boolean;
};

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

    // 创建请求参数
    const requestParams: any = {
      model: provider.modelName || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    };

    // 如果启用了JSON模式，添加相关参数
    if (provider.useJsonMode !== false) {
      // OpenAI API支持的JSON模式参数
      requestParams.response_format = { type: 'json_object' };

      // 添加JSON schema参数 (适用于支持schema的模型)
      if (provider.modelName) {
        requestParams.response_format.schema = TRANSLATION_JSON_SCHEMA;
      }
    }

    const completion = await openai.chat.completions.create(requestParams);

    console.log('completion:', completion?.choices);
    const result = completion?.choices?.[0]?.message?.content?.trim();

    return result;
  } catch (error) {
    console.error('OpenAI translation error:', error);
    throw new Error(`OpenAI translation failed: ${error.message}`);
  }
}

export default translateWithOpenAI;
