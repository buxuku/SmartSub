/**
 * 各引擎词级输出 → RefineWord（毫秒）的纯转换（openspec: add-ai-subtitle-refine D6）。
 *
 * 时间不可信（缺失 / NaN）的一端置 null：对齐层会把这类词并入相邻词、不作时间边界，
 * 与 groupTokenCues 对空时间 token 的容错语义一致。
 */

import type { NativeToken, TimedWord } from '../subtitleSegmentation';
import type { RefineWord } from './types';

/** builtin whisper.cpp 原生 token（毫秒，含置信度 p）→ RefineWord。 */
export function refineWordsFromNativeTokens(
  tokens: NativeToken[] | undefined,
): RefineWord[] {
  return (tokens ?? []).map((tok): RefineWord => {
    const t0 = Number(tok?.t0);
    const t1 = Number(tok?.t1);
    const word: RefineWord = {
      text: tok?.text ?? '',
      start: Number.isFinite(t0) ? t0 : null,
      end: Number.isFinite(t1) ? t1 : null,
    };
    if (typeof tok?.p === 'number' && Number.isFinite(tok.p)) {
      word.p = tok.p;
    }
    return word;
  });
}

/**
 * 低置信词收集（校正遍标注用，design D7）：token 概率低于阈值的词文本，
 * 去重限量（避免撑爆提示词）。仅词级引擎（builtin/faster-whisper）有 p。
 */
export function collectSuspectWords(
  words: RefineWord[] | undefined,
  threshold = 0.5,
  cap = 40,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words ?? []) {
    if (typeof w.p !== 'number' || w.p >= threshold) continue;
    const text = (w.text ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

/** 只保留出现在本批字幕原文中的低置信词（spec: 进入本批提示词）。 */
export function filterSuspectWordsForBatch(
  suspectWords: string[] | undefined,
  sources: string[],
): string[] {
  if (!suspectWords?.length) return [];
  const haystack = sources.join('\n');
  return suspectWords.filter((w) => {
    const token = w.trim();
    return token.length > 0 && haystack.includes(token);
  });
}

/** faster-whisper 词级输出（秒，或含 probability）→ RefineWord（毫秒）。 */
export function refineWordsFromTimedWords(
  words: Array<TimedWord & { probability?: number }> | undefined,
): RefineWord[] {
  return (words ?? []).map((w): RefineWord => {
    const start = Number(w?.start);
    const end = Number(w?.end);
    const word: RefineWord = {
      text: w?.word ?? '',
      start: Number.isFinite(start) ? Math.round(start * 1000) : null,
      end: Number.isFinite(end) ? Math.round(end * 1000) : null,
    };
    if (typeof w?.probability === 'number' && Number.isFinite(w.probability)) {
      word.p = w.probability;
    }
    return word;
  });
}
