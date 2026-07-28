/**
 * 断句分窗（design D5）：长转写切成 300–500 词的窗口并发送 LLM。
 *
 * 窗口切点选「回看区内最大词间隔」——builtin 的词时间已做 segment-aware 映射
 * （段间停顿直接体现在词间 gap 上），faster-whisper / 云端词级同理，因此
 * 「最大词间隔」天然优先落在 VAD/能量语音段边界；额外的超大间隔（≥4s）
 * 视为章节级停顿，凑满最小窗口即可提前切，让窗口边界贴合自然停顿。
 *
 * verbatim 协议下窗口互不影响（无跨窗状态），无需重叠。
 */

import type { TokenTriple } from '../subtitleSegmentation';
import { parseTime } from '../subtitleSegmentation';
import { RefineWord, cjkCharCount, isMainlyCjk, latinWordCount } from './types';

export interface WindowingOptions {
  /** 达到该词数后开始物色切点（默认 300）。 */
  minUnits?: number;
  /** 达到该词数必须切（默认 500）。 */
  maxUnits?: number;
}

const WINDOW_DEFAULTS: Required<WindowingOptions> = {
  minUnits: 300,
  maxUnits: 500,
};

/** 章节级停顿：gap ≥ 4s 且已凑满 1/6 窗口即提前切。 */
const HARD_GAP_MS = 4000;

/** 词间 gap（毫秒）；任一端时间不可信记 -1（不作候选切点）。 */
function gapAfter(words: RefineWord[], i: number): number {
  const cur = words[i];
  const next = words[i + 1];
  if (!cur || !next) return -1;
  if (cur.end === null || next.start === null) return -1;
  if (!Number.isFinite(cur.end) || !Number.isFinite(next.start)) return -1;
  return next.start - cur.end;
}

/** Tier 'word'：词序列 → 窗口切片列表。 */
export function splitWordsIntoWindows(
  words: RefineWord[],
  options?: WindowingOptions,
): RefineWord[][] {
  const opts = { ...WINDOW_DEFAULTS, ...options };
  if (words.length <= opts.maxUnits) return words.length ? [words] : [];

  const windows: RefineWord[][] = [];
  let windowStart = 0;
  let count = 0;
  let bestGap = -1;
  let bestGapIndex = -1;

  for (let i = 0; i < words.length; i += 1) {
    count += 1;
    const gap = gapAfter(words, i);

    // 章节级停顿：提前切，让窗口边界贴合大静音。
    if (gap >= HARD_GAP_MS && count >= Math.ceil(opts.minUnits / 6)) {
      windows.push(words.slice(windowStart, i + 1));
      windowStart = i + 1;
      count = 0;
      bestGap = -1;
      bestGapIndex = -1;
      continue;
    }

    // 物色区（min~max 之间）：记录最大 gap 作为候选切点。
    if (count >= opts.minUnits && gap > bestGap) {
      bestGap = gap;
      bestGapIndex = i;
    }

    // 到达硬上限：切在候选点（无正 gap 候选则就地切）。
    if (count >= opts.maxUnits) {
      const cutAt = bestGapIndex >= windowStart ? bestGapIndex : i;
      windows.push(words.slice(windowStart, cutAt + 1));
      windowStart = cutAt + 1;
      count = i - cutAt;
      bestGap = -1;
      bestGapIndex = -1;
    }
  }

  if (windowStart < words.length) {
    windows.push(words.slice(windowStart));
  }
  return windows;
}

/** cue 的「词单位」估计：CJK 按字数、拉丁按词数（与限长校验同一度量）。 */
function cueUnits(text: string): number {
  return isMainlyCjk(text) ? cjkCharCount(text) : latinWordCount(text);
}

/** cue 间 gap（秒→毫秒）；不可解析记 -1。 */
function cueGapAfter(cues: TokenTriple[], i: number): number {
  const curEnd = parseTime(cues[i]?.[1]);
  const nextStart = parseTime(cues[i + 1]?.[0]);
  if (curEnd === null || nextStart === null) return -1;
  return (nextStart - curEnd) * 1000;
}

/** Tier 'segment'：cue 列表 → 窗口区间（含首不含尾），切点只落在 cue 边界。 */
export function splitCuesIntoWindows(
  cues: TokenTriple[],
  options?: WindowingOptions,
): Array<[number, number]> {
  const opts = { ...WINDOW_DEFAULTS, ...options };
  if (cues.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let windowStart = 0;
  let units = 0;
  let bestGap = -1;
  let bestGapIndex = -1;

  for (let i = 0; i < cues.length; i += 1) {
    units += cueUnits(cues[i]?.[2] ?? '');
    const gap = cueGapAfter(cues, i);

    if (gap >= HARD_GAP_MS && units >= Math.ceil(opts.minUnits / 6)) {
      ranges.push([windowStart, i + 1]);
      windowStart = i + 1;
      units = 0;
      bestGap = -1;
      bestGapIndex = -1;
      continue;
    }

    if (units >= opts.minUnits && gap > bestGap) {
      bestGap = gap;
      bestGapIndex = i;
    }

    if (units >= opts.maxUnits) {
      const cutAt = bestGapIndex >= windowStart ? bestGapIndex : i;
      ranges.push([windowStart, cutAt + 1]);
      // 重算残余单位数（cutAt 可能早于 i）。
      units = 0;
      for (let j = cutAt + 1; j <= i; j += 1) {
        units += cueUnits(cues[j]?.[2] ?? '');
      }
      windowStart = cutAt + 1;
      bestGap = -1;
      bestGapIndex = -1;
    }
  }

  if (windowStart < cues.length) {
    ranges.push([windowStart, cues.length]);
  }
  return ranges;
}
