/**
 * 把模型断句结果的断点重锚定回原文（design D3/D4：容忍轻微差异，diff 对齐兜底）。
 *
 * 断句只需要模型给出**断点位置**，并不需要它逐字复制。可实际上模型几乎不会逐字
 * 复制：标点被规范化、大小写或全半角被改、偶尔个别字被"纠正"。严格等值校验会
 * 因此整窗拒绝，并在重试里一再得到同样的偏差（#507）。
 *
 * 做法：两侧各抽取"骨架"（字母 / 数字 / 组合符号，抹平大小写与全半角，标点和
 * 空白不算内容），用最小编辑距离对齐两条骨架，把模型的每个断点换算成原文位置，
 * 再**切原文**——最终字幕文字永远来自原始转写，时间轴仍是真实词时间。
 * 编辑量超过容差（默认相似度 < 0.96，即竞品参照的 difflib 阈值）视为模型改写了
 * 内容，返回 null，由调用方走原有的拒绝与反馈重试。
 *
 * 被拒绝的答案同样要说清楚「差在哪」：describeDifferences 复用同一套骨架比对，
 * 给出精确的相似度和逐处差异（#507 后续——公共前后缀估算会把零散改词读成 4%，
 * 并且只能指出第一处）。
 */

import { diffArrays } from 'diff';

/** 骨架相似度下限：2·匹配数 / 两侧骨架长度之和。 */
export const MIN_ANCHOR_SIMILARITY = 0.96;

/**
 * 诊断（日志 / 重试反馈）用的相似度下限，比放行阈值宽得多。被拒绝的答案只要骨架
 * 编辑量在这个预算内，就给出精确的相似度并逐处定位；超出说明整段被改写，再逐字
 * 比对既耗时又无助于纠正，只报告「低于该值」。
 */
export const REPORT_MIN_SIMILARITY = 0.75;

export interface AnchorResult {
  /** 按模型断点在原文上切出的分段（保留原文的标点与大小写；已 trim，无空段）。 */
  segments: string[];
  /** 骨架相似度 0~1；1 = 仅标点 / 空白 / 大小写 / 全半角差异。 */
  similarity: number;
  /** 两侧未匹配的骨架字符数之和（0 = 骨架完全一致）。 */
  editedChars: number;
}

/** 模型输出与原文的一处差异：原文里被改动的区域，连同它在模型输出中的对应部分。 */
export interface DifferenceHunk {
  /** 差异之前的原文上下文（保持原文写法，含标点与空白；不从词中间截断）。 */
  before: string;
  /** 原文中被改动的部分（已扩成整词）；模型多出内容（纯插入）时为空串。 */
  original: string;
  /** 模型输出中对应的部分；模型漏掉内容（纯删除）时为空串。 */
  produced: string;
  /** 差异之后的原文上下文。 */
  after: string;
}

export interface DifferenceReport {
  /**
   * 骨架相似度 0~1，口径与 {@link AnchorResult.similarity} 相同。exact = false 时
   * 只是下界：公共开头 + 结尾占比，真实值低于 REPORT_MIN_SIMILARITY。
   */
  similarity: number;
  /** similarity 是否精确。false = 差异超出比对预算（整段被改写），没有逐处比对。 */
  exact: boolean;
  /**
   * 按原文顺序的逐处差异；骨架完全一致时为空。exact = false 时只有一处：
   * 公共开头与结尾之间的整块区域。
   */
  hunks: DifferenceHunk[];
}

/** 参与比较的字符：字母、数字、组合符号。标点、符号、空白都不算内容。 */
const CONTENT_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** 起始符号：断点落在它们之前时归右段（开括号、起始引号、货币符号、西语倒置标点）。 */
const OPENING_CHAR = /[\p{Ps}\p{Pi}\p{Sc}¿¡]/u;

interface Skeleton {
  chars: string[];
  /** 每个骨架字符所属码点在源串中的 [start, end)（UTF-16 下标）。 */
  starts: number[];
  ends: number[];
}

