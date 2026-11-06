import type { SubtitleStyle } from './subtitleMerge';

export interface SubtitleTextRun {
  text: string;
  color: string;
}

/** Shared literal highlighting and explicit-line colors for ASS and UI previews. */
export function subtitleTextRuns(
  text: string,
  style: SubtitleStyle,
): SubtitleTextRun[] {
  const terms = Array.from(
    new Set(
      (style.highlightTerms || []).map((term) => term.trim()).filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length);
  const runs: SubtitleTextRun[] = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      if (index) runs.push({ text: '\n', color: style.primaryColor });
      const base =
        index > 0 && style.secondLineColor
          ? style.secondLineColor
          : style.primaryColor;
      let offset = 0;
      while (offset < line.length) {
        let start = line.length;
        let match = '';
        for (const term of terms) {
          const found = line.indexOf(term, offset);
          if (found >= 0 && found < start) {
            start = found;
            match = term;
          }
        }
        if (start > offset)
          runs.push({ text: line.slice(offset, start), color: base });
        if (!match) break;
        runs.push({ text: match, color: style.highlightColor || '#FFFF00' });
        offset = start + match.length;
      }
    });
  return runs;
}

export function subtitleGlow(style: SubtitleStyle): number {
  return typeof style.glow === 'number' && Number.isFinite(style.glow)
    ? Math.max(0, Math.min(10, style.glow))
    : 0;
}
