/**
 * 字幕批量校正共享服务（openspec: add-ai-subtitle-refine D7）。
 *
 * 同一套「分批 → LLM → 解析校验 → 重试 → 部分失败保留原文」实现服务两个入口：
 *  - 校对台「AI 润色」（ipcProofreadHandlers.batchOptimizeSubtitles）——protocol
 *    'legacyMap'：请求/响应格式、默认提示词、逐项提取规则与抽取前逐字一致，
 *    保证既有交互与用户缓存的自定义提示词行为不变；
 *  - 管线「AI 字幕校正」（遍 B，subtitleRefine/correctionRunner）——protocol
 *    'anchored'：回显锚定（{src,tr}，复用翻译框架的解析/校验）+ 批次 schema +
 *    错位整批重试一次 + 术语表与低置信词注入；失败/错位条目保留原文。
 *
 * 服务自身不触碰 UI/IPC：进度经 onBatchProgress 回调，取消经 AbortSignal，
 * 返回 { results, cancelled, processedCount } 由调用方映射到各自的响应形态。
 */

import { logMessage } from './storeManager';
import {
  isTaskCancelledError,
  throwIfSignalCancelled,
  waitForTaskDelay,
} from './taskContext';
import type {
  Provider,
  Subtitle,
  TranslatorFunction,
} from '../translate/types';
import { parseAIAnchoredTranslationResponse } from '../translate/utils/aiResponseParser';
import { validateAnchoredBatch } from '../translate/utils/alignment';
import { BATCH_SCHEMA_MAX_PROPERTIES } from '../translate/constants/schema';
import {
  buildGlossaryPromptBlock,
  injectGlossaryPromptBlock,
  matchGlossaryEntries,
  selectGlossaryPromptEntries,
} from '../glossary/core';
import {
  getActiveGlossaryResolution,
  logGlossaryConflicts,
  logGlossaryMatches,
} from './glossaryManager';
import { filterSuspectWordsForBatch } from './subtitleRefine/wordSources';

export interface CorrectionItem {
  id: string;
  /** 调用方自用的序号（校对台 UI 定位），服务原样带回。 */
  index?: number;
  source: string;
  /** 优化前文本（translation 模式=当前译文；transcript 模式=原文本身）。 */
  target?: string;
}

export type CorrectionProtocol = 'legacyMap' | 'anchored';

export interface CorrectionItemOutcome {
  id: string;
  index?: number;
  source: string;
  originalTarget: string;
  /** 最终文本：成功=校正结果；skipped/error=原文（保留原文语义）。 */
  corrected: string;
  status: 'success' | 'error' | 'skipped';
  error?: string;
}

export interface CorrectionParams {
  items: CorrectionItem[];
  provider: Provider;
  translator: TranslatorFunction;
  mode: 'transcript' | 'translation';
  protocol: CorrectionProtocol;
  sourceLanguage: string;
  targetLanguage: string;
  /** legacyMap：用户自定义提示词模板（{{sourceLanguage}}/{{targetLanguage}} 变量）。 */
  customPrompt?: string;
  batchSize?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  useGlossary?: boolean;
  /** 术语冲突/命中日志的场景标签（如「校对页批量 AI 优化」/「AI 字幕校正」）。 */
  glossaryLabel?: string;
  /** anchored：低置信词标注（whisper token p 低于阈值的词，辅助定点修正）。 */
  suspectWords?: string[];
  /** 每批开始前回调（与既有校对台进度事件语义一致：processedCount 为已完成数）。 */
  onBatchProgress?: (info: {
    processedCount: number;
    totalCount: number;
    currentBatch: number;
    totalBatches: number;
  }) => void;
}

export interface CorrectionRunResult {
  results: CorrectionItemOutcome[];
  cancelled: boolean;
  processedCount: number;
}

/** 校对台批量优化的默认提示词（自 ipcProofreadHandlers 原样迁移，行为不变）。 */
const LEGACY_DEFAULT_BATCH_PROMPT = `You are a professional subtitle translator and proofreader. Optimize the following subtitle translations.

For each subtitle, improve the translation to:
1. More accurately convey the original meaning
2. Use natural and fluent expressions
3. Be appropriate for subtitle display (concise but complete)
4. Maintain the original tone and style

Input format: JSON object with subtitle IDs as keys and {source, target} as values
Output format: JSON object with the same IDs and optimized translations as values

IMPORTANT: You MUST return a valid JSON object. Do NOT include any text before or after the JSON. Only output the JSON object.`;

