/**
 * Shared proofread sidecar contract and speaker-domain helpers.
 *
 * Keep this module dependency-free: main, renderer, dubbing and focused Node
 * tests all consume the same normalization rules.
 */

export const PROOFREAD_DATA_VERSION = 2 as const;

export const SPEAKER_COLOR_PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#c026d3',
  '#4f46e5',
] as const;

export interface SpeakerInfo {
  /** Stable, one-based identity. Renaming never changes it. */
  id: number;
  displayName: string;
  color: string;
  /** The UI may localize an automatically generated name without losing intent. */
  autoName?: boolean;
}

export interface ProofreadDataMeta {
  createdAt: string;
  updatedAt: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translateContent?: string;
  outputFormat?: string;
  sourceFile?: string;
  targetFile?: string;
  finalTargetFile?: string;
}

export interface ProofreadDataCue {
  id: string;
  startMs: number;
  endMs: number;
  source: string;
  target: string;
  /** Complete role assignment; absence/empty means the product state "unassigned". */
  speakerIds?: number[];
  /** Explicit primary role. Never infer priority from sorted IDs after editing. */
  primarySpeakerId?: number;
}

export interface ProofreadDataFileV1 {
  version: 1;
  meta: ProofreadDataMeta;
  cues: ProofreadDataCue[];
}

export interface ProofreadDataFileV2 {
  version: typeof PROOFREAD_DATA_VERSION;
  meta: ProofreadDataMeta;
  speakers: SpeakerInfo[];
  cues: ProofreadDataCue[];
}

export type ProofreadDataFileInput = ProofreadDataFileV1 | ProofreadDataFileV2;

export interface SpeakerAssignableCue {
  speakerIds?: readonly number[];
  primarySpeakerId?: number;
}

export function isValidSpeakerId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

