/**
 * AI 批量翻译的对齐校验与定点补翻请求构造（纯逻辑，无 electron 依赖）。
 *
 * 背景（openspec: ai-translation-alignment）：模型会把相邻字幕合并翻译，
 * 造成译文整体滑移——条数正确但对应错行。回显锚定让模型逐条返回
 * {src: 原文回显, tr: 译文}，回显与真实原文比对即可确定性检出错位，
 * 再对错位、空值或疑似未翻译条目做带上下文的单条定点补翻。
 */

import type { Subtitle } from '../types';
import type { AnchoredTranslationResponse } from './aiResponseParser';
import { ECHO_SIMILARITY_THRESHOLD, textSimilarity } from './similarity';
import { makeBatchSchema } from '../constants/schema';
import {
  classifyUntranslatedEvidence,
  isExactSourceCopyCandidate,
} from './untranslated';

export interface BatchValidation {
  /** 通过校验的译文（id → 译文） */
  accepted: Record<string, string>;
  /** 未获得可信译文、需要定点补翻的条目 id */
  flagged: string[];
  /** 携带回显且完成比对的条目数（观测用） */
  echoChecked: number;
  /** 译文疑似仍为原文的条目 id */
  untranslated: string[];
  /** 由批次群体证据升级为待补翻的精确复制条目 id */
  promotedExactCopies: string[];
  /** 仅记录、不单独送修的同文字/标题式弱证据条目 id */
  weakUntranslated: string[];
}

export interface BatchValidationOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
}

/** 至少两条强证据，避免一个偶发复制结果放大到整个批次。 */
export const BATCH_COPY_MIN_STRONG_EVIDENCE = 2;

/** 精确表达“超过三分之一”，避免 ceil 后再用 > 导致 4/10 被漏掉。 */
export function exceedsOneThird(count: number, total: number): boolean {
  return total > 0 && count > 0 && count * 3 > total;
}

export function hasStrongBatchCopyEvidence(
  strongCopyCount: number,
  batchSize: number,
): boolean {
  return (
    strongCopyCount >= BATCH_COPY_MIN_STRONG_EVIDENCE &&
    exceedsOneThird(strongCopyCount, batchSize)
  );
}

/**
 * 回显锚定校验（design D4/D5）：
 * - 条目带回显（{src,tr}）→ 回显与真实原文相似度 ≥ 阈值才采信，
 *   否则视为合并/滑移错位（条数正确也可能对应错行）。
 * - 无论回显或纯字符串协议，只要目标语言明确且源语言未知或与目标不同，
 *   都会拒绝有强证据表明直接复制原文的译文。
 * - 缺失或空译文一律标记待修复。
 */
export function validateAnchoredBatch(
  parsed: AnchoredTranslationResponse,
  batch: Subtitle[],
  echoEnabled: boolean,
  options: BatchValidationOptions = {},
): BatchValidation {
  const accepted: Record<string, string> = {};
  const flagged: string[] = [];
  const untranslated: string[] = [];
  const strongUntranslated: string[] = [];
  const exactCopyCandidates: string[] = [];
  const promotedExactCopies: string[] = [];
  const weakUntranslated: string[] = [];
  let echoChecked = 0;

  for (const subtitle of batch) {
    const sourceText = subtitle.content.join('\n');
    const entry = parsed[subtitle.id];

    // 空原文条目直接透传，避免把「无内容」误判为翻译失败
    if (!sourceText.trim()) {
      accepted[subtitle.id] = entry?.translation ?? '';
      continue;
    }

    if (!entry || !entry.translation.trim()) {
      flagged.push(subtitle.id);
      continue;
    }

    if (echoEnabled && entry.hasEcho) {
      echoChecked++;
      const similarity = textSimilarity(entry.srcEcho ?? '', sourceText);
      if (similarity < ECHO_SIMILARITY_THRESHOLD) {
        flagged.push(subtitle.id);
        continue;
      }
    }

    const evidence = classifyUntranslatedEvidence(
      sourceText,
      entry.translation,
      options.sourceLanguage,
      options.targetLanguage,
    );
    if (evidence === 'strong') {
      flagged.push(subtitle.id);
      untranslated.push(subtitle.id);
      strongUntranslated.push(subtitle.id);
      continue;
    }
    if (evidence === 'weak') weakUntranslated.push(subtitle.id);

    accepted[subtitle.id] = entry.translation;
    if (
      isExactSourceCopyCandidate(
        sourceText,
        entry.translation,
        options.sourceLanguage,
        options.targetLanguage,
      )
    ) {
      exactCopyCandidates.push(subtitle.id);
    }
  }

  if (hasStrongBatchCopyEvidence(strongUntranslated.length, batch.length)) {
    for (const id of exactCopyCandidates) {
      delete accepted[id];
      const weakIndex = weakUntranslated.indexOf(id);
      if (weakIndex >= 0) weakUntranslated.splice(weakIndex, 1);
      flagged.push(id);
      untranslated.push(id);
      promotedExactCopies.push(id);
    }

    const batchOrder = new Map(
      batch.map((subtitle, index) => [subtitle.id, index]),
    );
    const byBatchOrder = (left: string, right: string) =>
      (batchOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (batchOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
    flagged.sort(byBatchOrder);
    untranslated.sort(byBatchOrder);
  }

  return {
    accepted,
    flagged,
    echoChecked,
    untranslated,
    promotedExactCopies,
    weakUntranslated,
  };
}

export const REPAIR_MAX_ATTEMPTS = 3;
export const REPAIR_CONTEXT_RADIUS = 2;

export interface RepairRequest {
  prompt: string;
  schema: Record<string, unknown>;
}

/**
 * 构造单条定点补翻请求（design D7）：
 * 携带前后 ±2 条原文与已译文作语境、单键 schema 锁定输出。
 * 提示词要点（实测教训）：上下文必须标注「仅供参考勿翻译」、
 * 目标句单独引用，否则小模型会翻错对象。
 */
export function buildRepairRequest(
  subtitle: Subtitle,
  batch: Subtitle[],
  accepted: Record<string, string>,
  targetLanguageName: string,
): RepairRequest {
  const index = batch.findIndex((item) => item.id === subtitle.id);
  const contextLines: string[] = [];
  const start = Math.max(0, index - REPAIR_CONTEXT_RADIUS);
  const end = Math.min(batch.length - 1, index + REPAIR_CONTEXT_RADIUS);
  for (let j = start; j <= end; j++) {
    if (j === index) continue;
    const neighbor = batch[j];
    const neighborSource = neighbor.content.join('\n');
    if (!neighborSource.trim()) continue;
    const neighborTranslation = accepted[neighbor.id];
    contextLines.push(
      `- ${neighborSource}${neighborTranslation ? ` => ${neighborTranslation}` : ''}`,
    );
  }

  const sourceText = subtitle.content.join('\n');
  const contextBlock = contextLines.length
    ? `以下是相邻字幕的原文与已完成的译文（仅供参考语境与术语，请勿翻译它们）：\n${contextLines.join('\n')}\n\n`
    : '';
  const prompt =
    `${contextBlock}现在请只翻译下面这一条字幕，译为${targetLanguageName}。` +
    `不要合并或拆分，不要输出任何解释；不要把原文直接复制为译文（数字、网址、专名等无需翻译内容除外）：\n"${sourceText}"\n\n` +
    `只返回一个 JSON 对象：{"${subtitle.id}": "这条字幕的${targetLanguageName}译文"}`;

  return {
    prompt,
    schema: makeBatchSchema([subtitle.id], { echo: false }),
  };
}
