const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const han = new RegExp('\\p{Script=Han}', 'u');
const whitespace = new RegExp('\\s', 'u');

/**
 * 容差缓冲比例（15%）：
 * 允许字数在短句或正常口语节奏中有轻微浮动（例如中文参考值 8 允许至 9.2，英文参考值 20 允许至 23），
 * 避免因轻微超标（如超标 1 个字）引发大量不必要的质检误报。
 */
export const SPEED_TOLERANCE_RATIO = 0.15;

export function subtitleHealth(
  text: string,
  start?: number,
  end?: number,
  language?: string,
) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Count each line once without allocating an object array per grapheme.
  // Unicode graphemes still keep combining marks and emoji as single units.
  let readingCharacters = 0;
  const lengths = lines.map((line) => {
    let length = 0;
    for (const segment of graphemes.segment(line)) {
      length++;
      // 阅读速度（CPS）衡量视线与认知负荷，空白字符（空格/换行/制表符）不作为阅读字数计算
      if (!whitespace.test(segment.segment)) {
        readingCharacters++;
      }
    }
    return length;
  });
  const characters = lengths.reduce((total, length) => total + length, 0);
  const chinese =
    /^zh(?:$|[-_])/i.test(language || '') ||
    ((!language || language === 'auto') && han.test(text));
  const threshold = chinese ? 8 : 20;
  const duration = (end ?? NaN) - (start ?? NaN);
  const cps =
    Number.isFinite(duration) && duration > 0
      ? readingCharacters / duration
      : null;
  const maxCps = threshold * (1 + SPEED_TOLERANCE_RATIO);
  return {
    characters,
    readingCharacters,
    cps,
    threshold,
    maxCps,
    tooFast: cps !== null && cps > maxCps + 1e-6,
    longestLine: Math.max(0, ...lengths),
    lines: lines.length,
  };
}
