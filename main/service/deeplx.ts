import axios from 'axios';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * DeepLX/DLX 本地翻译服务。
 * /translate 是 POST 接口；新版 DLX 仍兼容该接口，并返回 data 字段。
 * 同时兼容官方 API 风格 /v2/translate 返回的 translations[0].text。
 */

const DEFAULT_TARGET = 'ZH';

function toDeepLCode(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  if (lang === 'zh-Hant') return 'ZH-HANT';
  const code = String(lang).split('-')[0].toUpperCase();
  return code || fallback;
}

function getTranslationText(data: any): string {
  if (typeof data?.data === 'string') return data.data;
  if (Array.isArray(data?.alternatives) && data.alternatives[0]) {
    return String(data.alternatives[0]);
  }
  if (typeof data?.translations?.[0]?.text === 'string') {
    return data.translations[0].text;
  }
  return '';
}

function isV2Endpoint(apiUrl: string): boolean {
  try {
    return new URL(apiUrl).pathname.replace(/\/+$/, '') === '/v2/translate';
  } catch {
    return false;
  }
}

function buildRequestBody(
  apiUrl: string,
  text: string,
  source_lang: string,
  target_lang: string,
): Record<string, unknown> {
  if (isV2Endpoint(apiUrl)) {
    // DLX /v2/translate follows the official API shape and requires text[].
    return { text: [text], source_lang, target_lang };
  }
  return { text, source_lang, target_lang };
}

export default async function deeplx(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage?: string,
  targetLanguage?: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const { apiUrl } = proof || {};
  if (!apiUrl) {
    throw new Error('DeepLX endpoint not configured (network)');
  }

  const list = Array.isArray(query) ? query : [query];
  const source_lang = sourceLanguage
    ? toDeepLCode(sourceLanguage, 'AUTO')
    : 'AUTO';
  const target_lang = toDeepLCode(targetLanguage, DEFAULT_TARGET);
  const providerId = proof?.id || 'deeplx';
  const rateKey = `deeplx:${providerId}`;
  const rateCfg = resolveRateLimitConfig(proof);

  const results: string[] = [];
  for (const text of list) {
    if (!text || !text.trim()) {
      results.push(text ?? '');
      continue;
    }

    await acquire(rateKey, rateCfg, options?.signal);
    try {
      const response = await axios.post(
        apiUrl,
        buildRequestBody(apiUrl, text, source_lang, target_lang),
        {
          timeout: TRANSLATION_REQUEST_TIMEOUT,
          signal: options?.signal,
          headers: { 'Content-Type': 'application/json' },
        },
      );
      throwIfSignalCancelled(options?.signal);

      const translated = getTranslationText(response?.data);
      if (!translated) {
        throw new Error('DeepLX empty result (network)');
      }
      results.push(translated);
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      const status = error?.response?.status;
      const detail =
        error?.response?.data?.message || error?.message || 'request error';
      if (status === 429) {
        throw new Error(
          'DeepLX rate limited (network): local service or upstream rejected the request with HTTP 429',
        );
      }
      throw new Error(`DeepLX translate failed (network): ${detail}`);
    }
  }

  return Array.isArray(query) ? results : results[0];
}

export const __test__ = { buildRequestBody, getTranslationText };
