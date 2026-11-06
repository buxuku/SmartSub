/**
 * Pre-start probe for embedded subtitles: the request and result shared by the main
 * process (which runs ffmpeg) and the renderer (which decides whether to ask the user).
 * Kept dependency-free so both sides use the same budget numbers.
 */

/** A text subtitle track that can be extracted straight to SRT. */
export interface EmbeddedSubtitleTrackInfo {
  /** ISO 639-2 tag such as `eng` / `chi`; absent when missing or `und`. */
  language?: string;
  /** Lower-case codec name such as `subrip` / `ass` / `mov_text`. */
  codec: string;
}

export interface EmbeddedSubtitleHit {
  filePath: string;
  /** Text tracks only, in stream order; the pipeline extracts the first one. */
  tracks: EmbeddedSubtitleTrackInfo[];
}

export interface EmbeddedSubtitleScanRequest {
  filePaths: string[];
}

/**
 * - `found`: at least one file carries a usable text track (`hit` is set).
 * - `none`: every candidate was probed and none has one.
 * - `unknown`: the budget ran out (or the scan was aborted) before every candidate was
 *   probed. Callers treat it exactly like `none`: never block, never ask.
 */
export type EmbeddedSubtitleScanStatus = 'found' | 'none' | 'unknown';

export interface EmbeddedSubtitleScanResult {
  status: EmbeddedSubtitleScanStatus;
  hit?: EmbeddedSubtitleHit;
  /** Probes that ran to completion (the hit included). */
  checked: number;
  /** Files whose container can carry subtitles, i.e. the ones worth probing. */
  candidates: number;
  elapsedMs: number;
}

/** Files probed at the same time; gains flatten out past this and disks get crowded. */
export const EMBEDDED_SCAN_CONCURRENCY = 4;

/** Hard cap of the whole scan in the main process; running out means "no answer". */
export const EMBEDDED_SCAN_BUDGET_MS = 1000;

/**
 * How long the renderer waits for the main process to answer, a little beyond the
 * budget so a normal "budget exhausted" answer still arrives; a main process that never
 * answers must not hold the Start button either.
 */
export const EMBEDDED_SCAN_RESPONSE_TIMEOUT_MS = EMBEDDED_SCAN_BUDGET_MS + 500;

/** Upper bound of paths accepted in one request. */
export const EMBEDDED_SCAN_MAX_PATHS = 1000;
