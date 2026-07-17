/**
 * AI 批量翻译的对齐校验与定点补翻请求构造（纯逻辑，无 electron 依赖）。
 *
 * 背景（openspec: ai-translation-alignment）：模型会把相邻字幕合并翻译，
 * 造成译文整体滑移——条数正确但对应错行。回显锚定让模型逐条返回
 * {src: 原文回显, tr: 译文}，回显与真实原文比对即可确定性检出错位，
 * 再对错位/空值条目做带上下文的单条定点补翻。
 */

import type { Subtitle } from '../types';
import type { AnchoredTranslationResponse } from './aiResponseParser';
import { ECHO_SIMILARITY_THRESHOLD, textSimilarity } from './similarity';
import { makeBatchSchema } from '../constants/schema';

export interface BatchValidation {
  /** 通过校验的译文（id → 译文） */
  accepted: Record<string, string>;
  /** 未获得可信译文、需要定点补翻的条目 id */
  flagged: string[];
  /** 携带回显且完成比对的条目数（观测用） */
  echoChecked: number;
}

/**
 * 回显锚定校验（design D4/D5）：
 * - 条目带回显（{src,tr}）→ 回显与真实原文相似度 ≥ 阈值才采信，
 *   否则视为合并/滑移错位（条数正确也可能对应错行）。
 * - 条目为纯字符串（旧协议/自定义提示词）→ 降级为「存在且非空」校验。
 * - 缺失或空译文一律标记待修复。
 */
export function validateAnchoredBatch(
  parsed: AnchoredTranslationResponse,
  batch: Subtitle[],
  echoEnabled: boolean,
): BatchValidation {
  const accepted: Record<string, string> = {};
  const flagged: string[] = [];
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

    accepted[subtitle.id] = entry.translation;
  }

  return { accepted, flagged, echoChecked };
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
    `不要合并或拆分，不要输出任何解释：\n"${sourceText}"\n\n` +
    `只返回一个 JSON 对象：{"${subtitle.id}": "这条字幕的${targetLanguageName}译文"}`;

  return {
    prompt,
    schema: makeBatchSchema([subtitle.id], { echo: false }),
  };
}
