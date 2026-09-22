import type { QualityIssue } from '../../types/qualityReview';
import type { Subtitle } from '../hooks/useSubtitles';

/** Find neighbors by time, including gaps before the first or after the last cue. */
export function qualityIssueContext(
  issue: Pick<QualityIssue, 'start' | 'end'>,
  rows: Subtitle[],
) {
  const before: number[] = [];
  const after: number[] = [];
  rows.forEach((row, index) => {
    const start = row.startTimeInSeconds;
    const end = row.endTimeInSeconds;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end! <= start!)
      return;
    if (end! <= issue.start) {
      before.push(index);
      before.sort(
        (a, b) =>
          rows[b].endTimeInSeconds! - rows[a].endTimeInSeconds! || b - a,
      );
      before.length = Math.min(before.length, 2);
    } else if (start! >= issue.end) {
      after.push(index);
      after.sort(
        (a, b) =>
          rows[a].startTimeInSeconds! - rows[b].startTimeInSeconds! || a - b,
      );
      after.length = Math.min(after.length, 2);
    }
  });
  return { before, after };
}
