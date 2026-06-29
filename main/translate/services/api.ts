import { TranslationConfig, TranslationResult, Subtitle } from '../types';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { logMessage } from '../../helpers/storeManager';
import { isConfigurationError } from '../utils/error';
import {
  throwIfTaskCancelled,
  isTaskCancelledError,
  throwIfSignalCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';
import {
  createTranslationBatches,
  normalizeBatchSize,
  resolveBatchConcurrency,
  runTranslationBatchesInOrder,
  type TranslationBatch,
} from '../utils/batchConcurrency';

export async function handleAPIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.API,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>,
  maxRetries: number = 0,
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const normalizedBatchSize = normalizeBatchSize(
    batchSize,
    DEFAULT_BATCH_SIZE.API,
  );
  const batches = createTranslationBatches(subtitles, normalizedBatchSize);
  const totalBatches = batches.length;
  const batchConcurrency = resolveBatchConcurrency(
    provider.batchConcurrency,
    totalBatches,
  );

  const requestInterval = +(provider.requestInterval || 0) * 1000;

  logMessage(
    `开始API批量翻译：总共 ${subtitles.length} 条字幕，分为 ${totalBatches} 个批次，每批次 ${normalizedBatchSize} 条，并发 ${batchConcurrency}`,
    'info',
  );

  const processBatch = async (
    translationBatch: TranslationBatch,
  ): Promise<TranslationResult[]> => {
    throwIfTaskCancelled();
    const batch = translationBatch.subtitles;
    const batchContents = batch.map((s) => s.content.join('\n'));
    const currentBatchIndex = translationBatch.displayIndex;
    let retryCount = 0;
    let batchSuccess = false;
    let batchResults: TranslationResult[] = [];

    while (!batchSuccess && retryCount <= maxRetries) {
      throwIfTaskCancelled();
      try {
        logMessage(
          `API翻译批次 ${currentBatchIndex}/${totalBatches} (尝试 ${retryCount + 1}/${maxRetries + 1})`,
        );
        const translatedContent = await translator(
          batchContents,
          provider,
          sourceLanguage,
          targetLanguage,
          { signal: config.signal },
        );
        throwIfSignalCancelled(config.signal);

        const translatedLines = Array.isArray(translatedContent)
          ? translatedContent
          : translatedContent.split('\n');

        if (translatedLines.length !== batch.length) {
          throw new Error(
            'Translation result count does not match source count',
          );
        }

        batchResults = batch.map((subtitle, index) => ({
          id: subtitle.id,
          startEndTime: subtitle.startEndTime,
          sourceContent: subtitle.content.join('\n'),
          targetContent: translatedLines[index],
        }));

        batchSuccess = true;
      } catch (error) {
        if (isTaskCancelledError(error)) throw error;
        throwIfSignalCancelled(config.signal);
        // 检查是否是配置错误，如果是则直接抛出，不进行重试
        if (isConfigurationError(error)) {
          throw new Error(
            `翻译服务配置不完整，请检查相关配置: ${error.message}`,
          );
        }

        retryCount++;
        if (retryCount <= maxRetries) {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 翻译失败，重试 ${retryCount}/${maxRetries}: ${error.message}`,
            'warning',
          );
          // 添加短暂延迟，避免频繁重试
          await waitForTaskDelay(1000 * retryCount, config.signal);
        } else {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 翻译失败，已达到最大重试次数 ${maxRetries}，跳过该批次: ${error.message}`,
            'error',
          );
          // 如果全部重试都失败，则添加失败记录，并继续下一批
          batchResults = batch.map((subtitle) => ({
            id: subtitle.id,
            startEndTime: subtitle.startEndTime,
            sourceContent: subtitle.content.join('\n'),
            targetContent: `[翻译失败: ${error.message}]`,
          }));

          batchSuccess = true; // 标记为完成，继续下一批次
        }
      }
    }

    return batchResults;
  };

  const results = await runTranslationBatchesInOrder({
    batches,
    concurrency: batchConcurrency,
    requestIntervalMs: requestInterval,
    totalSubtitles: subtitles.length,
    processBatch,
    onProgress,
    onTranslationResult,
  });

  return results;
}
