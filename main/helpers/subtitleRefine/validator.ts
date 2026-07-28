/**
 * 断句遍校验器（design D3）：等值比对 + 差异定位 + 逐段限长。
 *
 * 判定分两级（与降级策略配合，见 segmentationRunner）：
 *  - contentOk：规范化（去空白）后逐字等值——精确 offset 对齐（D4）的前提，硬性要求；
 *  - lengthOk：逐段限长（CJK 字数 / 拉丁词数）——软性要求：重试耗尽仍超长但 contentOk
 *    时可接受，交物理护栏（guards）在真实词时间上二次切分。
 *
 * 反馈文本为英文（与仓库既有 LLM 提示词语言一致），带差异上下文定位，
 * 供 agent loop 回喂模型自我纠正（借鉴卡卡的 diff 反馈机制）。
 */

import {
  RefineLimits,
  cjkCharCount,
  isMainlyCjk,
  latinWordCount,
  normalizeForCompare,
} from './types';

export interface LengthViolation {
  /** 段序号（1 起，反馈文本用）。 */
  index: number;
  segment: string;
  count: number;
  limit: number;
  unit: 'chars' | 'words';
}

export interface SegmentationValidation {
  /** contentOk && （限长关闭或无超长段）。 */
  ok: boolean;
  /** 规范化等值（精确对齐的前提）。 */
  contentOk: boolean;
  /** 0~1，公共前后缀占比的相似度近似（日志/诊断用）。 */
  similarity: number;
  lengthViolations: LengthViolation[];
  /** ok=false 时的回喂反馈；ok=true 为空串。 */
  feedback: string;
}

/** 差异展示的上下文与片段截断长度。 */
const DIFF_CONTEXT_CHARS = 10;
const DIFF_SNIPPET_MAX = 60;

function clip(text: string): string {
  return text.length > DIFF_SNIPPET_MAX
    ? `${text.slice(0, DIFF_SNIPPET_MAX)}…`
    : text;
}

/**
 * 基于公共前后缀的单区域差异定位：LLM 的改写通常是局部的，前后缀裁剪能把
 * 多处散点差异合并成一个可读区域，避免 O(n·m) 全量 diff 在长窗口上的开销。
 */
function locateDifference(
  original: string,
  produced: string,
): { similarity: number; message: string } {
  const lenO = original.length;
  const lenP = produced.length;
  let prefix = 0;
  const maxPrefix = Math.min(lenO, lenP);
  while (prefix < maxPrefix && original[prefix] === produced[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    original[lenO - 1 - suffix] === produced[lenP - 1 - suffix]
  ) {
    suffix += 1;
  }
  const similarity =
    lenO + lenP === 0 ? 1 : ((prefix + suffix) * 2) / (lenO + lenP);
  const origMid = original.slice(prefix, lenO - suffix);
  const prodMid = produced.slice(prefix, lenP - suffix);
  const before = original.slice(
    Math.max(0, prefix - DIFF_CONTEXT_CHARS),
    prefix,
  );
  const after = original.slice(
    lenO - suffix,
    lenO - suffix + DIFF_CONTEXT_CHARS,
  );

  let detail: string;
  if (!origMid && prodMid) {
    detail = `you inserted "${clip(prodMid)}" between "…${before}" and "${after}…"`;
  } else if (origMid && !prodMid) {
    detail = `you deleted "${clip(origMid)}" (context: …${before}[${clip(origMid)}]${after}…)`;
  } else {
    detail = `"…${before}[${clip(origMid)}]${after}…" was changed to "[${clip(prodMid)}]"`;
  }
  return { similarity, message: detail };
}

/** 逐段限长检查：限长维度随该段主导语言选择（中英夹杂窗口按段判定，D3）。 */
function checkSegmentLengths(
  segments: string[],
  limits: RefineLimits,
): LengthViolation[] {
  const violations: LengthViolation[] = [];
  segments.forEach((segment, i) => {
    const cjk = isMainlyCjk(segment);
    const count = cjk ? cjkCharCount(segment) : latinWordCount(segment);
    const limit = cjk ? limits.cjkCharLimit : limits.latinWordLimit;
    if (count > limit) {
      violations.push({
        index: i + 1,
        segment,
        count,
        limit,
        unit: cjk ? 'chars' : 'words',
      });
    }
  });
  return violations;
}

export function validateSegmentation(
  originalText: string,
  segments: string[],
  limits: RefineLimits,
): SegmentationValidation {
  if (segments.length === 0) {
    return {
      ok: false,
      contentOk: false,
      similarity: 0,
      lengthViolations: [],
      feedback:
        'No segments found. Output the COMPLETE original text with <br> inserted between segments.',
    };
  }

  const normOriginal = normalizeForCompare(originalText);
  const normProduced = normalizeForCompare(segments.join(''));
  const contentOk = normOriginal === normProduced;

  let similarity = 1;
  const feedbackParts: string[] = [];
  if (!contentOk) {
    const diff = locateDifference(normOriginal, normProduced);
    similarity = diff.similarity;
    feedbackParts.push(
      `Content was modified (similarity ${(diff.similarity * 100).toFixed(1)}%): ${diff.message}.`,
      'Keep the original text EXACTLY unchanged; only insert <br> between words.',
    );
  }

  const lengthViolations = limits.lengthCheckEnabled
    ? checkSegmentLengths(segments, limits)
    : [];
  if (lengthViolations.length > 0) {
    const lines = lengthViolations
      .slice(0, 5)
      .map(
        (v) =>
          `- Segment ${v.index} "${clip(v.segment)}": ${v.count} ${v.unit} > ${v.limit} limit`,
      );
    feedbackParts.push(
      `Length violations:\n${lines.join('\n')}`,
      'Split these long segments further with <br>, then output the COMPLETE text with ALL segments (not just the fixed ones).',
    );
  }

  const ok = contentOk && lengthViolations.length === 0;
  return {
    ok,
    contentOk,
    similarity,
    lengthViolations,
    feedback: ok ? '' : feedbackParts.join('\n'),
  };
}
