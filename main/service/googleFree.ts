import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * Google 免费翻译，无需 API Key。
 * 使用 translate_a/single?client=gtx 的 JSON 接口（比抓取 /m 网页更稳）。
 * 该接口一次只译一段文本，因此逐条翻译并把多句段拼回单条，保证返回数组与输入等长。
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MAX_TEXT_LENGTH = 5000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function translateOne(
  text: string,
  sl: string,
  tl: string,
  rateKey: string,
  rateCfg: ReturnType<typeof resolveRateLimitConfig>,
  options?: TranslationRequestOptions,
): Promise<string> {
  if (!text || !text.trim()) return text ?? '';

  await acquire(rateKey, rateCfg, options?.signal);
  const res = await axios.get(ENDPOINT, {
    params: {
      client: 'gtx',
      sl,
      tl,
      dt: 't',
      q: text.slice(0, MAX_TEXT_LENGTH),
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: TRANSLATION_REQUEST_TIMEOUT,
    signal: options?.signal,
  });
  throwIfSignalCancelled(options?.signal);

  const data = res.data;
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error(
      'Google free translate failed (network): unexpected response',
    );
  }
  // data[0] = [[translatedSegment, originalSegment, ...], ...]
  return data[0]
    .map((seg: any) => (Array.isArray(seg) && seg[0] ? seg[0] : ''))
    .join('');
}

export default async function googleFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const list = Array.isArray(query) ? query : [query];
  const sl = convertLanguageCode(sourceLanguage, 'google') || 'auto';
  const tl = convertLanguageCode(targetLanguage, 'google');
  if (!tl) {
    throw new Error('not supported language');
  }

  const providerId = proof?.id || 'googleFree';
  const rateKey = `googleFree:${providerId}`;
  const rateCfg = resolveRateLimitConfig(proof);

  const results: string[] = [];
  for (const text of list) {
    try {
      results.push(await translateOne(text, sl, tl, rateKey, rateCfg, options));
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      throw new Error(
        `Google free translate failed (network): ${error?.message || 'request error'}`,
      );
    }
  }

  return Array.isArray(query) ? results : results[0];
}
