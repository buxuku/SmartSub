import { visualWidth } from './subtitleSegmentation';

export interface SubtitleLayoutOptions {
  subtitleLayout?: 'original' | 'two-line';
  subtitleLineWidth?: number;
}

const cjk =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const lineJoiner = (left: string, right: string) =>
  cjk.test(left) || cjk.test(right) ? '' : ' ';

const collapse = (text: string) =>
  text
    .replace(/([^\s])[^\S\n]*\n\s*(?=\S)/gu, (match, left, offset) => {
      const right = String.fromCodePoint(
        text.codePointAt(offset + match.length)!,
      );
      return left + lineJoiner(left, right);
    })
    .replace(/\s+/g, ' ')
    .trim();

/** Presentation-only wrapping: never changes cue timing, count or visible words. */
export function layoutSubtitleText(
  text: string,
  options?: SubtitleLayoutOptions,
): string {
  if (options?.subtitleLayout !== 'two-line') return text;
  const flat = collapse(text);
  const requestedWidth = options.subtitleLineWidth;
  const width =
    typeof requestedWidth === 'number' && Number.isFinite(requestedWidth)
      ? Math.max(16, Math.min(80, requestedWidth))
      : 42;
  if (visualWidth(flat) <= width) return flat;
  const segmenter = new (Intl as any).Segmenter(undefined, {
    granularity: 'word',
  });
  const widths = new Uint32Array(flat.length + 1);
  let cursor = 0;
  for (const char of flat) {
    widths[cursor + char.length] = widths[cursor] + visualWidth(char);
    cursor += char.length;
  }
  const prefixLength = flat.match(/^\[[^\]\r\n]+\]\s*/u)?.[0].length || 0;
  let best: { index: number; score: number } | undefined;
  for (const { index } of segmenter.segment(flat)) {
    const leftEnd = flat[index - 1] === ' ' ? index - 1 : index;
    const rightStart = flat[index] === ' ' ? index + 1 : index;
    const leftLast =
      Array.from(flat.slice(Math.max(0, leftEnd - 2), leftEnd)).pop() || '';
    const rightFirst = String.fromCodePoint(flat.codePointAt(rightStart) || 0);
    if (
      leftEnd <= prefixLength ||
      rightStart >= flat.length ||
      /^[,.;:!?，。；：！？、）】》”’]/u.test(rightFirst) ||
      /[（【《“‘]$/u.test(leftLast) ||
      // Only choose boundaries that can be collapsed losslessly on an export retry.
      lineJoiner(leftLast, rightFirst) !== flat.slice(leftEnd, rightStart)
    )
      continue;
    const leftWidth = widths[leftEnd];
    const rightWidth = widths[flat.length] - widths[rightStart];
    const overflow =
      Math.max(0, leftWidth - width) + Math.max(0, rightWidth - width);
    const score =
      overflow * 10 +
      Math.abs(leftWidth - rightWidth) -
      (/[,.!?;:，。！？；：]$/u.test(leftLast) ? 4 : 0);
    if (!best || score < best.score) best = { index, score };
  }
  // An indivisible long word remains intact; do not invent timing or truncate it.
  return best
    ? `${flat.slice(0, best.index).trimEnd()}\n${flat.slice(best.index).trimStart()}`
    : flat;
}

export function layoutSubtitleColumns(
  source: string,
  target: string,
  contentType: string,
  options?: SubtitleLayoutOptions,
  speakerPrefix = '',
): string {
  if (
    contentType === 'sourceAndTranslate' ||
    contentType === 'translateAndSource'
  ) {
    const columns =
      contentType === 'sourceAndTranslate'
        ? [source, target]
        : [target, source];
    return speakerPrefix + columns.map(collapse).filter(Boolean).join('\n');
  }
  return layoutSubtitleText(
    speakerPrefix + (contentType === 'source' ? source : target),
    options,
  );
}
