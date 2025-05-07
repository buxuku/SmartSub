import { Service } from '@volcengine/openapi';
import { convertLanguageCode } from '../helpers/utils';

let service;
let fetchApi;

export default async function translate(
  query,
  proof,
  sourceLanguage,
  targetLanguage,
) {
  const { apiKey: accessKeyId, apiSecret: secretKey } = proof || {};
  if (!accessKeyId || !secretKey) {
    console.log('请先配置 API KEY 和 API SECRET');
    throw new Error('missingKeyOrSecret');
  }
  const formatSourceLanguage = convertLanguageCode(sourceLanguage, 'volc');
  const formatTargetLanguage = convertLanguageCode(targetLanguage, 'volc');
  if (!formatSourceLanguage || !formatTargetLanguage) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }
  if (!service || !fetchApi) {
    service = new Service({
      host: 'open.volcengineapi.com',
      serviceName: 'translate',
      region: 'cn-north-1',
      accessKeyId,
      secretKey,
    });
    fetchApi = service.createAPI('TranslateText', {
      Version: '2020-06-01',
      method: 'POST',
      contentType: 'json',
    });
  }
  const postBody = {
    SourceLanguage: formatSourceLanguage,
    TargetLanguage: formatTargetLanguage,
    TextList: Array.isArray(query) ? query : [query],
  };
  try {
    const res = await fetchApi(postBody, {});
    if (!res?.TranslationList?.[0]?.Translation) {
      throw new Error(res?.ResponseMetadata?.Error?.Code || '未知错误');
    }

    // 如果输入是数组，返回结果数组
    if (Array.isArray(query)) {
      return res.TranslationList.map((item) => item.Translation);
    }
    return res.TranslationList[0].Translation;
  } catch (error) {
    throw new Error(error?.message || '未知错误');
  }
}