function toSkeleton(text: string): Skeleton {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of text) {
    const start = index;
    index += ch.length;
    // NFKD：全角转半角、预组合字符分解，使等价写法落到同一序列；再转小写。
    for (const part of ch.normalize('NFKD').toLowerCase()) {
      if (CONTENT_CHAR.test(part)) {
        chars.push(part);
        starts.push(start);
        ends.push(index);
      }
    }
  }
  return { chars, starts, ends };
}

/** diff 结果中的一段：相同（无标记）/ 仅原文有（removed）/ 仅模型有（added）。 */
interface SkeletonChange {
  value: string[];
  count?: number;
  added?: boolean;
  removed?: boolean;
}

interface SkeletonDiff {
  /** 两侧开头 / 结尾相同的骨架字符数（比对前先裁掉，长窗口上几乎省掉全部开销）。 */
  prefix: number;
  suffix: number;
  /** 裁掉公共首尾后的逐段变化，按顺序。 */
  changes: SkeletonChange[];
  /** 未匹配字符数（编辑距离，插入 + 删除）。 */
  distance: number;
}

/** 两侧开头、结尾相同的骨架字符数（互不重叠）。 */
function commonAffixes(
  a: string[],
  b: string[],
): { prefix: number; suffix: number } {
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

/**
 * 最小编辑距离比对（a = 原文骨架，b = 模型骨架）。超过 maxEdits 直接放弃，对完全
 * 无关的文本也只花几毫秒；骨架完全一致时不受 maxEdits 限制。
 */
function diffSkeletons(
  a: string[],
  b: string[],
  maxEdits: number,
): SkeletonDiff | null {
  const { prefix, suffix } = commonAffixes(a, b);
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (aMid.length === 0 && bMid.length === 0) {
    return { prefix, suffix, changes: [], distance: 0 };
  }

  if (maxEdits < 1 || Math.abs(aMid.length - bMid.length) > maxEdits) {
    return null;
  }
  const changes = diffArrays(aMid, bMid, { maxEditLength: maxEdits });
  if (!changes) return null;

  let distance = 0;
  for (const change of changes) {
    if (change.added || change.removed) {
      distance += change.count ?? change.value.length;
    }
  }
  if (distance > maxEdits) return null;
  return { prefix, suffix, changes, distance };
}

/** 相似度阈值 → 编辑量上限：相似度 = 1 − D/(n+m) ≥ s ⇔ D ≤ (1 − s)·(n+m)。 */
function editBudget(n: number, m: number, minSimilarity: number): number {
  return Math.floor((1 - minSimilarity) * (n + m));
}

interface SkeletonAlignment {
  /** 未匹配字符数（编辑距离，插入 + 删除）。 */
  distance: number;
  /** 模型骨架的断点位置 j（0..m）→ 原文骨架位置 i（0..n）。 */
  toOriginal: (j: number) => number;
}

/** 按相似度阈值对齐两条骨架，并给出断点位置的换算。 */
function alignSkeletons(
  a: string[],
  b: string[],
  minSimilarity: number,
): SkeletonAlignment | null {
  const n = a.length;
  const m = b.length;
  const diff = diffSkeletons(a, b, editBudget(n, m, minSimilarity));
  if (!diff) return null;
  if (diff.distance === 0) return { distance: 0, toOriginal: (j) => j };

  // 沿编辑路径为模型骨架的每个位置记录对应的原文位置。被删掉的原文字符归左：
  // 同一位置有多个候选时取最大值，保证句尾语气词之类留在它所属的那一段。
  const { prefix, suffix, changes, distance } = diff;
  const mapped = new Int32Array(m - prefix - suffix + 1);
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.length;
    if (change.removed) {
      i += count;
      mapped[j] = i;
    } else if (change.added) {
      for (let step = 0; step < count; step += 1) {
        j += 1;
        mapped[j] = i;
      }
    } else {
      for (let step = 0; step < count; step += 1) {
        i += 1;
        j += 1;
        mapped[j] = i;
      }
    }
  }

  return {
    distance,
    toOriginal: (position) => {
      if (position < prefix) return position;
      if (position > m - suffix) return n - (m - position);
      return prefix + mapped[position - prefix];
    },
  };
}