/** anchored 校正的 system prompt（约束借鉴 VideoCaptioner optimize prompt：修错保义）。 */
const ANCHORED_CORRECTION_SYSTEM_PROMPT = `You are a professional subtitle proofreader for speech-recognition transcripts.

<rules>
1. Fix misrecognized words and homophones based on context
2. Remove hesitation filler words (um, uh, 呃, 嗯, 啊) and non-verbal markers
3. Normalize punctuation and capitalization; write math formulas and code snippets properly
4. Preserve the original wording, structure and language; do NOT paraphrase, translate, merge or split entries
5. If an entry needs no fix, return it unchanged
</rules>

Output format: return ONLY a valid JSON object. Keys must be exactly the input subtitle IDs. Each value is an object {"src": <exact copy of the input text>, "tr": <the corrected text>}. No markdown, no explanations.`;

/** anchored 批次 schema：与 makeBatchSchema 同构（{src,tr}），description 换成校正语义。 */
function makeCorrectionSchema(ids: string[]): Record<string, unknown> {
  const valueSchema = {
    type: 'object',
    properties: {
      src: {
        type: 'string',
        description: '逐字复制该条字幕的输入原文，禁止改动',
      },
      tr: {
        type: 'string',
        description: '该条字幕的校正结果（无需修改时与原文一致）',
      },
    },
    required: ['src', 'tr'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: Object.fromEntries(ids.map((id) => [id, valueSchema])),
    required: [...ids],
    additionalProperties: false,
  };
}

/** legacyMap 响应解析（自 ipcProofreadHandlers.parseOptimizationResponse 原样迁移）。 */
export function parseOptimizationResponse(
  response: string,
): Record<string, any> | null {
  const cleanResponse = response
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();

  try {
    return JSON.parse(cleanResponse);
  } catch {}

  const jsonMatch = cleanResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }

  const objectMatch = cleanResponse.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      try {
        const { jsonrepair } = require('jsonrepair');
        const repaired = jsonrepair(objectMatch[0]);
        return JSON.parse(repaired);
      } catch {}
    }
  }

  return null;
}

/** 低置信词提示块（anchored）：去重限量，避免撑爆提示词。 */
function buildSuspectWordsBlock(suspectWords?: string[]): string {
  const unique = Array.from(
    new Set((suspectWords ?? []).map((w) => w.trim()).filter(Boolean)),
  ).slice(0, 40);
  if (unique.length === 0) return '';
  return `\n\nThe following words were transcribed with LOW confidence and are likely misrecognized — pay special attention to them: ${unique.join(', ')}`;
}

