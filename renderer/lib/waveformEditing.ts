/** Nearest measured silence edge within the pointer's snap radius. */
export function snapToSilence(
  time: number,
  edges: number[],
  radius: number,
): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (edges[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  let closest = time;
  let distance = radius;
  for (const edge of [edges[lo - 1], edges[lo]]) {
    if (edge !== undefined && Math.abs(edge - time) <= distance) {
      closest = edge;
      distance = Math.abs(edge - time);
    }
  }
  return Math.round(closest * 1000) / 1000;
}

export function timelineSplitPoint(text: string, ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  );
  if (segments.length < 2) return null;
  const index = Math.max(
    1,
    Math.min(segments.length - 1, Math.round(segments.length * ratio)),
  );
  return segments[index].index;
}

export function validCueRange(start: number, end: number): boolean {
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    Math.round(end * 1000) > Math.round(start * 1000)
  );
}