/** 断点前的收尾标点归左，起始符号（开括号、起始引号、货币符号）归右。 */
function isOpening(ch: string, previous: string): boolean {
  if (OPENING_CHAR.test(ch)) return true;
  // ASCII 引号开合同形：前面是起始位置、空白或起始符号时是"开"，否则是"合"。
  if (ch === '"' || ch === "'") {
    return (
      previous === '' || /\s/.test(previous) || OPENING_CHAR.test(previous)
    );
  }
  return false;
}

/** 原文骨架位置 i（它之前的内容字符归左）→ 原文中的切分位置。 */
function cutPosition(original: string, skeleton: Skeleton, i: number): number {
  const total = skeleton.chars.length;
  if (i <= 0) return 0;
  if (i >= total) return original.length;

  // 紧跟在第 i-1 个内容字符所属码点之后；若随后的内容字符来自同一码点
  // （NFKD 展开），整个码点归左，不把它从中间切开。
  const afterContent = skeleton.ends[i - 1];
  let next = i;
  while (next < total && skeleton.starts[next] < afterContent) next += 1;
  if (next >= total) return original.length;

  // [afterContent, gapEnd) 之间只有标点 / 符号 / 空白：在其中找分界。
  const gapEnd = skeleton.starts[next];
  let previous = original[afterContent - 1] ?? '';
  let position = afterContent;
  for (const ch of original.slice(afterContent, gapEnd)) {
    if (isOpening(ch, previous)) break;
    position += ch.length;
    previous = ch;
  }
  return position;
}

/**
 * 把模型分段的断点重锚定到原文。
 *
 * @returns 原文切片；两侧骨架编辑量超出容差（或任一侧没有内容）时返回 null。
 */
export function anchorSegmentsToOriginal(
  original: string,
  produced: string[],
  minSimilarity: number = MIN_ANCHOR_SIMILARITY,
): AnchorResult | null {
  if (produced.length === 0) return null;
  const originalSkeleton = toSkeleton(original);

  // 模型输出的骨架，以及每个断点（相邻两段之间）落在其中的位置。
  const producedChars: string[] = [];
  const producedBreaks: number[] = [];
  produced.forEach((segment, index) => {
    for (const ch of toSkeleton(segment).chars) producedChars.push(ch);
    if (index < produced.length - 1) producedBreaks.push(producedChars.length);
  });

  const n = originalSkeleton.chars.length;
  const m = producedChars.length;
  if (n === 0 || m === 0) return null;
  const alignment = alignSkeletons(
    originalSkeleton.chars,
    producedChars,
    minSimilarity,
  );
  if (!alignment) return null;

  // 断点 → 原文位置；位置必须严格递增（纯标点段、同一位置的多个断点会合并）。
  const cuts: number[] = [];
  let lastCut = 0;
  for (const breakAt of producedBreaks) {
    const cut = cutPosition(
      original,
      originalSkeleton,
      alignment.toOriginal(breakAt),
    );
    if (cut > lastCut && cut < original.length) {
      cuts.push(cut);
      lastCut = cut;
    }
  }

  const segments: string[] = [];
  let from = 0;
  for (const cut of [...cuts, original.length]) {
    const piece = original.slice(from, cut).trim();
    if (piece) segments.push(piece);
    from = cut;
  }
  if (segments.length === 0) return null;

  return {
    segments,
    similarity: 1 - alignment.distance / (n + m),
    editedChars: alignment.distance,
  };
}

// ---------------------------------------------------------------------------
// 逐处差异（诊断用）
// ---------------------------------------------------------------------------

