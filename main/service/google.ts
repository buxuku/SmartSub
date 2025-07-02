import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';

export default async function google(
  query,
  proof,
  sourceLanguage,
  targetLanguage,
) {
  const { apiKey } = proof || {};
  if (!apiKey) {
    console.log('请先配置 Google Translate API Key');
    throw new Error('missingApiKey');
  }

  // 支持字符串数组输入
  const queryText = Array.isArray(query) ? query : [query];

  const formatSourceLanguage = convertLanguageCode(sourceLanguage, 'google');
  const formatTargetLanguage = convertLanguageCode(targetLanguage, 'google');
  console.log(
    formatSourceLanguage,
    formatTargetLanguage,
    'formatSourceLanguage, formatTargetLanguage',
    sourceLanguage,
    targetLanguage,
  );
  if (!formatSourceLanguage || !formatTargetLanguage) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }

  try {
    const response = await axios.post(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        q: queryText,
        source: formatSourceLanguage,
        target: formatTargetLanguage,
        format: 'text',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response?.data?.data?.translations) {
      throw new Error(response?.data?.error?.message || '翻译失败');
    }

    const translations = response.data.data.translations.map(
      (translation) => translation.translatedText,
    );

    // 如果输入是数组，返回结果也转换为数组
    if (Array.isArray(query)) {
      return translations;
    }
    return translations.join('\n');
  } catch (error) {
    console.log(error, 'google error');
    if (error.response) {
      // API 返回错误
      const errorMsg = error.response.data?.error?.message || '翻译请求失败';
      throw new Error(errorMsg);
    } else if (error.request) {
      // 网络错误
      throw new Error('网络连接失败');
    } else {
      // 其他错误
      throw new Error(error.message || '未知错误');
    }
  }
}