/** Deduplicate positive integer IDs while preserving their semantic order. */
export function normalizeSpeakerIds(
  values: readonly unknown[] | null | undefined,
): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values || []) {
    if (!isValidSpeakerId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizePrimarySpeakerId(
  primarySpeakerId: unknown,
  speakerIds: readonly number[],
): number | undefined {
  return isValidSpeakerId(primarySpeakerId) &&
    speakerIds.includes(primarySpeakerId)
    ? primarySpeakerId
    : speakerIds[0];
}

export function defaultSpeakerColor(id: number): string {
  return SPEAKER_COLOR_PALETTE[
    (Math.max(1, id) - 1) % SPEAKER_COLOR_PALETTE.length
  ];
}

export function defaultSpeakerName(id: number): string {
  return `Speaker ${id}`;
}

export function createDefaultSpeaker(
  id: number,
  displayName = defaultSpeakerName(id),
): SpeakerInfo {
  return {
    id,
    displayName,
    color: defaultSpeakerColor(id),
    autoName: true,
  };
}

export function sanitizeSpeakerDisplayName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function normalizeSpeakerInfo(value: unknown): SpeakerInfo | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<SpeakerInfo>;
  if (!isValidSpeakerId(input.id)) return null;
  const name = sanitizeSpeakerDisplayName(input.displayName);
  const color =
    typeof input.color === 'string' &&
    SPEAKER_COLOR_PALETTE.includes(input.color as any)
      ? input.color
      : defaultSpeakerColor(input.id);
  return {
    id: input.id,
    displayName: name || defaultSpeakerName(input.id),
    color,
    ...(input.autoName === true ? { autoName: true } : {}),
  };
}

export function normalizeSpeakerAssignment<T extends SpeakerAssignableCue>(
  cue: T,
): T {
  const speakerIds = normalizeSpeakerIds(cue.speakerIds);
  const primarySpeakerId = normalizePrimarySpeakerId(
    cue.primarySpeakerId,
    speakerIds,
  );
  const result = { ...cue } as T & {
    speakerIds?: number[];
    primarySpeakerId?: number;
  };
  if (speakerIds.length) {
    result.speakerIds = speakerIds;
    result.primarySpeakerId = primarySpeakerId;
  } else {
    delete result.speakerIds;
    delete result.primarySpeakerId;
  }
  return result;
}

export function orderedSpeakerIds(cue: SpeakerAssignableCue): number[] {
  const ids = normalizeSpeakerIds(cue.speakerIds);
  const primary = normalizePrimarySpeakerId(cue.primarySpeakerId, ids);
  return primary ? [primary, ...ids.filter((id) => id !== primary)] : ids;
}

/** Render user-facing names only at the deliverable boundary. */
export function prefixTextWithSpeakerNames(
  text: string,
  cue: SpeakerAssignableCue,
  speakers: readonly SpeakerInfo[],
): string {
  const ids = orderedSpeakerIds(cue);
  if (!ids.length) return text;
  const speakerById = new Map(speakers.map((speaker) => [speaker.id, speaker]));
  const names = ids.map((id) => {
    const name = speakerById.get(id)?.displayName || defaultSpeakerName(id);
    return name.replace(/\[/g, '［').replace(/\]/g, '］');
  });
  return `[${names.join(' + ')}] ${text}`.trimEnd();
}

export function normalizeSpeakerRoster(
  speakers: readonly unknown[] | null | undefined,
  cues: readonly SpeakerAssignableCue[],
): SpeakerInfo[] {
  const roster: SpeakerInfo[] = [];
  const seen = new Set<number>();
  for (const raw of speakers || []) {
    const speaker = normalizeSpeakerInfo(raw);
    if (!speaker || seen.has(speaker.id)) continue;
    seen.add(speaker.id);
    roster.push(speaker);
  }
  const referenced = new Set<number>();
  for (const cue of cues) {
    for (const id of normalizeSpeakerIds(cue.speakerIds)) referenced.add(id);
  }
  for (const id of Array.from(referenced).sort((a, b) => a - b)) {
    if (seen.has(id)) continue;
    seen.add(id);
    roster.push(createDefaultSpeaker(id));
  }
  return roster;
}

/** Accept v1/v2 sidecars and return the single canonical v2 shape. */
export function normalizeProofreadData(input: unknown): ProofreadDataFileV2 {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid proofread data');
  }
  const raw = input as Partial<ProofreadDataFileInput> & {
    version?: unknown;
    cues?: unknown;
    meta?: unknown;
    speakers?: unknown;
  };
  if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.cues)) {
    throw new Error('Unsupported proofread data version');
  }
  const cues = raw.cues.map((value, index) => {
    const cue = (value || {}) as Partial<ProofreadDataCue>;
    const normalized = normalizeSpeakerAssignment({
      id: String(cue.id || index + 1),
      startMs: Number.isFinite(cue.startMs) ? Number(cue.startMs) : 0,
      endMs: Number.isFinite(cue.endMs) ? Number(cue.endMs) : 0,
      source: String(cue.source ?? ''),
      target: String(cue.target ?? ''),
      speakerIds: cue.speakerIds,
      primarySpeakerId: cue.primarySpeakerId,
    });
    return normalized as ProofreadDataCue;
  });
  const metaInput =
    raw.meta && typeof raw.meta === 'object'
      ? (raw.meta as Partial<ProofreadDataMeta>)
      : {};
  const now = new Date(0).toISOString();
  const meta: ProofreadDataMeta = {
    ...metaInput,
    createdAt: String(metaInput.createdAt || now),
    updatedAt: String(metaInput.updatedAt || metaInput.createdAt || now),
  };
  return {
    version: PROOFREAD_DATA_VERSION,
    meta,
    speakers: normalizeSpeakerRoster(
      raw.version === 2 && Array.isArray(raw.speakers) ? raw.speakers : [],
      cues,
    ),
    cues,
  };
}

export function nextSpeakerId(speakers: readonly SpeakerInfo[]): number {
  const used = new Set(speakers.map((speaker) => speaker.id));
  let id = 1;
  while (used.has(id)) id += 1;
  return id;
}

export function countSpeakerCues(
  cues: readonly SpeakerAssignableCue[],
  speakerId: number,
): number {
  return cues.filter((cue) =>
    normalizeSpeakerIds(cue.speakerIds).includes(speakerId),
  ).length;
}

/** Move every source assignment to target, preserving overlap and explicit primary. */
export function moveSpeakerAssignments<T extends SpeakerAssignableCue>(
  cues: readonly T[],
  sourceId: number,
  targetId: number,
): T[] {
  if (sourceId === targetId) return cues.map((cue) => ({ ...cue }));
  return cues.map((cue) => {
    const ids = normalizeSpeakerIds(cue.speakerIds);
    if (!ids.includes(sourceId)) return { ...cue };
    const replaced = normalizeSpeakerIds(
      ids.map((id) => (id === sourceId ? targetId : id)),
    );
    return normalizeSpeakerAssignment({
      ...cue,
      speakerIds: replaced,
      primarySpeakerId:
        cue.primarySpeakerId === sourceId ? targetId : cue.primarySpeakerId,
    });
  });
}

export function speakerListsEqual(
  left: readonly SpeakerInfo[],
  right: readonly SpeakerInfo[],
): boolean {
  return (
    left.length === right.length &&
    left.every((speaker, index) => {
      const other = right[index];
      return (
        speaker.id === other?.id &&
        speaker.displayName === other.displayName &&
        speaker.color === other.color &&
        Boolean(speaker.autoName) === Boolean(other.autoName)
      );
    })
  );
}
