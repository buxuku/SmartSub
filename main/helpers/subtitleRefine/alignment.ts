/**
 * 断句结果 → 时间轴对齐（design D4 / D6）。
 *
 * 精确模式（Tier 'word'）：校验器已保证「拼回文本与原文规范化等值」，故在
 * 「规范化字符 offset → 词索引」映射上一次线性扫描即可把每个 <br> 换算成词边界，
 * cue 时间取首/末词真实时间戳——不做任何插值，优于模糊匹配（卡卡滑窗方案的替代）。
 * 断点若落在词内部（模型把 <br> 插进词中间），边界向后吸附到该词末尾（不拆词），
 * 溢出字符数记为 debt 从下一段的需求中扣除。
 *
 * 近似模式（Tier 'segment'）：以规则 cue 为「伪词」，段边界命中 cue 边界时沿用其
 * 真实时间，落在 cue 内部时按规范化字符占比在该 cue 时长内线性插值
 * （与 resplitSubtitleCues 的比例插值同一语义）。
 */

import { TokenTriple, formatTime, parseTime } from '../subtitleSegmentation';
import { AlignedCue, RefineWord, normalizeForCompare } from './types';

/** 词文本原样拼接 + 空白折叠（与 protocol.buildWindowText 同形态）。 */
function joinWordTexts(words: RefineWord[]): string {
  return words
    .map((w) => w.text ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 精确对齐：把 <br> 段列表映射回词切片。
 * 返回 null 表示不可对齐（总字符数不一致——调用方应降级该窗口），正常情况下
 * 校验器已挡住，这里只是防御。
 */
export function alignSegmentsToWords(
  words: RefineWord[],
  segments: string[],
): AlignedCue[] | null {
  const normLens = words.map((w) => normalizeForCompare(w.text ?? '').length);
  const totalWordChars = normLens.reduce((sum, n) => sum + n, 0);
  const totalSegmentChars = segments.reduce(
    (sum, seg) => sum + normalizeForCompare(seg).length,
    0,
  );
  if (totalWordChars !== totalSegmentChars) return null;

  const aligned: AlignedCue[] = [];
  let wordIdx = 0;
  /** 上一段边界吸附到词末尾时多消费的字符数，从本段需求中扣除。 */
  let debt = 0;
  let lastEndSeconds: number | null = null;

  for (const segment of segments) {
    let need = normalizeForCompare(segment).length - debt;
    debt = 0;
    if (need <= 0) {
      // 段被 debt 吞尽（模型在同一个词内插了多个 <br>）：该段并入上一条，跳过。
      debt = -need;
      continue;
    }

    const sliceStart = wordIdx;
    let got = 0;
    while (wordIdx < words.length && got < need) {
      got += normLens[wordIdx];
      wordIdx += 1;
    }
    if (got < need) return null; // 词耗尽仍不够：不可对齐（防御分支）
    if (got > need) debt = got - need; // 边界落在词内：吸附到词末，欠账给下一段

    // 边界后的零字符词（纯空白）贴回本段，保证下一条以有内容的词开头。
    while (wordIdx < words.length && normLens[wordIdx] === 0) {
      wordIdx += 1;
    }

    const slice = words.slice(sliceStart, wordIdx);
    const text = joinWordTexts(slice);
    if (!text) continue;

    let startMs: number | null = null;
    let endMs: number | null = null;
    for (const w of slice) {
      if (w.start !== null && Number.isFinite(w.start)) {
        if (startMs === null || w.start < startMs) startMs = w.start;
      }
      if (w.end !== null && Number.isFinite(w.end)) {
        if (endMs === null || w.end > endMs) endMs = w.end;
      }
    }
    // 整片词都无可信时间（极端防御）：借上一条末点占位，交最短显示护栏延展。
    const startSeconds =
      startMs !== null ? startMs / 1000 : (lastEndSeconds ?? 0);
    const endSeconds = endMs !== null ? endMs / 1000 : startSeconds;
    lastEndSeconds = endSeconds;

    aligned.push({
      cue: [formatTime(startSeconds), formatTime(endSeconds), text],
      words: slice,
    });
  }

  return aligned.length > 0 ? aligned : null;
}

/**
 * 近似对齐：把 <br> 段列表映射回 cue 区间（Tier 'segment'）。
 * 返回 null 表示总字符数不一致（调用方降级）。
 */
export function alignSegmentsToCues(
  cues: TokenTriple[],
  segments: string[],
  range?: [number, number],
): TokenTriple[] | null {
  const [from, to] = range ?? [0, cues.length];
  const scoped = cues.slice(from, to);

  interface CueSpan {
    normStart: number;
    normLen: number;
    startSec: number;
    endSec: number;
  }
  const spans: CueSpan[] = [];
  let cursor = 0;
  let fallbackTime = 0;
  for (const cue of scoped) {
    const normLen = normalizeForCompare(cue?.[2] ?? '').length;
    const start = parseTime(cue?.[0]);
    const end = parseTime(cue?.[1]);
    const startSec = start ?? fallbackTime;
    const endSec = end !== null && end > startSec ? end : startSec;
    spans.push({ normStart: cursor, normLen, startSec, endSec });
    cursor += normLen;
    fallbackTime = endSec;
  }
  const totalChars = cursor;
  const totalSegmentChars = segments.reduce(
    (sum, seg) => sum + normalizeForCompare(seg).length,
    0,
  );
  if (totalChars !== totalSegmentChars || totalChars === 0) return null;

  /** 规范化 offset → 时间（cue 内按字符占比线性插值；命中边界取该 cue 起点）。 */
  const timeAt = (offset: number, side: 'start' | 'end'): number => {
    if (offset <= 0) return spans[0].startSec;
    if (offset >= totalChars) return spans[spans.length - 1].endSec;
    for (const span of spans) {
      if (offset < span.normStart + span.normLen || span.normLen === 0) {
        if (offset === span.normStart) {
          return side === 'start' ? span.startSec : span.startSec;
        }
        const ratio = (offset - span.normStart) / Math.max(1, span.normLen);
        return span.startSec + ratio * (span.endSec - span.startSec);
      }
    }
    return spans[spans.length - 1].endSec;
  };

  const out: TokenTriple[] = [];
  let offset = 0;
  for (const segment of segments) {
    const len = normalizeForCompare(segment).length;
    if (len === 0) continue;
    const startSec = timeAt(offset, 'start');
    const endSec = timeAt(offset + len, 'end');
    out.push([
      formatTime(startSec),
      formatTime(Math.max(endSec, startSec)),
      segment.trim(),
    ]);
    offset += len;
  }
  return out.length > 0 ? out : null;
}
