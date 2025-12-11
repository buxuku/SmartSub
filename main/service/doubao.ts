import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';

const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const DEFAULT_MODEL = 'doubao-seed-translation-250915';

export default async function translate(
  query: string | string[],
  proof: { apiKey?: string; modelName?: string },
  sourceLanguage: string,
  targetLanguage: string,
) {
  const { apiKey, modelName } = proof || {};
  if (!apiKey) {
    console.log('请先配置 API KEY');
    throw new Error('missingKeyOrSecret');
  }

  const formatSourceLanguage = convertLanguageCode(sourceLanguage, 'doubao');
  const formatTargetLanguage = convertLanguageCode(targetLanguage, 'doubao');
  if (!formatTargetLanguage) {
    console.log('不支持的目标语言');
    throw new Error('not supported language');
  }

  // 支持字符串数组输入
  const queryArray = Array.isArray(query) ? query : [query];
  const results: string[] = [];

  // 豆包翻译API每次只能翻译一条文本，需要循环调用
  for (const text of queryArray) {
    const requestBody = {
      model: modelName || DEFAULT_MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: text,
              translation_options: {
                source_language: formatSourceLanguage || undefined, // 如果是 auto 则不传
                target_language: formatTargetLanguage,
              },
            },
          ],
        },
      ],
    };

    try {
      const res = await axios.post(DOUBAO_API_URL, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });

      // 解析响应
      const output = res?.data?.output;
      if (!output || output.length === 0) {
        throw new Error(res?.data?.error?.message || '翻译返回为空');
      }

      // 从 output 中提取翻译结果
      const translatedText = extractTranslation(output);
      results.push(translatedText);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage =
          error.response?.data?.error?.message ||
          error.response?.data?.message ||
          error.message;
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  // 如果输入是数组，返回结果数组
  if (Array.isArray(query)) {
    return results;
  }
  return results[0];
}

/**
 * 从 Responses API 的 output 中提取翻译文本
 */
function extractTranslation(output: any[]): string {
  for (const item of output) {
    if (item.type === 'message' && item.content) {
      for (const content of item.content) {
        if (content.type === 'output_text' && content.text) {
          return content.text;
        }
      }
    }
  }
  throw new Error('无法从响应中提取翻译结果');
}
