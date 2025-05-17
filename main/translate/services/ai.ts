import { TranslationConfig, TranslationResult, Subtitle } from '../types';
import {
  THINK_TAG_REGEX,
  DEFAULT_BATCH_SIZE,
  JSON_CONTENT_REGEX,
} from '../constants';
import { renderTemplate } from '../../helpers/utils';
import { logMessage } from '../../helpers/storeManager';
import { defaultSystemPrompt, defaultUserPrompt } from '../../../types';
import { toJson } from 'really-relaxed-json';
import { jsonrepair } from 'jsonrepair';

export async function handleAIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.AI,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>,
  maxRetries: number = 0,
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const results: TranslationResult[] = [];
  const totalBatches = Math.ceil(subtitles.length / batchSize);

  for (let i = 0; i < subtitles.length; i += batchSize) {
    const batch = subtitles.slice(i, i + batchSize);
    const currentBatchIndex = Math.floor(i / batchSize) + 1;
    let retryCount = 0;
    let batchSuccess = false;

    while (!batchSuccess && retryCount <= maxRetries) {
      try {
        let batchJsonContent: Record<string, string> = {};
        batch.forEach((item) => {
          batchJsonContent[item.id] = item.content.join('\n');
        });
        const fullContent = `${JSON.stringify(batchJsonContent, null, 2)}`;
        const translationContent = renderTemplate(
          provider.prompt || defaultUserPrompt,
          {
            sourceLanguage,
            targetLanguage,
            content: fullContent,
          },
        );

        const systemPrompt = renderTemplate(
          provider.systemPrompt || defaultSystemPrompt,
          {
            sourceLanguage,
            targetLanguage,
            content: fullContent,
          },
        );

        // 更新配置，启用JSON模式
        const translationConfig = {
          ...provider,
          systemPrompt,
          useJsonMode: true,
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
        );
        logMessage(`AI response: \n ${responseOrigin}`, 'info');
        const response = responseOrigin.replace(THINK_TAG_REGEX, '').trim();

        // 解析响应, 从结果中提取 json 里面的内容
        const match = response.match(JSON_CONTENT_REGEX);
        const responseJsonString = match ? match[1] : response;

        // 尝试解析JSON
        const parsedContent = parseJsonWithFallbacks(responseJsonString);

        // 检查解析结果是否有效
        if (parsedContent && typeof parsedContent === 'object') {
          logMessage(`JSON parsing successful`, 'info');

          const parsedValues = Object.values(parsedContent);

          const batchResults = batch.map((subtitle, index) => ({
            id: subtitle.id,
            startEndTime: subtitle.startEndTime,
            sourceContent: subtitle.content.join('\n'),
            // 优先使用ID匹配，如果没有则使用数组索引
            targetContent:
              parsedContent[subtitle.id] !== undefined
                ? parsedContent[subtitle.id]
                : parsedValues[index] || `[翻译结果缺失]`,
          }));

          // 如果提供了结果处理函数，则实时处理每个翻译结果
          if (onTranslationResult) {
            await onTranslationResult(batchResults);
          }

          results.push(...batchResults);
          batchSuccess = true;
        } else {
          throw new Error(
            'Invalid response format: Failed to parse JSON structure',
          );
        }
      } catch (error) {
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

// 辅助函数：尝试多种方式解析JSON内容
function parseJsonWithFallbacks(jsonContent: string): any {
  try {
    // 第一次尝试：使用标准JSON解析
    return JSON.parse(jsonContent);
  } catch (jsonError) {
    try {
      // 第二次尝试：使用toJson进行更宽松的解析
      return toJson(jsonContent);
    } catch (json5Error) {
      try {
        // 第三次尝试：使用jsonrepair进行修复和解析
        const repairedJson = jsonrepair(jsonContent);
        return JSON.parse(repairedJson);
      } catch (jsonRepairError) {
        throw new Error(`无法解析AI返回的JSON内容: ${jsonRepairError.message}`);
      }
    }
  }
}
