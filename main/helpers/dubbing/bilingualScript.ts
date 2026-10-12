import type { SubtitleCue } from '../subtitleFormats';
import type {
  ProofreadDataFileV2,
  ProofreadDataMeta,
} from '../../../types/proofreadData';
import type { BilingualCueDisplay } from '../../../types/dubbing';
import { subtitleOutputFilesToSave } from '../../../types/subtitleOutput';
import { normalizeTtsLanguage } from '../../../types/ttsLanguage';
import { alignSidecarCues, normalizeForCompare } from './speakerMetadata';

/**
 * Which line of a bilingual subtitle is the translation.
 *
 * The pipeline rebuilds a pure-translation subtitle before it dubs; the
 * workbench dubs whatever file the user loaded. A proofread sidecar tells us
 * which files the app delivered and in which order (source first or
 * translation first). The spoken text itself always comes from the loaded
 * file, so a subtitle that was edited by hand still works.
 */

export type BilingualContentType = 'sourceAndTranslate' | 'translateAndSource';

export interface DubbingScriptCue {
  /** The text to speak, on one line. */
  text: string;
  /** Present when the translation lines of a bilingual cue were located. */
  display?: BilingualCueDisplay;
}

export interface DubbingScript {
  /** One entry per parsed cue, in order. */
  cues: DubbingScriptCue[];
  /** Set when the sidecar identifies the subtitle as a bilingual deliverable. */
  bilingual?: BilingualContentType;
  /** Cues of a bilingual subtitle whose translation lines were not found. */
  unresolved: number[];
  /** The sidecar's target language; only set for a bilingual deliverable. */
  targetLanguage?: string;
}

/**
 * The bilingual layout of `subtitlePath` when the sidecar lists it as one of
 * the task's bilingual deliverables, otherwise undefined. Pure translations
 * and source-language files are never bilingual, even if they share a path.
 */
export function bilingualContentType(
  meta: ProofreadDataMeta,
  subtitlePath: string,
): BilingualContentType | undefined {
  const content = meta.translateContent;
  if (content !== 'sourceAndTranslate' && content !== 'translateAndSource') {
    return undefined;
  }
  const target = normalizeForCompare(subtitlePath);
  if (target === null) return undefined;
  const samePath = (candidate: string | undefined) =>
    normalizeForCompare(candidate) === target;
  const outputs = subtitleOutputFilesToSave(meta, content);
  if (
    samePath(meta.sourceFile) ||
    samePath(meta.targetFile) ||
    outputs.some(
      (output) => output.contentType === 'source' && samePath(output.filePath),
    )
  ) {
    return undefined;
  }
  const delivered = [
    meta.finalTargetFile,
    ...outputs
      .filter((output) => output.contentType === content)
      .map((output) => output.filePath),
  ];
  return delivered.some(samePath) ? content : undefined;
}

const squash = (text: string): string => text.replace(/\s+/g, '');
const flatten = (text: string): string => text.replace(/\n+/g, ' ').trim();
const textLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The lines of a bilingual cue that hold the translation.
 *
 * The delivery puts the translation at one end (the end for
 * `sourceAndTranslate`, the start for `translateAndSource`), so only a block
 * at that end can match. The sidecar's translation is tried first; when it was
 * edited by hand, the sidecar's source text identifies the other block
 * instead. Whitespace is ignored because the delivery layout collapses the
 * line breaks inside a column (without a space between CJK characters).
 */
function locateTranslation(
  lines: readonly string[],
  order: BilingualContentType,
  sidecarSource: string,
  sidecarTarget: string,
): { from: number; to: number } | undefined {
  const total = lines.length;
  const flat = lines.map(squash);
  const atEnd = order === 'sourceAndTranslate';
  const translation = (count: number) =>
    atEnd ? { from: total - count, to: total } : { from: 0, to: count };

  const target = squash(sidecarTarget);
  if (target) {
    for (let count = 1; count <= total; count++) {
      const block = atEnd ? flat.slice(total - count) : flat.slice(0, count);
      if (block.join('') === target) return translation(count);
    }
  }
  const source = squash(sidecarSource);
  if (source) {
    // At least one line has to be left over for the translation.
    for (let count = 1; count < total; count++) {
      const block = atEnd ? flat.slice(0, count) : flat.slice(total - count);
      if (block.join('') === source) return translation(total - count);
    }
  }
  return undefined;
}

/**
 * The text to dub for every cue of `subtitlePath`.
 *
 * Only a subtitle the sidecar lists as a bilingual deliverable is changed:
 * each cue is reduced to its translation lines. A cue whose translation cannot
 * be located keeps its whole text (the previous behaviour) and is reported in
 * `unresolved`. Everything else keeps each cue's text on a single line.
 */
export function resolveDubbingScript(
  subtitlePath: string,
  parsedCues: readonly SubtitleCue[],
  sidecar: ProofreadDataFileV2 | null | undefined,
): DubbingScript {
  const order = sidecar
    ? bilingualContentType(sidecar.meta, subtitlePath)
    : undefined;
  if (!sidecar || !order) {
    return {
      cues: parsedCues.map((cue) => ({ text: flatten(cue.text) })),
      unresolved: [],
    };
  }

  const aligned = alignSidecarCues(parsedCues, sidecar.cues);
  const unresolved: number[] = [];
  const cues = parsedCues.map((cue, index): DubbingScriptCue => {
    const lines = textLines(cue.text);
    if (!lines.length) return { text: '' };
    const sidecarIndex = aligned[index];
    const sidecarCue =
      sidecarIndex === undefined ? undefined : sidecar.cues[sidecarIndex];
    const range = sidecarCue
      ? locateTranslation(lines, order, sidecarCue.source, sidecarCue.target)
      : undefined;
    if (!range) {
      unresolved.push(index);
      return { text: flatten(cue.text) };
    }
    return {
      text: lines.slice(range.from, range.to).join(' '),
      display: { lines, from: range.from, to: range.to },
    };
  });
  return {
    cues,
    bilingual: order,
    unresolved,
    targetLanguage: normalizeTtsLanguage(sidecar.meta.targetLanguage),
  };
}

/**
 * The text of a cue in the exported shifted subtitle.
 *
 * Dubbing speaks only the translation of a bilingual cue, but the subtitle
 * exported next to the dub keeps the layout of the file that was loaded. A cue
 * that was not edited is restored verbatim; after an edit in the workbench the
 * new text replaces only the translation lines.
 */
export function composeDisplayText(cue: {
  text: string;
  display?: BilingualCueDisplay;
}): string {
  const { display } = cue;
  if (!display) return cue.text;
  const spoken = display.lines.slice(display.from, display.to).join(' ');
  if (cue.text === spoken) return display.lines.join('\n');
  const edited = flatten(cue.text);
  return [
    ...display.lines.slice(0, display.from),
    ...(edited ? [edited] : []),
    ...display.lines.slice(display.to),
  ].join('\n');
}
