import type { Range } from '@tanstack/react-virtual';

/** Keep ~400px of spare rows, instead of mounting ten full editors per side. */
export function subtitleVirtualRange(
  { startIndex, endIndex, count, overscan }: Range,
  isExpanded: (index: number) => boolean,
): number[] {
  let start = startIndex;
  let end = endIndex;
  const budget = overscan * 40;
  let before = 0;
  let after = 0;
  // Expanded rows have dynamic heights. 200px is only an overscan estimate;
  // the virtualizer still measures their real size for all positioning.
  while (start > 0 && before < budget) {
    start--;
    before += isExpanded(start) ? 200 : 40;
  }
  while (end < count - 1 && after < budget) {
    end++;
    after += isExpanded(end) ? 200 : 40;
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}
