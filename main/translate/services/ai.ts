import { TranslationConfig, TranslationResult, Subtitle } from '../types';
import { DEFAULT_BATCH_SIZE } from '../constants';
import { renderTemplate, supportedLanguage } from '../../helpers/utils';
import { logMessage } from '../../helpers/storeManager';
import { defaultSystemPrompt, defaultUserPrompt } from '../../../types';
import { isConfigurationError } from '../utils/error';
import {
  throwIfTaskCancelled,
  isTaskCancelledError,
  throwIfSignalCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';
import { parseAITranslationResponse } from '../utils/aiResponseParser';
import {
  createTranslationBatches,
  normalizeBatchSize,
  resolveBatchConcurrency,
  runTranslationBatchesInOrder,
  type TranslationBatch,
} from '../utils/batchConcurrency';

function getLanguageName(code: string): string {
  // 中文目标须向 AI 明确简/繁，避免「中文」歧义导致译文简繁混杂（issue #332）。
  // UI 仍显示「中文」，但提示词里替换为「简体中文」/「繁体中文」以稳定输出字形。
  const normalized = (code || '').toLowerCase();
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized === 'zh-hans'
  ) {
    return '简体中文';
  }
  if (
    normalized === 'zh-hant' ||
    normalized === 'zh-tw' ||
    normalized === 'zh-hk'
  ) {
    return '繁体中文';
  }
  const lang = supportedLanguage.find((l) => l.value === code);
  return lang?.name || code;
}

export async function handleAIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.AI,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>,
  maxRetries: number = 0,
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const sourceLanguageName = getLanguageName(sourceLanguage);
  const targetLanguageName = getLanguageName(targetLanguage);
  const normalizedBatchSize = normalizeBatchSize(
    batchSize,
    DEFAULT_BATCH_SIZE.AI,
  );
  const batches = createTranslationBatches(subtitles, normalizedBatchSize);
  const totalBatches = batches.length;
  const batchConcurrency = resolveBatchConcurrency(
    provider.batchConcurrency,
    totalBatches,
  );

  logMessage(
    `开始AI批量翻译：总共 ${subtitles.length} 条字幕，分为 ${totalBatches} 个批次，每批次 ${normalizedBatchSize} 条，并发 ${batchConcurrency}`,
    'info',
  );

  const requestInterval = +(provider.requestInterval || 0) * 1000;

  const processBatch = async (
    translationBatch: TranslationBatch,
  ): Promise<TranslationResult[]> => {
    throwIfTaskCancelled();
    const batch = translationBatch.subtitles;
    const currentBatchIndex = translationBatch.displayIndex;
    let retryCount = 0;
    let batchSuccess = false;
    let batchResults: TranslationResult[] = [];

    logMessage(
      `处理批次 ${currentBatchIndex}/${totalBatches}，包含 ${batch.length} 条字幕`,
      'info',
    );

    while (!batchSuccess && retryCount <= maxRetries) {
      throwIfTaskCancelled();
      try {
        let batchJsonContent: Record<string, string> = {};
        batch.forEach((item) => {
          batchJsonContent[item.id] = item.content.join('\n');
        });
        const fullContent = `${JSON.stringify(batchJsonContent, null, 2)}`;
        let translationContent = renderTemplate(
          provider.prompt || defaultUserPrompt,
          {
            sourceLanguage: sourceLanguageName,
            targetLanguage: targetLanguageName,
            content: fullContent,
          },
        );

        if (retryCount > 0) {
          translationContent +=
            '\n\n上一次响应无法解析。请只返回一个 JSON 对象，键必须是输入字幕 ID，值必须是翻译结果；不要返回 markdown、解释、注释或思考过程。';
        }

        const systemPrompt = renderTemplate(
          provider.systemPrompt || defaultSystemPrompt,
          {
            sourceLanguage: sourceLanguageName,
            targetLanguage: targetLanguageName,
            content: fullContent,
          },
        );

        // 更新配置，保持原有的结构化输出设置
        const translationConfig = {
          ...provider,
          systemPrompt,
          // 保留原有的 useJsonMode 配置或 structuredOutput 配置
          // 如果没有配置，默认启用 JSON 模式以保持向后兼容
          useJsonMode: provider.useJsonMode !== false,
        };

        logMessage(
          `AI translate batch ${currentBatchIndex}/${totalBatches} (尝试 ${retryCount + 1}/${maxRetries + 1}): \n ${translationContent}`,
          'info',
        );
        const responseOrigin = await translator(
          translationContent,
          translationConfig,
          sourceLanguage,
          targetLanguage,
          { signal: config.signal },
        );
        throwIfSignalCancelled(config.signal);
        const responseText = Array.isArray(responseOrigin)
          ? responseOrigin.join('\n')
          : responseOrigin;
        logMessage(`AI response: \n ${responseText}`, 'info');
        const parsedContent = parseAITranslationResponse(responseText);

        // 检查解析结果是否有效
        if (parsedContent) {
          const parsedKeys = Object.keys(parsedContent);
          const parsedValues = Object.values(parsedContent);

          // 校验返回条数是否与请求一致：
          // 若数量不一致（例如请求 50 条只回 40 条），按数组索引兜底会让译文与
          // 时间轴错位，因此视为本批次失败并触发重试，避免产生错位结果（issue #308）。
          if (parsedKeys.length !== batch.length) {
            throw new Error(
              `翻译返回条数与请求不一致：请求 ${batch.length} 条，返回 ${parsedKeys.length} 条`,
            );
          }

          const missingIds = batch
            .filter((subtitle) => parsedContent[subtitle.id] === undefined)
            .map((subtitle) => subtitle.id);
          if (missingIds.length > 0) {
            logMessage(
              `翻译返回 ID 与请求不完全一致，将按返回顺序兜底匹配，缺失 ID: ${missingIds.join(', ')}`,
              'warning',
            );
          }

          logMessage(`JSON parsing successful`, 'info');

          batchResults = batch.map((subtitle, index) => ({
            id: subtitle.id,
            startEndTime: subtitle.startEndTime,
            sourceContent: subtitle.content.join('\n'),
            // 优先使用ID匹配；数量已校验一致，按索引兜底是安全的
            targetContent:
              parsedContent[subtitle.id] !== undefined
                ? parsedContent[subtitle.id]
                : (parsedValues[index] ?? ''),
          }));

          batchSuccess = true;

          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 翻译成功`,
            'info',
          );
        } else {
          throw new Error(
            'Invalid response format: Failed to parse JSON structure',
          );
        }
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

          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 已标记为失败完成，继续下一批次`,
            'warning',
          );
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

  logMessage(
    `AI批量翻译完成：共处理 ${results.length} 条字幕，成功 ${results.filter((r) => !r.targetContent.startsWith('[翻译失败:')).length} 条`,
    'info',
  );

  return results;
}
