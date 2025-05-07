import { TranslationConfig, TranslationResult, Subtitle } from '../types';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { logMessage } from '../../helpers/storeManager';

export async function handleAPIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.API,
  onProgress?: (progress: number) => void,
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const results: TranslationResult[] = [];

  for (let i = 0; i < subtitles.length; i += batchSize) {
    const batch = subtitles.slice(i, i + batchSize);
    const batchContents = batch.map((s) => s.content.join('\n'));

    try {
      logMessage(`handleAPITranslation number ${i}`);
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
        throw new Error('Translation result count does not match source count');
      }

      const batchResults = batch.map((subtitle, index) => ({
        id: subtitle.id,
        startEndTime: subtitle.startEndTime,
        sourceContent: subtitle.content.join('\n'),
        targetContent: translatedLines[index],
      }));

      results.push(...batchResults);

      // 更新翻译进度
      const progress = Math.min(
        ((i + batchSize) / subtitles.length) * 100,
        100,
      );
      if (onProgress) {
        onProgress(progress);
      }
    } catch (error) {
      logMessage(`API batch translation error: ${error.message}`, 'error');
      throw error;
    }
  }

  return results;
}
