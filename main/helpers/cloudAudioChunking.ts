/**
 * 云端听写切片的「边界计算」纯逻辑（无 ffmpeg / fs / electron），便于 test:engines 单测。
 */

/**
 * 计算切片时间边界（秒）：按能量法语音段聚合，累计到 maxChunkSeconds 时在「静音间隙中点」切分，
 * 使切点落在静音而非词中。
 * - 无语音段：有总时长则返回整段单切片，否则空；
 * - 有语音段：从 0 起累计，若「延伸到下一段结尾」超上限，则在本段尾与下一段首的中点切分。
 */
export function computeChunkBoundaries(
  segments: Array<{ start: number; end: number }>,
  totalDurationSec: number,
  maxChunkSeconds: number,
): Array<{ start: number; end: number }> {
  if (!Array.isArray(segments) || segments.length === 0) {
    return totalDurationSec > 0 ? [{ start: 0, end: totalDurationSec }] : [];
  }
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) {
    return totalDurationSec > 0 ? [{ start: 0, end: totalDurationSec }] : [];
  }

  const boundaries: Array<{ start: number; end: number }> = [];
  let chunkStart = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const seg = sorted[i];
    const next = sorted[i + 1];
    if (next && next.end - chunkStart > maxChunkSeconds) {
      const cut = (seg.end + next.start) / 2;
      boundaries.push({ start: chunkStart, end: cut });
      chunkStart = cut;
    }
  }
  const end = Math.max(totalDurationSec, sorted[sorted.length - 1].end);
  boundaries.push({ start: chunkStart, end });
  return boundaries;
}
