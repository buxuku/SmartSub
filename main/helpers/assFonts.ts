import {
  fontTextRuns,
  resolveBurnFontName,
  type FontContext,
} from './fontResolver';
import { mapAssOverrideBlocks } from '../../types/assOverrides';

/** Explicit per-glyph fallback keeps Latin typography intact and matches both libass engines. */
export function resolveAssFonts(
  content: string,
  defaultFont: string,
  context: FontContext = [],
): { content: string; fontNames: string[] } {
  const fontNames = new Set([defaultFont]);
  let format: string[] = [];
  let section = '';
  const contentWithFonts = content
    .split('\n')
    .map((line) => {
      if (/^\s*\[.*\]\s*$/.test(line)) {
        section = line.trim().toLowerCase();
        format = [];
      }
      const header = /^\s*Format\s*:\s*(.*)$/i.exec(line);
      if (header)
        format = header[1]
          .toLowerCase()
          .split(',')
          .map((field) => field.trim());
      if (section !== '[events]' || !/^\s*Dialogue\s*:/i.test(line))
        return line;
      const textIndex = format.indexOf('text');
      if (textIndex !== format.length - 1 || textIndex < 0)
        throw new Error('Unsupported ASS event format');
      let start = line.indexOf(':') + 1;
      for (let index = 0; index < textIndex; index++) {
        start = line.indexOf(',', start) + 1;
        if (!start) throw new Error('Invalid ASS dialogue');
      }
      let activeFont = defaultFont;
      let drawing = false;
      const text = line
        .slice(start)
        .split(/(\{[^}]*\}|\\[Nnh])/g)
        .map((token) => {
          if (token.startsWith('{')) {
            return mapAssOverrideBlocks(token, (tag) => {
              if (tag.startsWith('\\fn')) {
                const name = tag.slice(3).trim();
                activeFont = name
                  ? resolveBurnFontName(name, false, context)
                  : defaultFont;
                fontNames.add(activeFont);
                return `\\fn${activeFont}`;
              }
              if (tag.startsWith('\\r')) {
                activeFont = defaultFont;
                drawing = false;
              }
              const mode = /^\\p(\d+)\s*$/.exec(tag);
              if (mode) drawing = Number(mode[1]) > 0;
              return tag;
            });
          }
          if (drawing || /^\\[Nn]$/.test(token) || !token) return token;
          const runs = fontTextRuns(
            token === '\\h' ? '\u00a0' : token,
            activeFont,
            context,
          );
          if (runs.length === 1 && runs[0].fontName === activeFont)
            return token;
          return (
            runs
              .map((run) => {
                fontNames.add(run.fontName);
                return `{\\fn${run.fontName}}${token === '\\h' ? token : run.text}`;
              })
              .join('') + `{\\fn${activeFont}}`
          );
        })
        .join('');
      return line.slice(0, start) + text;
    })
    .join('\n');
  return { content: contentWithFonts, fontNames: Array.from(fontNames) };
}
