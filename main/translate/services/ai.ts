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
): Promise<TranslationResult[]> {
  const { provider, sourceLanguage, targetLanguage, translator } = config;
  const results: TranslationResult[] = [];

  for (let i = 0; i < subtitles.length; i += batchSize) {
    const batch = subtitles.slice(i, i + batchSize);

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

      logMessage(`AI translate batch ${i}: \n ${translationContent}`, 'info');
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

      logMessage(`AI response: ${responseOrigin}`, 'info');
      // 通过 joson 内容，重新组装成字幕格式内容
      if (match && match[1]) {
        const jsonContent = match[1];
        try {
          // 尝试使用标准JSON解析
          const parsedContent = JSON.parse(jsonContent);
          const batchResults = batch.map((subtitle) => ({
            id: subtitle.id,
            startEndTime: subtitle.startEndTime,
            sourceContent: subtitle.content.join('\n'),
            targetContent: parsedContent[subtitle.id],
          }));
          results.push(...batchResults);
        } catch (jsonError) {
          logMessage(
            `标准JSON解析失败，尝试使用tojson: ${jsonError.message}`,
            'error',
          );
          try {
            // 使用JSON5进行更宽松的解析
            const parsedContent = toJson(jsonContent);
            const batchResults = batch.map((subtitle) => ({
              id: subtitle.id,
              startEndTime: subtitle.startEndTime,
              sourceContent: subtitle.content.join('\n'),
              targetContent: parsedContent[subtitle.id],
            }));
            results.push(...batchResults);
          } catch (json5Error) {
            logMessage(`tojson解析也失败: ${json5Error.message}`, 'error');
            throw new Error(`无法解析AI返回的JSON内容: ${json5Error.message}`);
          }
        }
      }

      // 更新翻译进度
      const progress = Math.min(
        ((i + batchSize) / subtitles.length) * 100,
        100,
      );
      if (onProgress) {
        onProgress(progress);
      }
    } catch (error) {
      logMessage(`AI batch translation error: ${error.message}`, 'error');
      throw error;
    }
  }

  return results;
}
