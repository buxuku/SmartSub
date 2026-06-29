import axios from 'axios';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * DeepLX 翻译（非官方 DeepL，需用户自建/自填端点）。
 * 逐条翻译并返回等长数组，且按传入的源/目标语言生成 DeepL 语言代码
 * （历史实现固定 en→zh，这里改为遵循实际语言并保持调用签名兼容）。
 */

const DEFAULT_TARGET = 'ZH';

function toDeepLCode(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  // 繁体中文保留地区码（DeepL 使用 ZH-HANT）；其余取主语言码并大写。
  if (lang === 'zh-Hant') return 'ZH-HANT';
  const code = String(lang).split('-')[0].toUpperCase();
  return code || fallback;
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

  const translateOne = async (text: string): Promise<string> => {
    if (!text || !text.trim()) return text ?? '';
    await acquire(rateKey, rateCfg, options?.signal);
    const res = await axios.post(
      apiUrl,
      { text, source_lang, target_lang },
      { timeout: TRANSLATION_REQUEST_TIMEOUT, signal: options?.signal },
    );
    throwIfSignalCancelled(options?.signal);
    const data = res?.data || {};
    const out =
      typeof data.data === 'string'
        ? data.data
        : Array.isArray(data.alternatives)
          ? data.alternatives[0]
          : '';
    if (!out) {
      throw new Error('DeepLX empty result (network)');
    }
    return out;
  };

  const results: string[] = [];
  for (const text of list) {
    results.push(await translateOne(text));
  }

  return Array.isArray(query) ? results : results[0];
}
