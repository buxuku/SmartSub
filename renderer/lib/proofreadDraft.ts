import type { Subtitle } from '../hooks/useSubtitles';
import type { SpeakerInfo } from '../../types/proofreadData';

export interface ProofreadDraft {
  subtitles: Subtitle[];
  speakers: SpeakerInfo[];
  embedSpeakerNames: boolean;
  savedAt: number;
}

const memory = new Map<string, ProofreadDraft>();

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
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (
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
    memory.set(key, draft);
    return draft;
  } catch {
    return null;
  }
}

export function writeProofreadDraft(
  key: string,
  draft: ProofreadDraft,
): boolean {
  memory.set(key, draft);
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearProofreadDraft(key: string): void {
  memory.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // The editor still remains usable when browser storage is unavailable.
  }
}
