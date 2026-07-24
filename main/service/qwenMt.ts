import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import { matchGlossaryEntries } from '../glossary/core';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import type { TranslationRequestOptions } from '../translate/types';

export const QWEN_MT_DEFAULT_API_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QWEN_MT_DEFAULT_MODEL = 'qwen-mt-flash';

interface QwenMtProviderConfig {
  apiKey?: string;
  apiUrl?: string;
  modelName?: string;
}

interface QwenMtTerm {
  source: string;
  target: string;
}

interface QwenMtTranslationOptions {
  source_lang: string;
  target_lang: string;
  terms?: QwenMtTerm[];
}

export interface QwenMtRequestBody {
  model: string;
  messages: [{ role: 'user'; content: string }];
  translation_options: QwenMtTranslationOptions;
}

export function resolveQwenMtApiUrl(apiUrl?: string): string {
  const baseUrl = (apiUrl || QWEN_MT_DEFAULT_API_URL)
    .trim()
    .replace(/\/+$/, '');
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl}/chat/completions`;
}

export function resolveQwenMtLanguage(
  languageCode: string,
  allowAuto: boolean,
): string | null {
  if (allowAuto && (!languageCode || languageCode === 'auto')) return 'auto';
  if (!languageCode || languageCode === 'auto') return null;
  return convertLanguageCode(languageCode, 'qwenMt');
}

export function buildQwenMtRequestBody(
  text: string,
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  terms: QwenMtTerm[] = [],
): QwenMtRequestBody {
  return {
    model,
    messages: [{ role: 'user', content: text }],
    translation_options: {
      source_lang: sourceLanguage,
      target_lang: targetLanguage,
      ...(terms.length ? { terms } : {}),
    },
  };
}

async function translateOne(
  text: string,
  provider: QwenMtProviderConfig,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  throwIfSignalCancelled(options?.signal);
  if (!text.trim()) return text;
  const glossaryMatches = matchGlossaryEntries(options?.glossaryEntries || [], [
    text,
  ]);
  const requestBody = buildQwenMtRequestBody(
    text,
    provider.modelName || QWEN_MT_DEFAULT_MODEL,
    sourceLanguage,
    targetLanguage,
    glossaryMatches.map(({ source, target }) => ({ source, target })),
  );

  try {
    const response = await axios.post(
      resolveQwenMtApiUrl(provider.apiUrl),
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        timeout: TRANSLATION_REQUEST_TIMEOUT,
        signal: options?.signal,
      },
    );
    throwIfSignalCancelled(options?.signal);

    const translatedText = response?.data?.choices?.[0]?.message?.content;
    if (typeof translatedText !== 'string' || !translatedText.trim()) {
      throw new Error(
        response?.data?.error?.message ||
          response?.data?.message ||
          '翻译返回为空',
      );
    }
    return translatedText;
  } catch (error) {
    throwIfSignalCancelled(options?.signal);
    if (axios.isAxiosError(error)) {
      const errorMessage =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message;
      throw new Error(errorMessage);
    }
    throw error;
  }
}

export default async function translate(
  query: string | string[],
  provider: QwenMtProviderConfig,
  sourceLanguageCode: string,
  targetLanguageCode: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  if (!provider?.apiKey) {
    throw new Error('missingKeyOrSecret');
  }

  const sourceLanguage = resolveQwenMtLanguage(sourceLanguageCode, true);
  const targetLanguage = resolveQwenMtLanguage(targetLanguageCode, false);
  if (!sourceLanguage || !targetLanguage) {
    throw new Error('not supported language');
  }

  const texts = Array.isArray(query) ? query : [query];
  const results: string[] = [];
  // Qwen-MT 要求每个请求仅包含一条 user 消息；整体吞吐由上层 batchConcurrency 控制。
  for (const text of texts) {
    results.push(
      await translateOne(
        text,
        provider,
        sourceLanguage,
        targetLanguage,
        options,
      ),
    );
  }

  return Array.isArray(query) ? results : results[0];
}
