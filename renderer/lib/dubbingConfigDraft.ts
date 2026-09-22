import type { DubbingConfigDraft } from '../../types/dubbingConfigDraft';
export * from '../../types/dubbingConfigDraft';
export const dubbingConfigDraftKey = (sessionId: string) =>
  `smartsub_dubbing_config_draft_v1:${sessionId}`;

export function writeDubbingConfigDraft(
  sessionId: string,
  expected: string | null,
  draft: DubbingConfigDraft | null,
): string | null {
  const key = dubbingConfigDraftKey(sessionId);
  if (localStorage.getItem(key) !== expected)
    throw new Error('Dubbing configuration draft changed in another editor');
  const raw = draft ? JSON.stringify(draft) : null;
  if (raw === null) localStorage.removeItem(key);
  else localStorage.setItem(key, raw);
  return raw;
}
