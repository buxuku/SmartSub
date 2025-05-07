import crypto from 'crypto';
import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';

export default async function baidu(
  query,
  proof,
  sourceLanguage,
  targetLanguage,
) {
  const { apiKey: appid, apiSecret: key } = proof || {};
  if (!appid || !key) {
    console.log('请先配置 API KEY 和 API SECRET');
    throw new Error('missingKeyOrSecret');
  }

  // 支持字符串数组输入
  const queryText = Array.isArray(query) ? query.join('\n') : query;

  const formatSourceLanguage = convertLanguageCode(sourceLanguage, 'baidu');
  const formatTargetLanguage = convertLanguageCode(targetLanguage, 'baidu');
  if (!formatSourceLanguage || !formatTargetLanguage) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }
  const salt = new Date().getTime();
  const str1 = appid + queryText + salt + key;
  const sign = crypto.createHash('md5').update(str1).digest('hex');
  const data = {
    q: queryText,
    appid,
    salt,
    from: formatSourceLanguage,
    to: formatTargetLanguage,
    sign,
  };
  const res = await axios.post(
    'https://fanyi-api.baidu.com/api/trans/vip/translate',
    data,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  if (!res?.data?.trans_result) {
    throw new Error(res?.data?.error_msg || '未知错误');
  }

  // 如果输入是数组，返回结果也转换为数组
  if (Array.isArray(query)) {
    return res.data.trans_result.map((item) => item.dst);
  }
  return res.data.trans_result.map((item) => item.dst).join('\n');
}
