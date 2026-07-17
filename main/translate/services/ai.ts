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
import {
  parseAIAnchoredTranslationResponse,
  type AnchoredTranslationResponse,
} from '../utils/aiResponseParser';
import {
  buildRepairRequest,
  validateAnchoredBatch,
  REPAIR_MAX_ATTEMPTS,
} from '../utils/alignment';
import {
  BATCH_SCHEMA_MAX_PROPERTIES,
  makeBatchSchema,
} from '../constants/schema';
import {
  createTranslationBatches,
  normalizeBatchSize,
  resolveBatchConcurrency,
  runTranslationBatchesInOrder,
  type TranslationBatch,
} from '../utils/batchConcurrency';
import {
  buildGlossaryPromptBlock,
  matchGlossaryEntries,
  renderGlossarySystemPrompt,
  selectGlossaryPromptEntries,
} from '../../glossary/core';
import { logGlossaryMatches } from '../../helpers/glossaryManager';

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

interface RepairEntryParams {
  subtitle: Subtitle;
  batch: Subtitle[];
  accepted: Record<string, string>;
  translator: TranslationConfig['translator'];
  translationConfig: Record<string, any>;
  sourceLanguage: string;
  targetLanguage: string;
  targetLanguageName: string;
  signal?: AbortSignal;
}

/**
 * 单条定点补翻（design D7）：请求构造见 alignment.buildRepairRequest，
 * 此处负责执行与重试（最多 REPAIR_MAX_ATTEMPTS 次）。
 */
