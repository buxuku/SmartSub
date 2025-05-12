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

export async function handleAISingleTranslation(
  subtitle: Subtitle,
  config: TranslationConfig,
): Promise<TranslationResult> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const sourceContent = subtitle.content.join('\n');

  try {
    const translationContent = provider.prompt
      ? renderTemplate(provider.prompt, {
          sourceLanguage,
          targetLanguage,
          content: sourceContent,
        })
      : sourceContent;

    const translationConfig = {
      ...provider,
      systemPrompt: provider.systemPrompt,
    };
    logMessage(`AI translate single: \n ${translationContent}`, 'info');
    let targetContent = await translator(
      translationContent,
      translationConfig,
      sourceLanguage,
      targetLanguage,
    );
    logMessage(`AI response: \n ${targetContent}`, 'info');
    targetContent = targetContent.replace(THINK_TAG_REGEX, '').trim();

    return {
      id: subtitle.id,
      startEndTime: subtitle.startEndTime,
      sourceContent,
      targetContent: targetContent.trim(),
    };
  } catch (error) {
    logMessage(`Single translation error: ${error.message}`, 'error');
    throw error;
  }
}

export async function handleAIBatchTranslation(
  subtitles: Subtitle[],
  config: TranslationConfig,
  batchSize: number = DEFAULT_BATCH_SIZE.AI,
  onProgress?: (progress: number) => void,
  onTranslationResult?: (result: TranslationResult) => Promise<void>,
  maxRetries: number = 3,
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
        let jsonContent = {};
        batch.forEach((item) => {
          jsonContent[item.id] = item.content.join('\n');
        });
        const fullContent = `\`\`\`json\n${JSON.stringify(
          jsonContent,
          null,
          2,
        )}\n\`\`\``;
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

        const translationConfig = {
          ...provider,
          systemPrompt,
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

        // 通过 json 内容，重新组装成字幕格式内容
        if (match && match[1]) {
          const jsonContent = match[1];
          let parsedContent = null;
          let parseSuccessful = false;

          try {
            // 第一次尝试：使用标准JSON解析
            parsedContent = JSON.parse(jsonContent);
            parseSuccessful = true;
            logMessage(`标准JSON解析成功`, 'info');
          } catch (jsonError) {
            logMessage(
              `标准JSON解析失败，尝试使用toJson: ${jsonError.message}`,
              'error',
            );

            try {
              // 第二次尝试：使用toJson进行更宽松的解析
              parsedContent = toJson(jsonContent);
              parseSuccessful = true;
              logMessage(`toJson解析成功`, 'info');
            } catch (json5Error) {
              logMessage(
                `toJson解析失败，尝试使用jsonrepair: ${json5Error.message}`,
                'error',
              );

              try {
                // 第三次尝试：使用jsonrepair进行修复和解析
                const repairedJson = jsonrepair(jsonContent);
                parsedContent = JSON.parse(repairedJson);
                parseSuccessful = true;
                logMessage(`jsonrepair解析成功`, 'info');
              } catch (jsonRepairError) {
                logMessage(
                  `jsonrepair解析也失败: ${jsonRepairError.message}`,
                  'error',
                );
                throw new Error(
                  `无法解析AI返回的JSON内容: ${jsonRepairError.message}`,
                );
              }
            }
          }

          if (parseSuccessful && parsedContent) {
            // 获取parsedContent的所有值，转换为数组
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
              for (const result of batchResults) {
                await onTranslationResult(result);
              }
            }

            results.push(...batchResults);
            batchSuccess = true;
          }
        } else {
          throw new Error('Invalid response format: No JSON content found');
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
            for (const result of failedResults) {
              await onTranslationResult(result);
            }
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
