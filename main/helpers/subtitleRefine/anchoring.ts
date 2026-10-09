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
 */

import { diffArrays } from 'diff';

/** 骨架相似度下限：2·匹配数 / 两侧骨架长度之和。 */
export const MIN_ANCHOR_SIMILARITY = 0.96;

export interface AnchorResult {
  /** 按模型断点在原文上切出的分段（保留原文的标点与大小写；已 trim，无空段）。 */
  segments: string[];
  /** 骨架相似度 0~1；1 = 仅标点 / 空白 / 大小写 / 全半角差异。 */
  similarity: number;
  /** 两侧未匹配的骨架字符数之和（0 = 骨架完全一致）。 */
  editedChars: number;
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

interface SkeletonAlignment {
  /** 未匹配字符数（编辑距离，插入 + 删除）。 */
  distance: number;
  /** 模型骨架的断点位置 j（0..m）→ 原文骨架位置 i（0..n）。 */
  toOriginal: (j: number) => number;
}

/**
 * 最小编辑距离对齐。编辑量上限由相似度阈值推出：相似度 = 1 − D/(n+m) ≥ s
 * ⇔ D ≤ (1 − s)·(n+m)，超限直接放弃，对完全无关的文本也只花几毫秒。
 */
function alignSkeletons(
  a: string[],
  b: string[],
  minSimilarity: number,
): SkeletonAlignment | null {
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
  const aMid = a.slice(prefix, n - suffix);
  const bMid = b.slice(prefix, m - suffix);
  if (aMid.length === 0 && bMid.length === 0) {
    return { distance: 0, toOriginal: (j) => j };
  }

  const maxEdits = Math.floor((1 - minSimilarity) * (n + m));
  if (maxEdits < 1 || Math.abs(aMid.length - bMid.length) > maxEdits) {
    return null;
  }
  const changes = diffArrays(aMid, bMid, { maxEditLength: maxEdits });
  if (!changes) return null;

  // 沿编辑路径为模型骨架的每个位置记录对应的原文位置。被删掉的原文字符归左：
  // 同一位置有多个候选时取最大值，保证句尾语气词之类留在它所属的那一段。
  const mapped = new Int32Array(bMid.length + 1);
  let i = 0;
  let j = 0;
  let distance = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.length;
    if (change.removed) {
      i += count;
      distance += count;
      mapped[j] = i;
    } else if (change.added) {
      distance += count;
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
  if (distance > maxEdits) return null;

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