async function repairSubtitleEntry(
  params: RepairEntryParams,
): Promise<string | undefined> {
  const { subtitle, batch, accepted, targetLanguageName } = params;
  const { prompt: repairPrompt, schema: repairSchema } = buildRepairRequest(
    subtitle,
    batch,
    accepted,
    targetLanguageName,
  );

  for (let attempt = 0; attempt < REPAIR_MAX_ATTEMPTS; attempt++) {
    throwIfTaskCancelled();
    try {
      const responseOrigin = await params.translator(
        repairPrompt,
        params.translationConfig,
        params.sourceLanguage,
        params.targetLanguage,
        { signal: params.signal, responseJsonSchema: repairSchema },
      );
      throwIfSignalCancelled(params.signal);
      const responseText = Array.isArray(responseOrigin)
        ? responseOrigin.join('\n')
        : responseOrigin;
      const parsed = parseAIAnchoredTranslationResponse(responseText ?? '');
      const translation = parsed[subtitle.id]?.translation?.trim();
      if (translation) return translation;
    } catch (error) {
      if (isTaskCancelledError(error)) throw error;
      throwIfSignalCancelled(params.signal);
      if (isConfigurationError(error)) throw error;
      logMessage(
        `定点补翻条目 ${subtitle.id} 第 ${attempt + 1}/${REPAIR_MAX_ATTEMPTS} 次失败: ${error.message}`,
        'warning',
      );
    }
  }
  return undefined;
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
  // 回显锚定默认开启（design D4）：模型逐条回显原文，用于检测合并/滑移错位。
  const echoEnabled = provider.echoAnchoring !== false;
  const requestedBatchSize = normalizeBatchSize(
    batchSize,
    DEFAULT_BATCH_SIZE.AI,
  );
  // schema 属性数上限保护（design D8）：超限自动拆小，规避渠道 schema 复杂度限制。
  const normalizedBatchSize = Math.min(
    requestedBatchSize,
    BATCH_SCHEMA_MAX_PROPERTIES,
  );
  if (normalizedBatchSize < requestedBatchSize) {
    logMessage(
      `批量大小 ${requestedBatchSize} 超过 schema 上限，已自动降为 ${normalizedBatchSize}`,
      'warning',
    );
  }
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

    const glossaryMatches = matchGlossaryEntries(
      config.glossaryEntries || [],
      batch.map((item) => item.content.join('\n')),
    );
    const glossarySelection = selectGlossaryPromptEntries(glossaryMatches);
    const glossaryBlock = buildGlossaryPromptBlock(glossarySelection.included);
    logGlossaryMatches(
      glossarySelection.included,
      `AI 翻译批次 ${currentBatchIndex}/${totalBatches}`,
      glossarySelection.omittedCount,
    );

    // 「大面积错位 → 整批重试一次」独立于 maxRetries（design D7）
    let alignmentRetryUsed = false;

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

        if (retryCount > 0 || alignmentRetryUsed) {
          translationContent += echoEnabled
            ? '\n\n上一次响应存在错位或无法解析。请只返回一个 JSON 对象：键必须与输入字幕 ID 完全一致，每个键的值是 {"src": ..., "tr": ...}。注意：src 必须逐字复制输入中该 ID 对应的原文（保持原语言，绝对不能填译文），tr 才是译文；禁止合并或拆分条目，不要返回 markdown、解释或思考过程。'
            : '\n\n上一次响应无法解析。请只返回一个 JSON 对象，键必须是输入字幕 ID，值必须是翻译结果；不要返回 markdown、解释、注释或思考过程。';
        }

        const systemPrompt = renderGlossarySystemPrompt(
          provider.systemPrompt || defaultSystemPrompt,
          {
            sourceLanguage: sourceLanguageName,
            targetLanguage: targetLanguageName,
            content: fullContent,
          },
          glossaryBlock,
        );

        // 更新配置，保持原有的结构化输出设置
        const translationConfig = {
          ...provider,
          systemPrompt,
          // 保留原有的 useJsonMode 配置或 structuredOutput 配置
          // 如果没有配置，默认启用 JSON 模式以保持向后兼容
          useJsonMode: provider.useJsonMode !== false,
        };

        // 动态批次 schema（design D1/D2）：json_schema 渠道在解码层面锁死键集合
        const batchSchema = makeBatchSchema(
          batch.map((item) => item.id),
          { echo: echoEnabled },
        );

        logMessage(
          `AI translate batch ${currentBatchIndex}/${totalBatches} (尝试 ${retryCount + 1}/${maxRetries + 1}): \n ${translationContent}`,
          'info',
        );
        const responseOrigin = await translator(
          translationContent,
          translationConfig,
          sourceLanguage,
          targetLanguage,
          { signal: config.signal, responseJsonSchema: batchSchema },
        );
        throwIfSignalCancelled(config.signal);
        const responseText = Array.isArray(responseOrigin)
          ? responseOrigin.join('\n')
          : responseOrigin;
        logMessage(`AI response: \n ${responseText}`, 'info');

        // 解析失败视同全量错位：享受一次对齐整批重试，之后走逐条补翻兜底
        let parsedContent: AnchoredTranslationResponse;
        try {
          parsedContent = parseAIAnchoredTranslationResponse(responseText);
        } catch (parseError) {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 响应解析失败: ${parseError.message}`,
            'warning',
          );
          parsedContent = {};
        }

        const validation = validateAnchoredBatch(
          parsedContent,
          batch,
          echoEnabled,
        );

        if (validation.echoChecked > 0) {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 回显校验 ${validation.echoChecked}/${batch.length} 条，检出待修复 ${validation.flagged.length} 条`,
            'info',
          );
        }

        // 大面积错位（>1/3）→ 整批重试一次（不消耗 maxRetries 次数）
        if (
          validation.flagged.length > Math.ceil(batch.length / 3) &&
          !alignmentRetryUsed
        ) {
          alignmentRetryUsed = true;
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 错位/缺失 ${validation.flagged.length}/${batch.length} 条超过阈值，整批重试一次`,
            'warning',
          );
          continue;
        }

        // 个别错位/空值 → 单条定点补翻（design D7）
        if (validation.flagged.length > 0) {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 对 ${validation.flagged.length} 条错位/空值条目定点补翻: ${validation.flagged.join(', ')}`,
            'warning',
          );
          for (const flaggedId of validation.flagged) {
            const subtitle = batch.find((item) => item.id === flaggedId);
            if (!subtitle) continue;
            const repaired = await repairSubtitleEntry({
              subtitle,
              batch,
              accepted: validation.accepted,
              translator,
              translationConfig,
              sourceLanguage,
              targetLanguage,
              targetLanguageName,
              signal: config.signal,
            });
            if (repaired !== undefined) {
              validation.accepted[flaggedId] = repaired;
            }
          }
        }

        // 补翻后仍失败的条目单独标记，不再整批报废（design D7）
        const unresolved = batch.filter(
          (subtitle) =>
            subtitle.content.join('\n').trim() &&
            validation.accepted[subtitle.id] === undefined,
        );
        if (unresolved.length > 0) {
          logMessage(
            `批次 ${currentBatchIndex}/${totalBatches} 有 ${unresolved.length} 条补翻失败，单独标记: ${unresolved.map((s) => s.id).join(', ')}`,
            'error',
          );
        }

        batchResults = batch.map((subtitle) => ({
          id: subtitle.id,
          startEndTime: subtitle.startEndTime,
          sourceContent: subtitle.content.join('\n'),
          targetContent:
            validation.accepted[subtitle.id] !== undefined
              ? validation.accepted[subtitle.id]
              : '[翻译失败: 对齐校验与定点补翻均未成功]',
        }));

        batchSuccess = true;

        logMessage(
          `批次 ${currentBatchIndex}/${totalBatches} 翻译完成（回显校验 ${validation.echoChecked} 条，补翻 ${validation.flagged.length} 条，失败 ${unresolved.length} 条）`,
          'info',
        );
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
