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
 * Bing 网页版免费翻译，无需 API Key。
 *
 * Bing 已下线旧的 Edge auth/JWT 和 cognitive translator 接口。当前网页
 * 通过 /translator 页面下发一次性会话参数，再向同域 /ttranslatev3 发送
 * 表单请求；会话参数包括 IG、IID、key 和 token。
 */

const BING_ORIGIN = 'https://www.bing.com';
const TRANSLATOR_PAGE = `${BING_ORIGIN}/translator`;
const TRANSLATE_PATH = '/ttranslatev3';
const MAX_TEXT_LENGTH = 5000;
const SESSION_TTL_MS = 50 * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

interface BingSession {
  ig: string;
  iid: string;
  key: string;
  token: string;
  fetchedAt: number;
}

let cachedSession: BingSession | undefined;

function parseQuotedOrBareValues(raw: string): string[] {
  return (
    raw.match(/(?:"(?:[^"\\]|\\.)*"|[^,]+)/g)?.map((value) => {
      const trimmed = value.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed.slice(1, -1);
        }
      }
      return trimmed;
    }) || []
  );
}

function parseSession(html: string): BingSession {
  const ig = html.match(/"ig":"([A-Z0-9]+)"/)?.[1];
  const abuseParams = html.match(
    /params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/,
  )?.[1];
  const [key, token] = abuseParams ? parseQuotedOrBareValues(abuseParams) : [];
  const iid = html.match(/data-iid="([^"]+)"/)?.[1];

  if (!ig || !iid || !key || !token) {
    throw new Error('Bing free translate failed (network): invalid session');
  }

  return { ig, iid, key, token, fetchedAt: Date.now() };
}

async function getSession(
  force = false,
  options?: TranslationRequestOptions,
): Promise<BingSession> {
  if (
    !force &&
    cachedSession &&
    Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS
  ) {
    return cachedSession;
  }

  throwIfSignalCancelled(options?.signal);
  const response = await axios.get(TRANSLATOR_PAGE, {
    params: { from: 'auto-detect', to: 'zh-Hans' },
    headers: { 'User-Agent': USER_AGENT },
    timeout: TRANSLATION_REQUEST_TIMEOUT,
    signal: options?.signal,
  });
  throwIfSignalCancelled(options?.signal);

  if (typeof response.data !== 'string') {
    throw new Error('Bing free translate failed (network): empty session page');
  }

  cachedSession = parseSession(response.data);
  return cachedSession;
}

async function requestTranslate(
  text: string,
  from: string,
  to: string,
  session: BingSession,
  options?: TranslationRequestOptions,
): Promise<string> {
  const body = new URLSearchParams({
    fromLang: from || 'auto-detect',
    to,
    text: text.slice(0, MAX_TEXT_LENGTH),
    token: session.token,
    key: session.key,
  });
  const response = await axios.post(
    `${BING_ORIGIN}${TRANSLATE_PATH}`,
    body.toString(),
    {
      params: { isVertical: 1, IG: session.ig, IID: session.iid },
      headers: {
        'User-Agent': USER_AGENT,
        Referer: TRANSLATOR_PAGE,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: TRANSLATION_REQUEST_TIMEOUT,
      signal: options?.signal,
    },
  );
  throwIfSignalCancelled(options?.signal);

  if (
    response.data &&
    typeof response.data === 'object' &&
    response.data.statusCode === 205
  ) {
    throw new Error('Bing free translate failed (network): session expired');
  }

  const translation = response.data?.[0]?.translations?.[0]?.text;
  if (typeof translation !== 'string' || !translation.trim()) {
    throw new Error(
      'Bing free translate failed (network): unexpected response',
    );
  }
  return translation;
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
  const from =
    !sourceLanguage || sourceLanguage.toLowerCase() === 'auto'
      ? 'auto-detect'
      : convertLanguageCode(sourceLanguage, 'bing') || 'auto-detect';
  const to = convertLanguageCode(targetLanguage, 'bing');
  if (!to) {
    throw new Error('not supported language');
  }

  const providerId = proof?.id || 'bingFree';
  const rateKey = `bingFree:${providerId}`;
  const rateCfg = resolveRateLimitConfig(proof);
  const results: string[] = [];

  for (const text of list) {
    if (!text || !text.trim()) {
      results.push(text ?? '');
      continue;
    }

    let session = await getSession(false, options);
    try {
      await acquire(rateKey, rateCfg, options?.signal);
      results.push(await requestTranslate(text, from, to, session, options));
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      const status = error?.response?.status;
      const message = String(error?.message || '');
      const sessionExpired =
        status === 401 || status === 403 || message.includes('session expired');
      if (!sessionExpired) {
        throw new Error(
          `Bing free translate failed (network): ${message || 'request error'}`,
        );
      }

      session = await getSession(true, options);
      await acquire(rateKey, rateCfg, options?.signal);
      try {
        results.push(await requestTranslate(text, from, to, session, options));
      } catch (retryError: any) {
        throwIfSignalCancelled(options?.signal);
        throw new Error(
          `Bing free translate failed (network): ${retryError?.message || 'retry error'}`,
        );
      }
    }
  }

  return Array.isArray(query) ? results : results[0];
}

export const __test__ = {
  parseSession,
  resetSession: () => {
    cachedSession = undefined;
  },
};
