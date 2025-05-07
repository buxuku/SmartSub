import axios from 'axios';

interface AzureTranslateResponse {
  translations: {
    text: string;
    to: string;
  }[];
}

interface AzureTranslateRequest {
  text: string;
}

const azureTranslator = async (
  texts: string | string[],
  proof: {
    apiKey: string;
    apiSecret: string;
  },
  sourceLanguage?: string,
  targetLanguage?: string,
): Promise<string | string[]> => {
  try {
    const endpoint = 'https://api.cognitive.microsofttranslator.com';
    const route = '/translate';

    // 构建请求参数
    const params = new URLSearchParams({
      'api-version': '3.0',
      from: sourceLanguage || 'auto',
      to: targetLanguage || 'en',
    });

    // 构建请求体
    const requestBody: AzureTranslateRequest[] = Array.isArray(texts)
      ? texts.map((text) => ({ text }))
      : [{ text: texts as string }];

    // 发送请求
    const response = await axios({
      baseURL: endpoint,
      url: route,
      method: 'post',
      headers: {
        'Ocp-Apim-Subscription-Key': proof.apiKey,
        'Ocp-Apim-Subscription-Region': proof.apiSecret,
        'Content-type': 'application/json',
      },
      params: params,
      data: requestBody,
      responseType: 'json',
    });
    console.log(response, 'response');

    // 处理响应
    const results = response.data as AzureTranslateResponse[];
    const translations = results.map((result) => result.translations[0].text);

    // 根据输入类型返回对应格式
    return Array.isArray(texts) ? translations : translations[0];
  } catch (error) {
    console.log(error, 'error');
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.error?.message || error.message;
      throw new Error(`Azure翻译服务错误: ${message}`);
    }
    throw error;
  }
};

export default azureTranslator;
