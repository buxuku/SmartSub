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
 * Bing（Edge 浏览器内置）免费翻译，无需 API Key。
 * 原理：先从 edge.microsoft.com/translate/auth 取匿名 JWT（约 10 分钟有效），
 * 再调用 Edge 翻译接口批量翻译。质量等同付费 Azure Translator，且原生支持一次多条。
 *
 * 注意：token 过期/被拒（401/403）时自动续期重试一次；为避免被
 * isConfigurationError 误判为“配置错误中止任务”，对外抛出的错误信息统一带
 * “(network)”且不包含 401/403/unauthorized 等字样。
 */

const AUTH_ENDPOINT = 'https://edge.microsoft.com/translate/auth';
const TRANSLATE_ENDPOINT =
  'https://api-edge.cognitive.microsofttranslator.com/translate';
const TOKEN_TTL_MS = 9 * 60 * 1000; // 提前于 ~10 分钟过期续期
const MAX_TEXT_LENGTH = 5000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

let cachedToken = '';
let tokenFetchedAt = 0;

async function getToken(
  force = false,
  options?: TranslationRequestOptions,
): Promise<string> {
  if (!force && cachedToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) {
    return cachedToken;
  }
  throwIfSignalCancelled(options?.signal);
  const res = await axios.get(AUTH_ENDPOINT, {
    timeout: TRANSLATION_REQUEST_TIMEOUT,
    headers: { 'User-Agent': USER_AGENT },
    signal: options?.signal,
  });
  throwIfSignalCancelled(options?.signal);
  if (!res.data || typeof res.data !== 'string') {
    throw new Error('Bing free translate failed (network): empty auth token');
  }
  cachedToken = res.data.trim();
  tokenFetchedAt = Date.now();
  return cachedToken;
}

async function requestTranslate(
  texts: string[],
  to: string,
  token: string,
  options?: TranslationRequestOptions,
): Promise<any[]> {
  const res = await axios.post(
    TRANSLATE_ENDPOINT,
    texts.map((t) => ({ Text: t })),
    {
      params: { to, 'api-version': '3.0', includeSentenceLength: 'true' },
      headers: {
        'User-Agent': USER_AGENT,
        authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: TRANSLATION_REQUEST_TIMEOUT,
      signal: options?.signal,
    },
  );
  throwIfSignalCancelled(options?.signal);
  return res.data;
}

export default async function bingFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const list = Array.isArray(query) ? query : [query];
  const to = convertLanguageCode(targetLanguage, 'bing');
  if (!to) {
    throw new Error('not supported language');
  }

  const providerId = proof?.id || 'bingFree';
  const rateKey = `bingFree:${providerId}`;
  const rateCfg = resolveRateLimitConfig(proof);

  const texts = list.map((t) => (t ?? '').slice(0, MAX_TEXT_LENGTH));

  const runOnce = async (forceToken: boolean): Promise<any[]> => {
    const token = await getToken(forceToken, options);
    await acquire(rateKey, rateCfg, options?.signal);
    return requestTranslate(texts, to, token, options);
  };

  let data: any[];
  try {
    data = await runOnce(false);
  } catch (error: any) {
    throwIfSignalCancelled(options?.signal);
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      // token 失效，强制续期后重试一次
      try {
        data = await runOnce(true);
      } catch (retryError: any) {
        throwIfSignalCancelled(options?.signal);
        throw new Error(
          `Bing free translate failed (network): ${retryError?.message || 'retry error'}`,
        );
      }
    } else {
      throw new Error(
        `Bing free translate failed (network): ${error?.message || 'request error'}`,
      );
    }
  }

  if (!Array.isArray(data)) {
    throw new Error(
      'Bing free translate failed (network): unexpected response',
    );
  }

  const result = data.map((item) => item?.translations?.[0]?.text ?? '');
  if (result.length !== list.length) {
    throw new Error(
      'Bing free translate failed (network): result count mismatch',
    );
  }

  return Array.isArray(query) ? result : result[0];
}
