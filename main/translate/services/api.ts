import { TranslationConfig, TranslationResult, Subtitle } from '../types';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { logMessage } from '../../helpers/storeManager';
import { isConfigurationError } from '../utils/error';

export async function handleAPIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.API,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>,
  maxRetries: number = 0,
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const results: TranslationResult[] = [];
  const totalBatches = Math.ceil(subtitles.length / batchSize);

  for (let i = 0; i < subtitles.length; i += batchSize) {
    const batch = subtitles.slice(i, i + batchSize);
    const batchContents = batch.map((s) => s.content.join('\n'));
    const currentBatchIndex = Math.floor(i / batchSize) + 1;
    let retryCount = 0;
    let batchSuccess = false;

    while (!batchSuccess && retryCount <= maxRetries) {
      try {
        logMessage(
          `API翻译批次 ${currentBatchIndex}/${totalBatches} (尝试 ${retryCount + 1}/${maxRetries + 1})`,
        );
        const translatedContent = await translator(
          batchContents,
          provider,
          sourceLanguage,
          targetLanguage,
        );

        const translatedLines = Array.isArray(translatedContent)
          ? translatedContent
          : translatedContent.split('\n');

        if (translatedLines.length !== batch.length) {
          throw new Error(
            'Translation result count does not match source count',
          );
        }

        const batchResults = batch.map((subtitle, index) => ({
          id: subtitle.id,
          startEndTime: subtitle.startEndTime,
          sourceContent: subtitle.content.join('\n'),
          targetContent: translatedLines[index],
        }));

        // 如果提供了结果处理函数，则实时处理每个翻译结果
        if (onTranslationResult) {
          await onTranslationResult(batchResults);
        }

        results.push(...batchResults);
        batchSuccess = true;
      } catch (error) {
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
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * retryCount),
          );
        } else {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 翻译失败，已达到最大重试次数 ${maxRetries}，跳过该批次: ${error.message}`,
            'error',
          );
          // 如果全部重试都失败，则添加失败记录，并继续下一批
          const failedResults = batch.map((subtitle) => ({
            id: subtitle.id,
            startEndTime: subtitle.startEndTime,
            sourceContent: subtitle.content.join('\n'),
            targetContent: `[翻译失败: ${error.message}]`,
          }));

          // 对失败的结果也进行处理和保存
          if (onTranslationResult) {
            await onTranslationResult(failedResults);
          }

          results.push(...failedResults);
          batchSuccess = true; // 标记为完成，继续下一批次
        }
      }
    }

    // 更新翻译进度
    const progress = Math.min(((i + batchSize) / subtitles.length) * 100, 100);
    if (onProgress) {
      onProgress(progress);
    }
  }

  return results;
}
