/**
 * 云端听写（在线 ASR）结果 → 字幕的「成句/降级」纯逻辑（无 electron / fs / 网络）。
 *
 * 词级时间戳优先：把 OpenAI 兼容返回的 word 时间戳映射为内置 NativeToken，复用 whisper.cpp
 * 引擎同一套成句管线（groupTokenCues → mergeShortCues → enforceMinDisplayDuration），从而
 * 让「whisper-1 中文单段 + 字级时间戳」自然断成多条自然字幕（与 spike 验证一致）。
 * 无词级时间戳（如 gpt-4o-transcribe）→ 段级/整段降级（由调用方选择）。
 *
 * 纯函数便于 test:engines 单测；故内联时间格式化，不引入 fileUtils（避免 electron 依赖）。
 */
import {
  tokensToTriples,
  groupTokenCues,
  mergeShortCues,
  enforceMinDisplayDuration,
  type NativeToken,
  type TokenTriple,
} from '../subtitleSegmentation';
import type { AsrSegment, AsrWord } from '../../service/asr/types';

/** 秒 → `HH:MM:SS,mmm`（SRT 逗号形式）。 */
function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** token 是否需要前置空格：以 ASCII 字母/数字开头（拉丁词），CJK/标点不加空格。 */
export function needsSpaceBefore(token: string): boolean {
  return /^[A-Za-z0-9]/.test(token);
}

/**
 * 标点回贴（best-effort）：whisper-1 的词级时间戳（尤其中文）不含标点，但整段 `text` 含标点。
 * 在 fullText 里按序定位每个 word，把 word 间/尾部出现的标点补回「前一个 word」文本，
 * 使成句后的字幕带上自然标点。定位失败的 word 跳过（不误贴、不丢词）。
 */
export function realignPunctuation(
  words: AsrWord[],
  fullText?: string,
): AsrWord[] {
  const result = (words ?? []).map((w) => ({ ...w }));
  const text = (fullText ?? '').trim();
  if (!text || result.length === 0) return result;

  let cursor = 0;
  for (let i = 0; i < result.length; i += 1) {
    const token = String(result[i].word ?? '').trim();
    if (!token) continue;
    const idx = text.indexOf(token, cursor);
    if (idx < 0) continue; // 定位失败：跳过该 word（不改动）
    const gap = text.slice(cursor, idx).replace(/\s+/g, '');
    if (gap && i > 0) {
      result[i - 1].word = String(result[i - 1].word ?? '') + gap;
    }
    cursor = idx + token.length;
  }
  const tail = text.slice(cursor).replace(/\s+/g, '');
  if (tail) {
    result[result.length - 1].word =
      String(result[result.length - 1].word ?? '') + tail;
  }
  return result;
}

/** 词级时间戳（秒）→ 内置 NativeToken（毫秒）。拉丁词补前置空格以正确分词，CJK 不加。 */
export function wordsToNativeTokens(words: AsrWord[]): NativeToken[] {
  return (words ?? []).map((w) => {
    const t = String(w.word ?? '');
    const text = needsSpaceBefore(t) ? ` ${t}` : t;
    return {
      text,
      t0: Math.round(Number(w.start) * 1000),
      t1: Math.round(Number(w.end) * 1000),
    };
  });
}

/** 给词级时间戳整体加偏移（秒），用于切片回拼原始时间轴。 */
export function offsetWords(words: AsrWord[], offsetSec: number): AsrWord[] {
  if (!offsetSec) return (words ?? []).map((w) => ({ ...w }));
  return (words ?? []).map((w) => ({
    word: w.word,
    start: Number(w.start) + offsetSec,
    end: Number(w.end) + offsetSec,
  }));
}

/**
 * 词级路径：realign 标点 → NativeToken → 复用成句管线，得到字幕三元组（未裁尾）。
 * 裁尾（trimSubtitleTrailingSilence）由引擎在拿到本地 WAV 时补做。
 */
export function wordCuesFromResult(result: {
  words?: AsrWord[];
  text?: string;
}): TokenTriple[] {
  const realigned = realignPunctuation(result.words ?? [], result.text);
  const tokens = wordsToNativeTokens(realigned);
  const triples = tokensToTriples(tokens);
  return enforceMinDisplayDuration(mergeShortCues(groupTokenCues(triples)));
}

/** 段级降级：AsrSegment[] → 字幕三元组，可加偏移（秒）。 */
export function segmentCuesFromSegments(
  segments: AsrSegment[] | undefined,
  offsetSec = 0,
): TokenTriple[] {
  return (segments ?? [])
    .filter(
      (s) =>
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > s.start &&
        String(s.text ?? '').trim() !== '',
    )
    .map(
      (s): TokenTriple => [
        formatSrtTime(s.start + offsetSec),
        formatSrtTime(s.end + offsetSec),
        String(s.text ?? '').trim(),
      ],
    );
}

/** 整段降级：既无词级也无段级时，用 [offset, offset+duration] 生成单条 cue。 */
export function singleCueFromText(
  text: string,
  startSec: number,
  endSec: number,
): TokenTriple[] {
  const t = String(text ?? '').trim();
  if (!t || !(endSec > startSec)) return [];
  return [[formatSrtTime(startSec), formatSrtTime(endSec), t]];
}
