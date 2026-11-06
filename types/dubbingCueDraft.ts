import { z } from 'zod';

const entrySchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  baseText: z.string().max(100000),
  text: z.string().max(100000),
});

export interface DubbingCueTextEdit {
  index: number;
  startMs: number;
  endMs: number;
  baseText: string;
  text: string;
}

export function parseDubbingCueEdits(value: unknown): DubbingCueTextEdit[] {
  const edits = z.array(entrySchema).max(100000).parse(value);
  if (new Set(edits.map((entry) => entry.index)).size !== edits.length)
    throw new Error('Duplicate dubbing cue edit');
  return edits.map((edit) => ({
    index: edit.index,
    startMs: edit.startMs,
    endMs: edit.endMs,
    baseText: edit.baseText,
    text: edit.text,
  }));
}

export interface DubbingCueDraft {
  version: 1;
  sessionId: string;
  revision: number;
  entries: DubbingCueTextEdit[];
}

export function parseDubbingCueDraft(
  raw: string,
  sessionId: string,
): DubbingCueDraft {
  const draft = z
    .object({
      version: z.literal(1),
      sessionId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      entries: z.unknown(),
    })
    .parse(JSON.parse(raw));
  if (draft.sessionId !== sessionId)
    throw new Error('Dubbing draft belongs to another project');
  return {
    version: 1,
    sessionId: draft.sessionId,
    revision: draft.revision,
    entries: parseDubbingCueEdits(draft.entries),
  };
}

export const dubbingCueDraftKey = (sessionId: string) =>
  `smartsub_dubbing_cue_draft_v1:${sessionId}`;
