import { convertLanguageCode } from '../helpers/utils';
import alimt20181012 from '@alicloud/alimt20181012';
import * as $OpenApi from '@alicloud/openapi-client';
import * as $Util from '@alicloud/tea-util';

// 客户端实例
let client: any = null;

/**
 * 阿里云翻译服务
 * @param query 待翻译文本，可以是字符串或字符串数组
 * @param proof 认证信息，包含apiKey(AccessKeyId)和apiSecret(AccessKeySecret)
 * @param sourceLanguage 源语言代码
 * @param targetLanguage 目标语言代码
 * @returns 翻译结果
 */
export default async function translate(
  query: string | string[],
  proof: { apiKey: string; apiSecret: string; endpoint?: string },
  sourceLanguage: string,
  targetLanguage: string
) {
  const { apiKey: accessKeyId, apiSecret: accessKeySecret, endpoint = 'mt.aliyuncs.com' } = proof || {};
  if (!accessKeyId || !accessKeySecret) {
    console.log('请先配置阿里云 AccessKey ID 和 AccessKey Secret');
    throw new Error('missingKeyOrSecret');
  }

  // 语言代码转换
  const formatSourceLanguage = convertLanguageCode(sourceLanguage, 'aliyun') || sourceLanguage;
  const formatTargetLanguage = convertLanguageCode(targetLanguage, 'aliyun') || targetLanguage;

  if (!formatSourceLanguage || !formatTargetLanguage) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }

  // 初始化客户端
  if (!client) {
    client = createClient(accessKeyId, accessKeySecret, endpoint);
  }

  try {
    // 处理单个文本或文本数组
    if (Array.isArray(query)) {
      if (query.length === 0) {
        return [];
      }
      
      // 批量翻译处理
      return await batchTranslate(client, query, formatSourceLanguage, formatTargetLanguage);
    } else {
      // 单文本翻译，包装成批量处理
      const results = await batchTranslate(client, [query], formatSourceLanguage, formatTargetLanguage);
      return results[0];
    }
  } catch (error) {
    console.error('阿里云翻译错误:', error);
    throw new Error(error?.message || '翻译失败');
  }
}

/**
 * 创建阿里云翻译客户端
 */
function createClient(accessKeyId: string, accessKeySecret: string, endpoint: string): any {
  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
  });
  // 设置服务端点
  config.endpoint = endpoint;
  return new alimt20181012(config);
}

/**
 * 批量翻译处理
 * 使用GetBatchTranslate API进行批量翻译
 */
async function batchTranslate(
  client: any,
  texts: string[],
  sourceLanguage: string,
  targetLanguage: string
): Promise<string[]> {
  // 准备批量翻译的输入格式
  // 格式: { "1": "text1", "2": "text2", ... }
  const sourceTextObj: Record<string, string> = {};
  texts.forEach((text, index) => {
    sourceTextObj[`${index}`] = text;
  });

  // 阿里云批量翻译API需要JSON字符串
  const sourceTextJson = JSON.stringify(sourceTextObj);

  // API请求参数
  const request = {
    formatType: 'text',
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage,
    scene: 'general',
    apiType: 'translate_standard', // 使用通用版翻译服务
    sourceText: sourceTextJson
  };

  // 运行时选项
  const runtime = new $Util.RuntimeOptions({});
  
  try {
    // 发起批量翻译请求
    const response = await client.getBatchTranslateWithOptions(request, runtime);
    
    // 处理返回结果
    if (response?.body?.code === 200 && response?.body?.translatedList) {
      // 构建结果数组，保持原始顺序
      const resultMap: Record<string, string> = {};
      for (const item of response.body.translatedList) {
        if (item.index && item.translated) {
          resultMap[item.index] = item.translated;
        }
      }
      
      // 按原始顺序返回结果
      return texts.map((_, index) => resultMap[`${index}`] || '');
    }
    
    throw new Error(response?.body?.message || '批量翻译请求返回错误');
  } catch (error) {
    console.error('阿里云批量翻译错误:', error);
    throw error;
  }
} 