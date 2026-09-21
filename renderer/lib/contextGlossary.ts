import type { Subtitle } from '../hooks/useSubtitles';

export type SubtitleField = 'sourceContent' | 'targetContent';
const latinWord = /[A-Za-z0-9_\u00c0-\u024f]/;

/** Literal, case-sensitive replacement. Latin terms must respect word edges. */
export function replaceGlossaryTerm(
  text: string,
  from: string,
  to: string,
): { text: string; count: number } {
  if (!from || from === to) return { text, count: 0 };
  let position = 0;
  let count = 0;
  let output = '';
  for (;;) {
    const hit = text.indexOf(from, position);
    if (hit < 0) break;
    const end = hit + from.length;
    const startsInside =
      latinWord.test(from[0]) && hit > 0 && latinWord.test(text[hit - 1]);
    const endsInside =
      latinWord.test(from[from.length - 1]) &&
      end < text.length &&
      latinWord.test(text[end]);
    if (startsInside || endsInside) {
      // A rejected candidate can overlap a later, valid word boundary.
      output += text.slice(position, hit + 1);
      position = hit + 1;
    } else {
      output += text.slice(position, hit) + to;
      count++;
      position = end;
    }
  }
  return { text: output + text.slice(position), count };
}

export function planGlossaryReplacement(
  cues: Subtitle[],
  field: SubtitleField,
  from: string,
  to: string,
) {
  let count = 0;
  const changes: Array<{ index: number; before: string; after: string }> = [];
  const next = cues.map((cue, index) => {
    const before = cue[field] || '';
    const result = replaceGlossaryTerm(before, from, to);
    if (!result.count) return cue;
    count += result.count;
    changes.push({ index, before, after: result.text });
    return {
      ...cue,
      [field]: result.text,
      ...(field === 'sourceContent'
        ? { content: result.text.split('\n') }
        : {}),
    };
  });
  return { count, next, changes, snapshot: JSON.stringify(cues) };
}
