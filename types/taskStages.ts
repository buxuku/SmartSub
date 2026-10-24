/** Shared stage vocabulary. Empty legacy fields are not evidence of execution. */
export const TASK_STAGE_LABELS = {
  prepareInput: 'runs.stages.prepareInput',
  extractAudio: 'stage.extract',
  extractSubtitle: 'stage.transcribe',
  prepareSubtitle: 'stage.extract',
  refineSubtitle: 'stage.refine',
  manuscriptMatch: 'stage.manuscript',
  normalizeSubtitle: 'runs.stages.normalizeSubtitle',
  summarizeEpisode: 'stage.summarize',
  translateSubtitle: 'stage.translate',
  speakerDiarization: 'stage.speakerDiarization',
  annotateSpeakers: 'runs.stages.annotateSpeakers',
  prepareProofread: 'runs.stages.prepareProofread',
  exportSubtitle: 'stage.export',
  dubbing: 'stage.dubbing',
  dubbingTrack: 'runs.stages.dubbingTrack',
  composeVideo: 'stage.compose',
} as const;

export type TaskStageKey = keyof typeof TASK_STAGE_LABELS;
export const TASK_STAGE_KEYS = Object.keys(TASK_STAGE_LABELS) as TaskStageKey[];
export type LegacyStageStatus = 'loading' | 'done' | 'error';

export function hasStageEvidence(value: unknown): value is LegacyStageStatus {
  return value === 'loading' || value === 'done' || value === 'error';
}

export function isTaskSubtitleInput(filePath?: string): boolean {
  return /\.(srt|vtt|ass|ssa|lrc|txt)$/i.test(filePath || '');
}

/** Explicit config wins. Only old records without that setting use real evidence. */
export function getTaskFileStageKeys(
  file: Record<string, any>,
  config?: Record<string, any> | null,
  taskType = config?.taskType || 'generateAndTranslate',
): TaskStageKey[] {
  if (file?.stageRuns)
    return Object.keys(file.stageRuns).filter(
      (id): id is TaskStageKey => id in TASK_STAGE_LABELS,
    );
  const stages: TaskStageKey[] = [];
  const subtitle = isTaskSubtitleInput(file?.filePath);
  const supplied = Boolean(file?.providedSubtitlePath);
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(config || {}, key);
  const optional = (key: TaskStageKey, settings: string[], enabled: boolean) =>
    settings.some(has) ? enabled : hasStageEvidence(file?.[key]);
  if (!subtitle && !supplied) {
    stages.push('extractAudio', 'extractSubtitle');
    if (
      optional(
        'refineSubtitle',
        ['aiSegmentation', 'aiCorrection'],
        config?.aiSegmentation === true || config?.aiCorrection === true,
      )
    )
      stages.push('refineSubtitle');
    const binding = file?.manuscriptPath ?? config?.manuscriptPath;
    const bound =
      Object.prototype.hasOwnProperty.call(file || {}, 'manuscriptPath') ||
      has('manuscriptPath');
    if (
      bound
        ? Boolean(binding && binding !== '__none__')
        : hasStageEvidence(file?.manuscriptMatch)
    )
      stages.push('manuscriptMatch');
  } else if (!subtitle && supplied && config?.speakerDiarization === true) {
    stages.push('extractAudio');
  }
  const translating =
    taskType !== 'generateOnly' && config?.translateProvider !== '-1';
  if (translating) {
    if (
      optional(
        'summarizeEpisode',
        ['generateSummary'],
        config?.generateSummary === true,
      )
    )
      stages.push('summarizeEpisode');
    stages.push('translateSubtitle');
  }
  if (
    !subtitle &&
    taskType !== 'translateOnly' &&
    optional(
      'speakerDiarization',
      ['speakerDiarization'],
      config?.speakerDiarization === true,
    )
  )
    stages.push('speakerDiarization');
  if (
    hasStageEvidence(file?.exportSubtitle) ||
    file?.exportSubtitle === '' ||
    config?.subtitleOutputFormats?.length > 1
  )
    stages.push('exportSubtitle');
  if (optional('dubbing', ['dub'], Boolean(config?.dub)))
    stages.push('dubbing');
  if (optional('composeVideo', ['compose'], Boolean(config?.compose)))
    stages.push('composeVideo');
  return stages;
}

/** Explicit undefined crosses the legacy merge boundary; deleting local keys cannot. */
export function clearInactiveTaskStages(
  file: Record<string, any>,
  config: Record<string, any>,
): void {
  const active = new Set(getTaskFileStageKeys(file, config, config.taskType));
  for (const key of [
    'refineSubtitle',
    'manuscriptMatch',
    'summarizeEpisode',
    'speakerDiarization',
    'dubbing',
    'composeVideo',
  ] as const) {
    if (active.has(key)) continue;
    file[key] = undefined;
    file[`${key}Progress`] = undefined;
    file[`${key}Error`] = undefined;
  }
}