export async function runSubtitleCorrection(
  params: CorrectionParams,
): Promise<CorrectionRunResult> {
  const {
    items,
    provider,
    translator,
    mode,
    protocol,
    sourceLanguage,
    targetLanguage,
    customPrompt,
    signal,
    onBatchProgress,
  } = params;
  const batchSize = Math.max(
    1,
    Math.min(Math.floor(params.batchSize || 5), BATCH_SCHEMA_MAX_PROPERTIES),
  );
  const maxRetries = Math.max(0, params.maxRetries ?? 2);
  const echoEnabled = provider.echoAnchoring !== false;

  // 术语表：调用方决定是否启用（校对台仅 translation 模式；管线校正恒开）。
  let glossaryEntries: Parameters<typeof matchGlossaryEntries>[0] = [];
  if (params.useGlossary) {
    const resolution = getActiveGlossaryResolution();
    if (resolution) {
      logGlossaryConflicts(
        resolution.conflicts,
        params.glossaryLabel || '字幕校正',
      );
      glossaryEntries = resolution.entries;
    }
  }

  // anchored（转写校正）的术语参考：**只注入原文标准写法列表，不含译文**。
  // 翻译术语块（buildGlossaryPromptBlock）会明确指示模型"使用指定译文"，用在
  // 校正上会把原文改写成译文（评审发现）。校正需要的只是专有名词的正确拼写，
  // 且不做逐批命中匹配——误听变体（如「库伯内提斯」）不会字面命中「Kubernetes」，
  // 全量参考列表（限量去重）才能让模型识别近似误听。
  const correctionTerms =
    protocol === 'anchored'
      ? Array.from(
          new Set(
            glossaryEntries
              .map((entry) => String(entry.source ?? '').trim())
              .filter(Boolean),
          ),
        ).slice(0, 50)
      : [];
  const correctionTermsBlock = correctionTerms.length
    ? `# Reference terminology (canonical spellings)
Proper nouns that may appear in this content. If an entry contains a misrecognized variant of one of these, correct it to the EXACT spelling listed below. Keep each subtitle in its original language — these are canonical spellings, NOT translations:
${correctionTerms.map((term) => `- ${term}`).join('\n')}`
    : '';
  if (correctionTerms.length > 0) {
    logMessage(
      `${params.glossaryLabel || '字幕校正'}: 注入 ${correctionTerms.length} 条术语原文标准写法（不含译文）`,
      'info',
    );
  }

  const results: CorrectionItemOutcome[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);
  let processedCount = 0;
  let cancelled = false;

  const pushOutcome = (
    item: CorrectionItem,
    corrected: string,
    status: CorrectionItemOutcome['status'],
    error?: string,
  ) => {
    results.push({
      id: item.id,
      index: item.index,
      source: item.source,
      originalTarget: item.target ?? '',
      corrected,
      status,
      ...(error ? { error } : {}),
    });
  };

  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const batch = items.slice(i, i + batchSize);
    const currentBatch = Math.floor(i / batchSize) + 1;

    onBatchProgress?.({
      processedCount,
      totalCount: items.length,
      currentBatch,
      totalBatches,
    });

    // 逐批术语命中匹配仅用于 legacyMap（校对台翻译优化：原文→译文映射语义正确）；
    // anchored 校正使用上方预计算的「原文标准写法」参考块。
    let glossaryBlock = '';
    if (protocol === 'legacyMap') {
      const glossaryMatches = matchGlossaryEntries(
        glossaryEntries,
        batch.map((item) => item.source),
      );
      const glossarySelection = selectGlossaryPromptEntries(glossaryMatches);
      glossaryBlock = buildGlossaryPromptBlock(glossarySelection.included);
      logGlossaryMatches(
        glossarySelection.included,
        `${params.glossaryLabel || '字幕校正'} ${currentBatch}/${totalBatches}`,
        glossarySelection.omittedCount,
      );
    }

    let retryCount = 0;
    let batchDone = false;
    // anchored：大面积错位的整批重试独立于 maxRetries（对齐翻译框架 D7）。
    let alignmentRetryUsed = false;

    while (!batchDone && retryCount <= maxRetries) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        if (protocol === 'legacyMap') {
          // ---- 校对台既有协议（行为保持不变） ----
          const batchInput: Record<string, { source: string; target: string }> =
            {};
          batch.forEach((item) => {
            batchInput[item.id] = {
              source: item.source,
              target: item.target || '',
            };
          });

          let optimizePrompt = customPrompt || LEGACY_DEFAULT_BATCH_PROMPT;
          optimizePrompt = optimizePrompt
            .replace(/\{\{sourceLanguage\}\}/g, sourceLanguage)
            .replace(/\{\{targetLanguage\}\}/g, targetLanguage);
          const fullPrompt = `${optimizePrompt}\n\nSubtitles to optimize:\n${JSON.stringify(batchInput, null, 2)}`;

          const legacyProvider = {
            ...provider,
            systemPrompt: injectGlossaryPromptBlock(
              'You are a professional subtitle optimizer. Output ONLY valid JSON. No explanations, no markdown, just the JSON object.',
              glossaryBlock,
            ),
            useJsonMode: true,
            structuredOutput: 'disabled' as const,
          };

          logMessage(
            `Correction batch ${currentBatch}/${totalBatches} attempt ${retryCount + 1}/${maxRetries + 1} (legacyMap, ${mode})`,
            'info',
          );
          const response = await translator(
            fullPrompt,
            legacyProvider,
            sourceLanguage,
            targetLanguage,
            { signal },
          );
          throwIfSignalCancelled(signal);
          const responseText = Array.isArray(response)
            ? response.join('\n')
            : response;
          logMessage(
            `Correction batch ${currentBatch} response: ${responseText}`,
            'info',
          );

          const parsedResponse = parseOptimizationResponse(responseText ?? '');
          if (!parsedResponse || typeof parsedResponse !== 'object') {
            throw new Error('无法解析 AI 响应');
          }
          batch.forEach((item) => {
            const optimized = parsedResponse[item.id];
            if (optimized !== undefined) {
              pushOutcome(
                item,
                typeof optimized === 'string'
                  ? optimized
                  : optimized?.target ||
                      optimized?.translation ||
                      String(optimized),
                'success',
              );
            } else {
              pushOutcome(
                item,
                item.target ?? '',
                'skipped',
                '未在响应中找到对应结果',
              );
            }
          });
          processedCount += batch.length;
          batchDone = true;
        } else {
          // ---- anchored 协议（管线遍 B）：回显锚定 + schema + 错位整批重试 ----
          const batchJson: Record<string, string> = {};
          batch.forEach((item) => {
            batchJson[item.id] = item.source;
          });
          let userPrompt = `Proofread the following ASR subtitle entries. Return the same JSON keys with {"src": exact original, "tr": corrected text}:\n${JSON.stringify(batchJson, null, 2)}${buildSuspectWordsBlock(
            filterSuspectWordsForBatch(
              params.suspectWords,
              batch.map((item) => item.source),
            ),
          )}`;
          if (alignmentRetryUsed || retryCount > 0) {
            userPrompt +=
              '\n\nYour previous response was misaligned or unparsable. Return ONLY a JSON object whose keys exactly match the input IDs; each value must be {"src": exact copy of that entry\'s original text, "tr": corrected text}. Do NOT merge or split entries.';
          }

          const anchoredProvider = {
            ...provider,
            systemPrompt: injectGlossaryPromptBlock(
              ANCHORED_CORRECTION_SYSTEM_PROMPT,
              correctionTermsBlock,
            ),
            useJsonMode: provider.useJsonMode !== false,
          };
          const schema = makeCorrectionSchema(batch.map((item) => item.id));

          logMessage(
            `Correction batch ${currentBatch}/${totalBatches} attempt ${retryCount + 1}/${maxRetries + 1} (anchored)`,
            'info',
          );
          const response = await translator(
            userPrompt,
            anchoredProvider,
            sourceLanguage,
            targetLanguage,
            { signal, responseJsonSchema: schema },
          );
          throwIfSignalCancelled(signal);
          const responseText = Array.isArray(response)
            ? response.join('\n')
            : String(response ?? '');

          let parsed;
          try {
            parsed = parseAIAnchoredTranslationResponse(responseText);
          } catch (parseError) {
            logMessage(
              `Correction batch ${currentBatch} parse failed: ${
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError)
              }`,
              'warning',
            );
            parsed = {};
          }

          const asSubtitles: Subtitle[] = batch.map((item) => ({
            id: item.id,
            startEndTime: '',
            content: [item.source],
          }));
          const validation = validateAnchoredBatch(
            parsed,
            asSubtitles,
            echoEnabled,
          );

          // 大面积错位（>1/3）→ 整批重试一次（不消耗 maxRetries）。
          if (
            validation.flagged.length > Math.ceil(batch.length / 3) &&
            !alignmentRetryUsed
          ) {
            alignmentRetryUsed = true;
            logMessage(
              `Correction batch ${currentBatch} misaligned ${validation.flagged.length}/${batch.length}, full-batch retry once`,
              'warning',
            );
            continue;
          }

          batch.forEach((item) => {
            const accepted = validation.accepted[item.id];
            if (accepted !== undefined && accepted.trim()) {
              pushOutcome(item, accepted, 'success');
            } else {
              // 错位/空值条目保留原文（spec: 失败保留原文，不做定点重写）。
              pushOutcome(
                item,
                item.source,
                'skipped',
                '锚定校验未通过，保留原文',
              );
            }
          });
          processedCount += batch.length;
          batchDone = true;
        }
      } catch (error) {
        if (isTaskCancelledError(error) || signal?.aborted) {
          cancelled = true;
          break;
        }
        retryCount += 1;
        if (retryCount <= maxRetries) {
          logMessage(
            `Correction batch ${currentBatch} failed, retry ${retryCount}/${maxRetries}: ${error}`,
            'warning',
          );
          try {
            await waitForTaskDelay(1000 * retryCount, signal);
          } catch (delayError) {
            if (isTaskCancelledError(delayError)) {
              cancelled = true;
              break;
            }
            throw delayError;
          }
        } else {
          logMessage(
            `Correction batch ${currentBatch} failed after ${maxRetries} retries: ${error}`,
            'error',
          );
          batch.forEach((item) => {
            pushOutcome(
              item,
              protocol === 'anchored' ? item.source : (item.target ?? ''),
              'error',
              String(error),
            );
          });
          processedCount += batch.length;
          batchDone = true;
        }
      }
    }
    if (cancelled) break;
  }

  return { results, cancelled, processedCount };
}
