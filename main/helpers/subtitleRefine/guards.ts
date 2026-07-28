/**
 * 断句遍物理护栏（design D8）：语义归 LLM，物理归规则。
 *
 * LLM 断出的 cue 依次经过：
 *  1) 硬上限重切——超宽/超时长的 cue，词级路径在真实词时间上用 groupTokenCues
 *     重切（关闭 gap 切分：语义组合可以合法横跨停顿，只让宽度/时长/标点起作用）；
 *     无词级支撑的 cue 走 resplitSubtitleCues 比例插值兜底；
 *  2) mergeShortCues 回收单字碎片；
 *  3) enforceMinDisplayDuration 最短可读时长。
 *
 * 因此任何最终 cue 不会超过任务生效的宽度/时长上限——精修的质量下限即规则管线。
 */

import {
  GroupTokenCuesOptions,
  MergeShortCuesOptions,
  TokenTriple,
  enforceMinDisplayDuration,
  groupTokenCues,
  mergeShortCues,
  parseTime,
  resplitSubtitleCues,
  tokensToTriples,
  visualWidth,
} from '../subtitleSegmentation';
import type { AlignedCue, RefineWord } from './types';

export interface GuardOptions {
  /** 任务级成句参数（与引擎侧 getSubtitleCueOptions 同源）。 */
  cueOptions?: GroupTokenCuesOptions;
  /** 任务级短碎片合并参数（与引擎侧 getMergeShortCueOptions 同源）。 */
  mergeOptions?: MergeShortCuesOptions;
}

const DEFAULT_MAX_WIDTH = 40;
const DEFAULT_MAX_DURATION_SECONDS = 8;

/** RefineWord（毫秒）→ TokenTriple，供 groupTokenCues 重切。 */
function wordsToTokenTriples(words: RefineWord[]): TokenTriple[] {
  return tokensToTriples(
    words.map((w) => ({
      text: w.text ?? '',
      t0: w.start === null ? Number.NaN : w.start,
      t1: w.end === null ? Number.NaN : w.end,
    })),
  );
}

function cueDurationSeconds(cue: TokenTriple): number {
  const start = parseTime(cue?.[0]);
  const end = parseTime(cue?.[1]);
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
}

export function applySegmentationGuards(
  aligned: AlignedCue[],
  options: GuardOptions = {},
): TokenTriple[] {
  const maxWidth = options.cueOptions?.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxDuration =
    options.cueOptions?.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;

  const resplit: TokenTriple[] = [];
  for (const item of aligned) {
    const text = (item.cue?.[2] ?? '').trim();
    if (!text) continue;
    const overWidth = Number.isFinite(maxWidth) && visualWidth(text) > maxWidth;
    const overDuration = cueDurationSeconds(item.cue) > maxDuration;
    if (!overWidth && !overDuration) {
      resplit.push(item.cue);
      continue;
    }

    if (item.words && item.words.length > 0) {
      // 词级重切：关闭 gap 切分（LLM 的语义组合允许横跨停顿），
      // 宽度/时长硬上限与标点回溯照常生效，时间仍为真实词时间。
      const regrouped = groupTokenCues(wordsToTokenTriples(item.words), {
        ...options.cueOptions,
        maxGapSeconds: Number.POSITIVE_INFINITY,
      });
      if (regrouped.length > 0) {
        resplit.push(...regrouped);
        continue;
      }
    }
    // 无词级支撑（近似模式/防御分支）：文本级比例插值兜底。
    if (Number.isFinite(maxWidth)) {
      resplit.push(
        ...resplitSubtitleCues([item.cue], { maxSubtitleChars: maxWidth }),
      );
    } else {
      resplit.push(item.cue);
    }
  }

  const merged = mergeShortCues(resplit, options.mergeOptions);
  return enforceMinDisplayDuration(merged);
}
