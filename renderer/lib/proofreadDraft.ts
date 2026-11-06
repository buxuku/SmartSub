import {
  parseQualityReview,
  compactQualityReview,
  type QualityReviewState,
} from '../../types/qualityReview';
import type { Subtitle } from '../hooks/useSubtitles';
import type { SpeakerInfo } from '../../types/proofreadData';

export interface ProofreadDraft {
  subtitles: Subtitle[];
  speakers: SpeakerInfo[];
  embedSpeakerNames: boolean;
  savedAt: number;
  qualityReview?: QualityReviewState;
}

const memory = new Map<string, ProofreadDraft>();
const chunkSize = 128;
const reviewSerialized = new WeakMap<QualityReviewState, string>();
function serializeReview(review?: QualityReviewState) {
  if (!review) return '';
  let raw = reviewSerialized.get(review);
  if (!raw) {
    raw = JSON.stringify(compactQualityReview(review));
    reviewSerialized.set(review, raw);
  }
  return `,"qualityReview":${raw}`;
}
const serialized = new Map<string, { rows: Subtitle[]; chunks: string[] }>();

export function proofreadDraftKey(config: {
  sourceSubtitlePath?: string;
  targetSubtitlePath?: string;
  proofreadDataFile?: string;
}): string {
  return `smartsub_proofread_draft_v1:${JSON.stringify([
    config.proofreadDataFile || '',
    config.sourceSubtitlePath || '',
    config.targetSubtitlePath || '',
  ])}`;
}

export function readProofreadDraft(key: string): ProofreadDraft | null {
  if (memory.has(key)) return memory.get(key)!;
  const storage = window.ipc?.proofreadDraft;
  const result = storage?.read(key);
  if (result?.success === false) throw new Error(result.error);
  try {
    // Missing native file may be an older installation. A native tombstone
    // ('null') is authoritative even if Chromium retained an old value.
    const raw = result?.raw ?? window.localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (
      !draft ||
      !Array.isArray(draft.subtitles) ||
      !draft.subtitles.every(
        (row: Subtitle) =>
          row &&
          typeof row.startEndTime === 'string' &&
          Array.isArray(row.content) &&
          Number.isFinite(row.startTimeInSeconds) &&
          Number.isFinite(row.endTimeInSeconds),
      ) ||
      !Array.isArray(draft.speakers) ||
      typeof draft.embedSpeakerNames !== 'boolean' ||
      !Number.isFinite(draft.savedAt)
    )
      return null;
    if (draft.qualityReview) {
      try {
        draft.qualityReview = parseQualityReview(draft.qualityReview);
      } catch {
        // Optional derived metadata must never hide valid subtitle edits.
        delete draft.qualityReview;
      }
    }
    memory.set(key, draft);
    return draft;
  } catch {
    return null;
  }
}

function serializeDraft(key: string, draft: ProofreadDraft): string {
  const previous = serialized.get(key);
  const chunks: string[] = [];
  for (let start = 0; start < draft.subtitles.length; start += chunkSize) {
    const rows = draft.subtitles.slice(start, start + chunkSize);
    const unchanged =
      previous &&
      Math.min(chunkSize, previous.rows.length - start) === rows.length &&
      rows.every((row, offset) => row === previous.rows[start + offset]);
    chunks.push(
      unchanged
        ? previous.chunks[chunks.length]
        : JSON.stringify(rows).slice(1, -1),
    );
  }
  serialized.set(key, { rows: draft.subtitles, chunks });
  // Reuse serialized immutable rows, but keep a single atomic storage value.
  // Cross-window writes cannot leave an index referencing retired chunks.
  return `{"subtitles":[${chunks.join(',')}],"speakers":${JSON.stringify(draft.speakers)},"embedSpeakerNames":${JSON.stringify(draft.embedSpeakerNames)},"savedAt":${JSON.stringify(draft.savedAt)}${serializeReview(draft.qualityReview)}}`;
}

export function writeProofreadDraft(
  key: string,
  draft: ProofreadDraft,
): boolean {
  memory.set(key, draft);
  try {
    const raw = serializeDraft(key, draft);
    const storage = window.ipc?.proofreadDraft;
    if (storage) {
      const result = storage.write(key, raw);
      if (result.success !== true) return false;
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* Legacy cleanup only. */
      }
    } else {
      window.localStorage.setItem(key, raw);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearProofreadDraft(key: string): void {
  const result = window.ipc?.proofreadDraft?.write(key, null);
  if (result?.success === false) throw new Error(result.error);
  memory.delete(key);
  serialized.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // The editor still remains usable when browser storage is unavailable.
  }
}
