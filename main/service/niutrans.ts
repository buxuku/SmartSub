import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

const NIUTRANS_API = 'https://api.niutrans.com/NiuTransServer/translation';

/**
 * 小牛翻译（NiuTrans）文本翻译
 * 文档：https://niutrans.com/documents/contents/trans_text
 * 仅需 API-KEY（控制台 -> 个人中心），无需签名。
 * 文本翻译接口一次翻译一段文本，为保证与时间轴一一对应，默认 batchSize=1，
 * 这里对数组逐条翻译并返回等长数组。
 */
export default async function niutrans(
  query: string | string[],
  proof: { apiKey?: string },
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const { apiKey } = proof || {};
  if (!apiKey) {
    console.log('请先配置小牛翻译 API Key');
    throw new Error('missingKeyOrSecret');
  }

  const from = convertLanguageCode(sourceLanguage, 'niutrans') || 'auto';
  const to = convertLanguageCode(targetLanguage, 'niutrans');
  if (!to) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }

  const translateOne = async (text: string): Promise<string> => {
    throwIfSignalCancelled(options?.signal);
    const body = new URLSearchParams({
      from,
      to,
      apikey: apiKey,
      src_text: text,
    });
    const res = await axios.post(NIUTRANS_API, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TRANSLATION_REQUEST_TIMEOUT,
      signal: options?.signal,
    });
    throwIfSignalCancelled(options?.signal);
    const data = res?.data || {};
    if (data.error_code) {
      throw new Error(
        `${data.error_code}: ${data.error_msg || 'NiuTrans translation failed'}`,
      );
    }
    if (typeof data.tgt_text !== 'string') {
      throw new Error(data.error_msg || 'NiuTrans translation failed');
    }
    return data.tgt_text;
  };

  if (Array.isArray(query)) {
    const results: string[] = [];
    for (const text of query) {
      results.push(await translateOne(text));
    }
    return results;
  }

  return translateOne(query);
}
