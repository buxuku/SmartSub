import {
  Provider,
  TranslationResult,
  Subtitle,
  TranslatorFunction,
  TranslationConfig,
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
  qwenMtTranslator,
} from '../../service';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { getTaskSignal } from '../../helpers/taskContext';
import { describeGlossarySource } from '../../glossary/core';
import {
  getTaskGlossaryResolution,
  logGlossaryConflicts,
} from '../../helpers/glossaryManager';
import { ProviderFallbackRunner } from './providerFallback';

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
  qwenMt: qwenMtTranslator,
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
  useGlossary: boolean = true,
  onResponseMeta?: TranslationConfig['onResponseMeta'],
  fallbackProviders?: Provider[],
  onProviderFallback?: TranslationConfig['onProviderFallback'],
  subtitleTranslationStyle?: TranslationConfig['subtitleTranslationStyle'],
  onActivity?: TranslationConfig['onActivity'],
  options?: { glossaryIds?: string[]; episodeSummary?: string },
): Promise<TranslationResult[] | string[]> {
  if (subtitleTranslationStyle === 'conversational' && !provider.isAi) {
    throw new Error(
      'Conversational subtitle translation requires an AI provider',
    );
  }
  const supportsGlossary = provider.isAi || provider.type === 'qwenMt';
  const glossaryResolution =
    supportsGlossary && useGlossary
      ? getTaskGlossaryResolution(options?.glossaryIds)
      : undefined;
  const glossarySourceLabel = describeGlossarySource(options?.glossaryIds);
  if (glossaryResolution) {
    logGlossaryConflicts(
      glossaryResolution.conflicts,
      `${provider.type === 'qwenMt' ? 'Qwen-MT 翻译' : 'AI 翻译'}，${glossarySourceLabel}`,
    );
  }
  const glossaryEntries = glossaryResolution?.entries;
  const config: TranslationConfig = {
    onActivity,
    provider,
    sourceLanguage,
    targetLanguage,
    translator,
    glossaryEntries,
    subtitleTranslationStyle,
    ...(options ? { glossarySourceLabel } : {}),
    ...(options?.episodeSummary
      ? { episodeSummary: options.episodeSummary }
      : {}),
    signal: getTaskSignal(),
    onResponseMeta,
    fallbackProviders,
    onProviderFallback,
    fallbackRunner: undefined,
  };

  const fallbackRunner = new ProviderFallbackRunner({
    primary: provider,
    fallbacks: fallbackProviders,
    resolveTranslator: (candidate) => {
      if (candidate.id === provider.id) return translator;
      return TRANSLATOR_MAP[
        candidate.type as keyof typeof TRANSLATOR_MAP
      ] as unknown as typeof translator;
    },
    signal: config.signal,
    onFallback: onProviderFallback,
    log: logMessage,
  });
  config.fallbackRunner = fallbackRunner;

  logMessage(
    `Translation started with provider: ${JSON.stringify({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      isAi: provider.isAi,
      modelName: provider.modelName,
    })}`,
    'info',
  );
  onProgress && onProgress(0);
  if (options?.episodeSummary && !provider.isAi) {
    logMessage(
      `翻译服务 ${provider.name} 非 AI（机翻 / Qwen-MT），摘要未注入，仅供对照`,
      'info',
    );
  }
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
