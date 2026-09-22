const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const han = new RegExp('\\p{Script=Han}', 'u');

export function subtitleHealth(
  text: string,
  start?: number,
  end?: number,
  language?: string,
) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Count each line once without allocating an object array per grapheme.
  // Unicode graphemes still keep combining marks and emoji as single units.
  const lengths = lines.map((line) => {
    let length = 0;
    const segments = graphemes.segment(line)[Symbol.iterator]();
    while (!segments.next().done) length++;
    return length;
  });
  const characters = lengths.reduce((total, length) => total + length, 0);
  const chinese =
    /^zh(?:$|[-_])/i.test(language || '') ||
    ((!language || language === 'auto') && han.test(text));
  const threshold = chinese ? 8 : 20;
  const duration = (end ?? NaN) - (start ?? NaN);
  const cps =
    Number.isFinite(duration) && duration > 0 ? characters / duration : null;
  return {
    characters,
    cps,
    threshold,
    tooFast: cps !== null && cps > threshold,
    longestLine: Math.max(0, ...lengths),
    lines: lines.length,
  };
}
