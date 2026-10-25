import type { IFiles } from './index';

export const TASK_RUN_SCHEMA_VERSION = 1;
export type RunStatus =
  | 'preparing'
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'waiting_review'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'interrupted';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'waiting_review'
  | 'cancelled';
export type StageId =
  | 'prepareInput'
  | 'extractAudio'
  | 'extractSubtitle'
  | 'refineSubtitle'
  | 'manuscriptMatch'
  | 'normalizeSubtitle'
  | 'summarizeEpisode'
  | 'translateSubtitle'
  | 'speakerDiarization'
  | 'annotateSpeakers'
  | 'prepareProofread'
  | 'exportSubtitle'
  | 'subtitleReview'
  | 'dubbing'
  | 'dubbingTrack'
  | 'dubbingReview'
  | 'composeVideo';
export type StageOutcome =
  | 'executed'
  | 'reused'
  | 'not_applicable'
  | 'degraded';
export interface StageArtifact {
  id: string;
  path: string;
  digest: string;
  size: number;
  kind: string;
  provenance: 'automatic' | 'manual';
  producer: {
    runId: string;
    fileId: string;
    stageId: StageId;
    fingerprint: string;
  };
}
export interface StageRun {
  id: StageId;
  version: number;
  dependencies: StageId[];
  status: StageStatus;
  attemptId?: string;
  sequence: number;
  progress: number;
  fingerprint?: string;
  outcome?: StageOutcome;
  artifacts: StageArtifact[];
  error?: string;
  reason?: string;
  reusedFrom?: string;
  approvalRevision?: string;
}
export interface FileRun {
  fileId: string;
  input: IFiles;
  inputDigest?: string;
  inputIdentity?: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
  };
  stages: Partial<Record<StageId, StageRun>>;
  /** Disposable compatibility projection. Execution authority is stages. */
  projection: IFiles;
}
export interface TaskRun {
  legacy?: { configurationComplete: false };
  schemaVersion: number;
  projectId: string;
  runId: string;
  /** Submitted display name; existing WorkItem names take precedence. */
  name?: string;
  previousRunId?: string;
  requestId: string;
  requestFingerprint: string;
  config: Record<string, any>;
  resolvedConfig: Record<string, any>;
  status: RunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  files: FileRun[];
  commands: Record<string, { fingerprint: string }>;
}
export interface TaskDraft {
  revision: number;
  basedOnRunId?: string;
  config: Record<string, any>;
  files: IFiles[];
}
export interface AttemptToken {
  projectId: string;
  runId: string;
  fileId: string;
  stageId: StageId;
  attemptId: string;
}
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'cancelled',
  'succeeded',
  'failed',
  'interrupted',
];
export const isRunLocked = (run?: Pick<TaskRun, 'status'> | null): boolean =>
  !!run && !TERMINAL_RUN_STATUSES.includes(run.status);

/** Review attention is independent of other files still running in the batch. */
export function hasPendingTaskReview(run?: TaskRun | null): boolean {
  return (
    !!run &&
    ['queued', 'preparing', 'running', 'waiting_review'].includes(run.status) &&
    run.files.some((file) =>
      Object.values(file.stages).some(
        (stage) => stage.status === 'waiting_review',
      ),
    )
  );
}

export function projectRunFiles(run: TaskRun): IFiles[] {
  return run.files.map((file) => ({
    ...file.projection,
    ...Object.fromEntries(
      Object.values(file.stages).flatMap((stage) => [
        [
          stage.id,
          stage.status === 'succeeded'
            ? 'done'
            : stage.status === 'running'
              ? 'loading'
              : ['failed', 'interrupted'].includes(stage.status)
                ? 'error'
                : '',
        ],
        [`${stage.id}Progress`, stage.progress],
        [
          `${stage.id}Error`,
          stage.error ||
            (stage.outcome === 'degraded' ? stage.reason : undefined),
        ],
      ]),
    ),
    taskRunId: run.runId,
    taskRunRevision: run.revision,
    stageRuns: file.stages,
    // A terminal run retains its historical checkpoint, but cannot be released.
    ...(TERMINAL_RUN_STATUSES.includes(run.status)
      ? Object.fromEntries(
          ['subtitleGate', 'dubbingGate'].map((key) => [
            key,
            file.projection[key] === 'review'
              ? 'pending'
              : file.projection[key],
          ]),
        )
      : {}),
    ...(['cancelled', 'interrupted'].includes(run.status) &&
    Object.values(file.stages).some((stage) => stage.status !== 'succeeded')
      ? {
          taskActivity: {
            ...file.projection.taskActivity,
            status: run.status as 'cancelled' | 'interrupted',
          },
        }
      : {}),
  }));
}

/** The plan depends on accepted inputs/configuration, never residual progress fields. */
export function buildFileStagePlan(
  input: IFiles,
  config: Record<string, any>,
): StageId[] {
  const subtitle = /\.(srt|vtt|ass|ssa|lrc|txt)$/i.test(input.filePath || '');
  const provided = Boolean(
    (input as any).subtitleFile || (input as any).providedSubtitlePath,
  );
  const translate =
    config.taskType !== 'generateOnly' && config.translateProvider !== '-1';
  const ids: StageId[] = ['prepareInput'];
  if (!subtitle && (!provided || config.speakerDiarization))
    ids.push('extractAudio');
  ids.push('extractSubtitle');
  if (config.aiCorrection || config.aiSegmentation) ids.push('refineSubtitle');
  const manuscript = (input as any).manuscriptPath ?? config.manuscriptPath;
  if (manuscript && manuscript !== '__none__') ids.push('manuscriptMatch');
  ids.push('normalizeSubtitle');
  if (translate && config.generateSummary) ids.push('summarizeEpisode');
  if (translate) ids.push('translateSubtitle');
  if (config.speakerDiarization && !subtitle)
    ids.push('speakerDiarization', 'annotateSpeakers');
  ids.push('prepareProofread', 'exportSubtitle');
  if ((config.dub || config.compose) && config.gates?.subtitle === 'manual')
    ids.push('subtitleReview');
  if (config.dub) {
    ids.push('dubbing');
  }
  if (config.dub && config.gates?.dubbing === 'manual')
    ids.push('dubbingReview');
  if (config.dub) ids.push('dubbingTrack');
  if (config.compose) {
    ids.push('composeVideo');
  }
  return ids;
}
