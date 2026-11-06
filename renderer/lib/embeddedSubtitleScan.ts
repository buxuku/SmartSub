import type { TaskTypeDef } from './taskTypes';
import { isSubtitleFile } from './utils';
import {
  EMBEDDED_SCAN_RESPONSE_TIMEOUT_MS,
  type EmbeddedSubtitleHit,
  type EmbeddedSubtitleScanResult,
  type EmbeddedSubtitleTrackInfo,
} from '../../types/embeddedSubtitle';

export interface EmbeddedSubtitleScanInput {
  typeDef: Pick<TaskTypeDef, 'needsModel'>;
  files: Array<{ filePath: string; providedSubtitlePath?: string }>;
  /** Only `useEmbeddedSubtitles` is read. */
  formData: Record<string, any>;
}

/**
 * The files worth probing before a start, decided without any IPC. Empty means "do not
 * ask": the task does not transcribe, the user already forced speech recognition, or
 * every file is a subtitle / has a paired subtitle (the same predicate as
 * `needsTranscription` in `validateTaskConfigReady`). The main process narrows this to
 * containers that can carry subtitles.
 */
export function embeddedSubtitleProbeFiles({
  typeDef,
  files,
  formData,
}: EmbeddedSubtitleScanInput): string[] {
  if (!typeDef.needsModel) return [];
  if (formData.useEmbeddedSubtitles === false) return [];
  return files
    .filter(
      (file) =>
        Boolean(file?.filePath) &&
        !isSubtitleFile(file.filePath) &&
        !file.providedSubtitlePath,
    )
    .map((file) => file.filePath);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('scan timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Probe the start list for a file with an extractable embedded text subtitle. Resolves
 * to the first hit, or `null` for everything else: nothing to probe, the prompt was
 * switched off, nothing found, budget exhausted, IPC failure. It never rejects and never
 * waits longer than the main-process budget plus a little: asking is a courtesy and must
 * not be able to hold the Start button.
 */
export async function findEmbeddedSubtitleHit(
  input: EmbeddedSubtitleScanInput,
): Promise<EmbeddedSubtitleHit | null> {
  const filePaths = embeddedSubtitleProbeFiles(input);
  if (!filePaths.length) return null;
  try {
    const settings = await window.ipc.invoke('getSettings');
    if (settings?.embeddedSubtitlePrompt === false) return null;
    const result: EmbeddedSubtitleScanResult | undefined = await withTimeout(
      window.ipc.invoke('findEmbeddedSubtitles', { filePaths }),
      EMBEDDED_SCAN_RESPONSE_TIMEOUT_MS,
    );
    const hit = result?.hit;
    return result?.status === 'found' &&
      typeof hit?.filePath === 'string' &&
      Array.isArray(hit.tracks) &&
      hit.tracks.length > 0
      ? hit
      : null;
  } catch {
    return null;
  }
}

const CODEC_LABELS: Record<string, string> = {
  subrip: 'SubRip',
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  mov_text: 'MOV Text',
  webvtt: 'WebVTT',
  text: 'Text',
};

/** `English · SubRip`; an unknown language code is shown as it is, a missing one as `unknownLanguage`. */
export function describeEmbeddedTrack(
  track: EmbeddedSubtitleTrackInfo,
  locale: string,
  unknownLanguage: string,
): string {
  const codec = CODEC_LABELS[track.codec] ?? track.codec.toUpperCase();
  let language = unknownLanguage;
  if (track.language) {
    language = track.language;
    try {
      language =
        new Intl.DisplayNames([locale], { type: 'language' }).of(
          track.language,
        ) || track.language;
    } catch {
      /* A code Intl rejects is still better shown raw than dropped. */
    }
  }
  return `${language} · ${codec}`;
}

/** The file name of a path from either platform. */
export function embeddedSubtitleFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}
