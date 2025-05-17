import {
  Provider,
  TranslationResult,
  Subtitle,
  TranslatorFunction,
} from '../types';
import { handleAIBatchTranslation } from './ai';
import { handleAPIBatchTranslation } from './api';
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
} from '../../service';
import { DEFAULT_BATCH_SIZE } from '../constants';

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
