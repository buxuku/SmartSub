/**
 * 断句遍校验器（design D3）：等值比对 + 差异定位 + 逐段限长。
 *
 * 判定分两级（与降级策略配合，见 segmentationRunner）：
 *  - contentOk：内容可对齐——规范化（去空白）后逐字等值，或偏差在容差内（标点 /
 *    大小写 / 全半角 / 少量改字，见 anchoring.ts；此时按模型断点把原文重新切开）。
 *    这是精确 offset 对齐（D4）的前提，硬性要求；
 *  - lengthOk：逐段限长（CJK 字数 / 拉丁词数）——软性要求：重试耗尽仍超长但 contentOk
 *    时可接受，交物理护栏（guards）在真实词时间上二次切分。
 *
 * 反馈文本为英文（与仓库既有 LLM 提示词语言一致），带差异上下文定位，
 * 供 agent loop 回喂模型自我纠正（借鉴卡卡的 diff 反馈机制）。
 */

import { anchorSegmentsToOriginal } from './anchoring';
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
  /** 内容可对齐：规范化等值，或偏差在容差内（见 tolerated）。 */
  contentOk: boolean;
  /**
   * 0~1（日志/诊断用）。可对齐时是骨架相似度（1 = 仅标点/空白/大小写差异）；
   * 不可对齐时是公共前后缀占比的粗略近似。
   */
  similarity: number;
  lengthViolations: LengthViolation[];
  /** ok=false 时的回喂反馈；ok=true 为空串。 */
  feedback: string;
  /**
   * 交给时间轴对齐的分段。严格等值时就是模型的分段；偏差在容差内时是按模型
   * 断点在**原文**上重新切出的分段（保留原文的标点与大小写）。
   */
  alignSegments: string[];
  /** 模型输出与原文有偏差（标点/大小写/全半角/少量改字），但在容差内放行。 */
  tolerated: boolean;
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
      alignSegments: segments,
      tolerated: false,
    };
  }

  const normOriginal = normalizeForCompare(originalText);
  const normProduced = normalizeForCompare(segments.join(''));
  let contentOk = normOriginal === normProduced;
  let alignSegments = segments;
  let tolerated = false;

  let similarity = 1;
  const feedbackParts: string[] = [];
  if (!contentOk) {
    // 模型几乎从不逐字复制：标点、大小写、全半角，偶尔还有个别字会变。断句只需要
    // 它的断点位置，所以偏差在容差内时按断点把**原文**重新切开——最终字幕文字
    // 仍是原文，时间轴仍是真实词时间（design D3/D4：容忍轻微差异，diff 对齐兜底）。
    const anchored = anchorSegmentsToOriginal(originalText, segments);
    if (anchored) {
      contentOk = true;
      tolerated = true;
      alignSegments = anchored.segments;
      similarity = anchored.similarity;
    } else {
      const diff = locateDifference(normOriginal, normProduced);
      similarity = diff.similarity;
      feedbackParts.push(
        `Content was modified (similarity ${(diff.similarity * 100).toFixed(1)}%): ${diff.message}.`,
        'Keep the original text EXACTLY unchanged; only insert <br> between words.',
      );
    }
  }

  const lengthViolations = limits.lengthCheckEnabled
    ? checkSegmentLengths(alignSegments, limits)
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
    alignSegments,
    tolerated,
  };
}

/** 超长段超出上限的总量（越小越接近合规）。 */
function lengthOvershoot(validation: SegmentationValidation): number {
  return validation.lengthViolations.reduce(
    (sum, violation) => sum + (violation.count - violation.limit),
    0,
  );
}

/**
 * 比较两次校验结果的优劣：>0 表示 a 更好，<0 表示 b 更好，0 打平。
 *
 * 反馈重试循环据此保留「最好的一次」而不是「最后一次」——重试轮的输出可能比
 * 首轮更差（改坏文本、截断），不应让一次退步把已有的可用答案扔掉（#507）。
 *  1. 内容可对齐（contentOk）的永远优于不可对齐的：后者对断句毫无用处；
 *  2. 都可对齐时，超长段更少者更好，其次是超长总量更小者（软约束，由护栏兜底），
 *     再其次是严格等值优于容差放行（后者在改动处的断点位置有少许不确定）；
 *  3. 都不可对齐时，相似度更高者更好（只决定回喂与日志展示哪一次）。
 */
export function compareValidations(
  a: SegmentationValidation,
  b: SegmentationValidation,
): number {
  if (a.contentOk !== b.contentOk) return a.contentOk ? 1 : -1;
  if (a.contentOk) {
    const byCount = b.lengthViolations.length - a.lengthViolations.length;
    if (byCount !== 0) return byCount;
    const byOvershoot = lengthOvershoot(b) - lengthOvershoot(a);
    if (byOvershoot !== 0) return byOvershoot;
    if (a.tolerated !== b.tolerated) return a.tolerated ? -1 : 1;
    return 0;
  }
  return a.similarity - b.similarity;
}
