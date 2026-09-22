import type { SubtitleOutcome } from '../../types/subtitleOutcome';

export {
  inferDisplayOutcome,
  isSherpaEngineId as isSherpaEngine,
  outcomeSupportsContextKnobs,
  resolveEffectiveSettings,
  TASK_VAD_FIELDS,
  TASK_VAD_SPECS,
  supportsTaskVadField,
  type SubtitleOutcome,
} from '../../types/subtitleOutcome';

export const SUBTITLE_OUTCOME_TIERS: Exclude<SubtitleOutcome, 'custom'>[] = [
  'accurate',
  'balanced',
  'clean',
];
