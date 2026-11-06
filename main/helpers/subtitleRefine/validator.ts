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
 * 供 agent loop 回喂模型自我纠正（借鉴卡卡的 diff 反馈机制）。内容被拒绝时按真实
 * 的骨架相似度逐处列出差异（见 anchoring.describeDifferences），而不是只报第一处。
 */

import {
  MIN_ANCHOR_SIMILARITY,
  REPORT_MIN_SIMILARITY,
  anchorSegmentsToOriginal,
  describeDifferences,
} from './anchoring';
import type { DifferenceHunk, DifferenceReport } from './anchoring';
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
   * 0~1（日志/诊断用，也是不可对齐答案之间的排序依据）。骨架相似度
   * （1 = 仅标点/空白/大小写差异）；可对齐时、以及不可对齐但差异在诊断预算内
   * 时都是精确值。差异超出预算（整段被改写）时只知道真实值低于
   * REPORT_MIN_SIMILARITY，这里存公共开头 + 结尾给出的下界，仅用于排序
   * （见 similarityExact）。
   */
  similarity: number;
  /**
   * similarity 是否为精确的骨架相似度。false 时不要把数值当百分比展示，
   * 用 {@link formatSimilarity} 写成「<75%」。
   */
  similarityExact: boolean;
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

/** 差异片段的截断长度。 */
const DIFF_SNIPPET_MAX = 60;
/** 重试反馈里逐处列出的差异数上限；其余只报数量，不把整页差异塞给模型。 */
const MAX_FEEDBACK_HUNKS = 5;
const KEEP_ORIGINAL_HINT =
  'Keep the original text EXACTLY unchanged; only insert <br> between words.';

function clip(text: string): string {
  if (text.length <= DIFF_SNIPPET_MAX) return text;
  let end = DIFF_SNIPPET_MAX;
  // 不把代理对（辅助平面汉字、emoji）从中间劈开。
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

const percent = (similarity: number): string =>
  `${Math.round(similarity * 100)}%`;

/**
 * 日志里展示的相似度：精确值写成百分比；差异超出诊断预算时只知道它低于预算
 * 下限，写成「<75%」而不是编一个百分比。
 */
export function formatSimilarity(
  validation: Pick<SegmentationValidation, 'similarity' | 'similarityExact'>,
): string {
  return validation.similarityExact
    ? `${(validation.similarity * 100).toFixed(1)}%`
    : `<${percent(REPORT_MIN_SIMILARITY)}`;
}

/** 一处差异的一句话描述；原文侧用 [] 标出被改动的部分。 */
function describeHunk(hunk: DifferenceHunk): string {
  const original = clip(hunk.original);
  const produced = clip(hunk.produced);
  if (!hunk.original) {
    // 模型多出了内容：只有位置，上下文里的空白放在引号外面。
    const before = hunk.before.trimEnd();
    const after = hunk.after.trimStart();
    if (before && after) {
      return `you inserted "${produced}" between "…${before}" and "${after}…"`;
    }
    if (before) return `you inserted "${produced}" after "…${before}"`;
    if (after) return `you inserted "${produced}" before "${after}…"`;
    return `you inserted "${produced}"`;
  }
  if (!hunk.produced) {
    return `you deleted "${original}" (context: …${hunk.before}[${original}]${hunk.after}…)`;
  }
  return `"…${hunk.before}[${original}]${hunk.after}…" was changed to "[${produced}]"`;
}

/**
 * 内容被拒绝时的反馈。首行给出相似度、放行阈值（精确时还有差异处数），并带上
 * 第一处差异——降级日志只取首行；其余差异在下一行，最多 MAX_FEEDBACK_HUNKS 处。
 * 差异超出诊断预算（整段被改写，exact = false）时没有逐处比对，只指出公共开头与
 * 结尾之间的整块区域，相似度写成「低于预算下限」而不是编一个百分比。
 */
function describeModification(report: DifferenceReport): string[] {
  const { hunks } = report;
  const count = hunks.length;
  const match = report.exact
    ? `${(report.similarity * 100).toFixed(1)}%`
    : `below ${percent(REPORT_MIN_SIMILARITY)}`;
  const tally = report.exact
    ? `; ${count} ${count === 1 ? 'difference' : 'differences'}`
    : '';
  const lines = [
    `Content was modified (${match} of the letters match, ${percent(MIN_ANCHOR_SIMILARITY)} required${tally}): ${describeHunk(hunks[0])}.`,
  ];
  if (count > 1) {
    const others = hunks.slice(1, MAX_FEEDBACK_HUNKS).map(describeHunk);
    const hidden = count - Math.min(count, MAX_FEEDBACK_HUNKS);
    lines.push(
      `Other differences: ${others.join('; ')}${hidden > 0 ? `; and ${hidden} more` : ''}.`,
    );
  }
  return lines;
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
      similarityExact: true,
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
  let similarityExact = true;
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
      // 被拒绝：差异在诊断预算内就给真实相似度并逐处列出；超出预算（整段被改写）
      // 只给下界，并指出被改写的整块区域。
      const report = describeDifferences(originalText, segments);
      if (report && report.hunks.length > 0) {
        similarity = report.similarity;
        similarityExact = report.exact;
        feedbackParts.push(...describeModification(report));
      } else {
        // 任一侧没有字母 / 数字（比如模型只回了标点）：没有可比对的内容。
        similarity = 0;
        feedbackParts.push(
          'Content was modified: nothing in the answer could be matched to the original text.',
        );
      }
      feedbackParts.push(KEEP_ORIGINAL_HINT);
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
    similarityExact,
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
 *  3. 都不可对齐时，相似度更高者更好（只决定回喂与日志展示哪一次）。相似度是真实
 *     的骨架相似度；差异超出诊断预算的答案只有低于预算下限的下界，所以十处零散
 *     改词（94%）总是排在中段被整段重写（约 60%）的答案前面。
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