/** 差异前后展示的原文上下文长度（UTF-16 单元），不会从词中间截断。 */
const REPORT_CONTEXT_CHARS = 16;
/** 把差异扩成整词时，向每一侧最多多取的码点数（防止超长词把一处差异撑得很大）。 */
const MAX_WORD_SPAN = 12;
/** 两侧扩成整词后看起来没有差异时，向外多取相邻单元的最大步数（左右交替）。 */
const MAX_GROW_STEPS = 4;
/** 不以空格分词的书写系统：每个字都可能自成一词，不做按词扩展。 */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** 文本中的半开区间 [start, end)（UTF-16 下标）。 */
interface Span {
  start: number;
  end: number;
}

/** 一处差异在两侧文本中的区间；空区间表示纯插入 / 纯删除的位置。 */
interface HunkSpans {
  original: Span;
  produced: Span;
}

/** 一处差异在两侧骨架中的区间（半开）。 */
interface RawHunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/** index 处的码点（不劈开代理对）；越界返回 undefined。 */
function codePointAfter(text: string, index: number): string | undefined {
  if (index < 0 || index >= text.length) return undefined;
  if (
    isHighSurrogate(text.charCodeAt(index)) &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return text.slice(index, index + 2);
  }
  return text[index];
}

/** index 之前的那个码点（不劈开代理对）；越界返回 undefined。 */
function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0 || index > text.length) return undefined;
  if (
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    index >= 2 &&
    isHighSurrogate(text.charCodeAt(index - 2))
  ) {
    return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/** 属于一个「词」的字符：字母 / 数字 / 组合符号，且不是无空格书写系统的字。 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && CONTENT_CHAR.test(ch) && !UNSPACED_SCRIPT.test(ch);
}

/** 从 index 向左扩到词首（最多 MAX_WORD_SPAN 个码点）。 */
function wordStart(text: string, index: number): number {
  let start = index;
  for (let steps = 0; steps < MAX_WORD_SPAN; steps += 1) {
    const ch = codePointBefore(text, start);
    if (ch === undefined || !isWordChar(ch)) break;
    start -= ch.length;
  }
  return start;
}

/** 从 index 向右扩到词尾（最多 MAX_WORD_SPAN 个码点）。 */
function wordEnd(text: string, index: number): number {
  let end = index;
  for (let steps = 0; steps < MAX_WORD_SPAN; steps += 1) {
    const ch = codePointAfter(text, end);
    if (ch === undefined || !isWordChar(ch)) break;
    end += ch.length;
  }
  return end;
}

/** 骨架区间 → 文本区间。空区间（纯插入 / 删除的位置）取它之前最近的内容字符之后。 */
function skeletonSpan(skeleton: Skeleton, from: number, to: number): Span {
  if (to > from) {
    return { start: skeleton.starts[from], end: skeleton.ends[to - 1] };
  }
  const point = from === 0 ? 0 : skeleton.ends[from - 1];
  return { start: point, end: point };
}

/**
 * 把差异区间扩成整词：骨架比对会把 talk → speak 切成几个零碎的字母片段，展示
 * 给人或模型看必须是完整的词。落在词与词之间的插入 / 删除点保持为空区间。
 */
function expandToWords(text: string, span: Span): Span {
  const { start, end } = span;
  if (start === end) {
    const insideWord =
      isWordChar(codePointBefore(text, start)) &&
      isWordChar(codePointAfter(text, start));
    return insideWord
      ? { start: wordStart(text, start), end: wordEnd(text, end) }
      : span;
  }
  return {
    start: isWordChar(codePointAfter(text, start))
      ? wordStart(text, start)
      : start,
    end: isWordChar(codePointBefore(text, end)) ? wordEnd(text, end) : end,
  };
}

/** 向右多取一个单元：先越过空白 / 标点，再取一个词（无空格书写系统取一个字）。 */
function growRight(text: string, end: number): number {
  let next = end;
  for (let steps = 0; steps < MAX_WORD_SPAN; steps += 1) {
    const ch = codePointAfter(text, next);
    if (ch === undefined || CONTENT_CHAR.test(ch)) break;
    next += ch.length;
  }
  const ch = codePointAfter(text, next);
  if (ch === undefined) return next;
  return isWordChar(ch) ? wordEnd(text, next) : next + ch.length;
}

/** 向左多取一个单元，规则同 growRight。 */
function growLeft(text: string, start: number): number {
  let previous = start;
  for (let steps = 0; steps < MAX_WORD_SPAN; steps += 1) {
    const ch = codePointBefore(text, previous);
    if (ch === undefined || CONTENT_CHAR.test(ch)) break;
    previous -= ch.length;
  }
  const ch = codePointBefore(text, previous);
  if (ch === undefined) return previous;
  return isWordChar(ch) ? wordStart(text, previous) : previous - ch.length;
}

/** 区间内文字的骨架（用来判断两侧在这一处到底有没有差别）。 */
function skeletonOf(text: string, span: Span): string {
  return toSkeleton(text.slice(span.start, span.end)).chars.join('');
}

/** 去掉区间两端的空白，让空白留在上下文里。 */
function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

/** end 之前的原文上下文；起点落在词中间时丢掉开头那截残词。 */
function contextBefore(text: string, end: number): string {
  let start = Math.max(0, end - REPORT_CONTEXT_CHARS);
  if (
    start > 0 &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1;
  }
  if (
    start > 0 &&
    isWordChar(codePointBefore(text, start)) &&
    isWordChar(codePointAfter(text, start))
  ) {
    let cut = start;
    while (cut < end) {
      const ch = codePointAfter(text, cut);
      if (ch === undefined || !isWordChar(ch)) break;
      cut += ch.length;
    }
    while (cut < end && /\s/.test(text[cut])) cut += 1;
    // 整段上下文都是同一个超长词时保留残词，总好过什么都不给。
    if (cut < end) start = cut;
  }
  // 窗口被截断处不留前导空白（文本开头保持原样）。
  if (start > 0) {
    while (start < end && /\s/.test(text[start])) start += 1;
  }
  return text.slice(start, end);
}

/** start 之后的原文上下文；终点落在词中间时丢掉结尾那截残词。 */
function contextAfter(text: string, start: number): string {
  let end = Math.min(text.length, start + REPORT_CONTEXT_CHARS);
  if (
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  if (
    end < text.length &&
    isWordChar(codePointBefore(text, end)) &&
    isWordChar(codePointAfter(text, end))
  ) {
    let cut = end;
    while (cut > start) {
      const ch = codePointBefore(text, cut);
      if (ch === undefined || !isWordChar(ch)) break;
      cut -= ch.length;
    }
    while (cut > start && /\s/.test(text[cut - 1])) cut -= 1;
    if (cut > start) end = cut;
  }
  // 窗口被截断处不留尾随空白（文本结尾保持原样）。
  if (end < text.length) {
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
  }
  return text.slice(start, end);
}

/** diff 的逐段变化 → 骨架区间；中间没有相同字符隔开的删除与插入合成一处。 */
function rawHunksOf(diff: SkeletonDiff): RawHunk[] {
  const hunks: RawHunk[] = [];
  let i = diff.prefix;
  let j = diff.prefix;
  let current: RawHunk | null = null;
  for (const change of diff.changes) {
    const count = change.count ?? change.value.length;
    if (!change.added && !change.removed) {
      current = null;
      i += count;
      j += count;
      continue;
    }
    if (!current) {
      current = { aFrom: i, aTo: i, bFrom: j, bTo: j };
      hunks.push(current);
    }
    if (change.removed) {
      i += count;
      current.aTo = i;
    } else {
      j += count;
      current.bTo = j;
    }
  }
  return hunks;
}

function buildHunks(
  original: string,
  originalSkeleton: Skeleton,
  produced: string,
  producedSkeleton: Skeleton,
  rawHunks: RawHunk[],
): DifferenceHunk[] {
  // 扩成整词后，同一个词里的几个碎片、或相邻（重叠 / 相接）的差异合成一处。
  const merged: HunkSpans[] = [];
  for (const raw of rawHunks) {
    const next: HunkSpans = {
      original: expandToWords(
        original,
        skeletonSpan(originalSkeleton, raw.aFrom, raw.aTo),
      ),
      produced: expandToWords(
        produced,
        skeletonSpan(producedSkeleton, raw.bFrom, raw.bTo),
      ),
    };
    // 重复字母夹在词界上时（add database → add ddatabase），最小编辑可以把多出的
    // 那个字母算在任意一侧，扩成整词后两边一模一样。向外各多取相邻的词，直到
    // 看得出差别。
    for (
      let step = 0;
      step < MAX_GROW_STEPS &&
      skeletonOf(original, next.original) ===
        skeletonOf(produced, next.produced);
      step += 1
    ) {
      if (step % 2 === 0) {
        next.original = {
          start: next.original.start,
          end: growRight(original, next.original.end),
        };
        next.produced = {
          start: next.produced.start,
          end: growRight(produced, next.produced.end),
        };
      } else {
        next.original = {
          start: growLeft(original, next.original.start),
          end: next.original.end,
        };
        next.produced = {
          start: growLeft(produced, next.produced.start),
          end: next.produced.end,
        };
      }
    }
    const last = merged[merged.length - 1];
    if (
      last &&
      (next.original.start <= last.original.end ||
        next.produced.start <= last.produced.end)
    ) {
      last.original = {
        start: Math.min(last.original.start, next.original.start),
        end: Math.max(last.original.end, next.original.end),
      };
      last.produced = {
        start: Math.min(last.produced.start, next.produced.start),
        end: Math.max(last.produced.end, next.produced.end),
      };
    } else {
      merged.push(next);
    }
  }

  return merged.map((spans) => {
    const originalSpan = trimSpan(original, spans.original);
    const producedSpan = trimSpan(produced, spans.produced);
    return {
      before: contextBefore(original, originalSpan.start),
      original: original.slice(originalSpan.start, originalSpan.end),
      produced: produced.slice(producedSpan.start, producedSpan.end),
      after: contextAfter(original, originalSpan.end),
    };
  });
}

/**
 * 给被拒绝的模型输出做诊断：骨架相似度，以及逐处差异（按原文顺序）。
 *
 * 比对量设了上限（默认相似度 ≥ 0.75，即不超过 25% 的编辑预算）：被大幅改写的
 * 答案逐字比对既耗时，也给不出有用的逐处反馈。超出预算时 exact = false，只报告
 * 公共开头与结尾之间的整块区域，相似度取公共首尾给出的下界。
 *
 * @returns 任一侧没有字母 / 数字（无从比对）时返回 null。
 */
export function describeDifferences(
  original: string,
  produced: string[],
  minSimilarity: number = REPORT_MIN_SIMILARITY,
): DifferenceReport | null {
  if (produced.length === 0) return null;
  // 段与段之间补一个空格：<br> 一般落在词与词之间，按词扩展时不会把两段粘成一个词。
  const producedText = produced.join(' ');
  const originalSkeleton = toSkeleton(original);
  const producedSkeleton = toSkeleton(producedText);
  const n = originalSkeleton.chars.length;
  const m = producedSkeleton.chars.length;
  if (n === 0 || m === 0) return null;

  const build = (rawHunks: RawHunk[]): DifferenceHunk[] =>
    buildHunks(
      original,
      originalSkeleton,
      producedText,
      producedSkeleton,
      rawHunks,
    );
  const diff = diffSkeletons(
    originalSkeleton.chars,
    producedSkeleton.chars,
    editBudget(n, m, minSimilarity),
  );
  if (diff) {
    return {
      similarity: 1 - diff.distance / (n + m),
      exact: true,
      hunks: build(rawHunksOf(diff)),
    };
  }

  // 超出预算：公共首尾之间整块算一处差异。最长公共子序列不短于公共首尾，所以
  // 2·(首 + 尾) / (n + m) 是相似度的下界。
  const { prefix, suffix } = commonAffixes(
    originalSkeleton.chars,
    producedSkeleton.chars,
  );
  return {
    similarity: (2 * (prefix + suffix)) / (n + m),
    exact: false,
    hunks: build([
      { aFrom: prefix, aTo: n - suffix, bFrom: prefix, bTo: m - suffix },
    ]),
  };
}
