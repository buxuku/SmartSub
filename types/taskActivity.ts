/** Observable execution details; elapsed time is never a progress estimate. */
export type ActivityPhase =
  | 'idle'
  | 'checking'
  | 'queued'
  | 'preparing'
  | 'loadingModel'
  | 'readingAudio'
  | 'recognizing'
  | 'requesting'
  | 'reviewing'
  | 'segmenting'
  | 'correcting'
  | 'translating'
  | 'repairing'
  | 'validating'
  | 'aligning'
  | 'interval'
  | 'retrying'
  | 'organizing'
  | 'saving';

export interface ActivityUnit {
  id: number;
  phase: ActivityPhase;
  startedAt: number;
  requestStartedAt?: number;
  retry?: number;
  maxRetries?: number;
  reason?: 'validation' | 'request';
  waitUntil?: number;
}

export interface ActivityDetail {
  phase: ActivityPhase;
  completed?: number;
  total?: number;
  unit?: 'batches' | 'cues' | 'chunks';
  processedSeconds?: number;
  durationSeconds?: number;
  units?: ActivityUnit[];
  sourceSaved?: boolean;
  coremlFirstRun?: boolean;
  /** Translation batches are received before they can be flushed in source order. */
  savedBatches?: number;
  failedCues?: number;
  summary?: {
    segmentation?: { total: number; accepted: number; fallback: number };
    correctionFailed?: number;
    saveFailed?: boolean;
  };
}

export interface TaskActivity extends ActivityDetail {
  run: number;
  sequence: number;
  stage: 'extractSubtitle' | 'refineSubtitle' | 'translateSubtitle' | null;
  status:
    | 'running'
    | 'cancelling'
    | 'done'
    | 'error'
    | 'cancelled'
    | 'interrupted';
  startedAt: number;
  phaseStartedAt: number;
  updatedAt: number;
}

export function latestTaskActivity(
  current: TaskActivity | undefined,
  incoming: TaskActivity | undefined,
): TaskActivity | undefined {
  if (!incoming) return current;
  if (
    !current ||
    incoming.run > current.run ||
    (incoming.run === current.run && incoming.sequence > current.sequence)
  )
    return incoming;
  return current;
}

/** Optional observer shared by engine/AI runners, independent of Electron. */
export type ActivityObserver = (detail: ActivityDetail) => void;
