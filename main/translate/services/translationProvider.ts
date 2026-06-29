import {
  Provider,
  TranslationResult,
  Subtitle,
  TranslatorFunction,
} from '../types';
import { handleAIBatchTranslation } from './ai';
import { handleAPIBatchTranslation } from './api';
import { createFallbackTranslator } from './fallback';
import { logMessage } from '../../helpers/storeManager';
import {
  volcTranslator,
  baiduTranslator,
  deeplxTranslator,
  ollamaTranslator,
  openaiTranslator,
  azureTranslator,
  azureOpenaiTranslator,
  aliyunTranslator,
  googleTranslator,
  bingFreeTranslator,
  googleFreeTranslator,
  doubaoTranslator,
  niutransTranslator,
  tencentTranslator,
  xunfeiTranslator,
} from '../../service';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { getTaskSignal } from '../../helpers/taskContext';

/** autoFree 默认回退链：Bing 免费 → Google 免费 → DeepLX */
export const DEFAULT_FREE_FALLBACK_CHAIN = ['bingFree', 'googleFree', 'deeplx'];

export const TRANSLATOR_MAP = {
  volc: volcTranslator,
  baidu: baiduTranslator,
  deeplx: deeplxTranslator,
  azure: azureTranslator,
  ollama: ollamaTranslator,
  azureopenai: azureOpenaiTranslator,
  openai: openaiTranslator,
  deepseek: openaiTranslator,
  DeerAPI: openaiTranslator,
  aliyun: aliyunTranslator,
  Gemini: openaiTranslator,
  qwen: openaiTranslator,
  siliconflow: openaiTranslator,
  google: googleTranslator,
  bingFree: bingFreeTranslator,
  googleFree: googleFreeTranslator,
  autoFree: createFallbackTranslator(DEFAULT_FREE_FALLBACK_CHAIN),
  doubao: doubaoTranslator,
  niutrans: niutransTranslator,
  tencent: tencentTranslator,
  xunfei: xunfeiTranslator,
} as const;

export async function translateWithProvider(
  provider: Provider,
  subtitles: Subtitle[],
  sourceLanguage: string,
  targetLanguage: string,
  translator: TranslatorFunction,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>,
  maxRetries: number = 0,
): Promise<TranslationResult[] | string[]> {
  const config = {
    provider,
    sourceLanguage,
    targetLanguage,
    translator,
    signal: getTaskSignal(),
  };

  logMessage(
    `Translation started with provider: ${JSON.stringify(provider, null, 2)}`,
    'info',
  );
  onProgress && onProgress(0);
  if (provider.isAi) {
    return handleAIBatchTranslation(
      subtitles,
      config,
      +(provider.batchSize || DEFAULT_BATCH_SIZE.AI),
      onProgress,
      onTranslationResult,
      maxRetries,
    );
  }

  return handleAPIBatchTranslation(
    subtitles,
    config,
    +(provider.batchSize || DEFAULT_BATCH_SIZE.API),
    onProgress,
    onTranslationResult,
    maxRetries,
  );
}
