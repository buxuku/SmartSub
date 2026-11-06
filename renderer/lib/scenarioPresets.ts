import type {
  ScenarioPresetId,
  ScenarioPresetDef,
  ScenarioPresetFields,
} from '../../types/scenarioPresets';
import {
  inferDisplayOutcome,
  resolveEffectiveSettings,
  TASK_VAD_FIELDS,
  type SubtitleOutcome,
} from '../../types/subtitleOutcome';

export type { ScenarioPresetId, ScenarioPresetDef, ScenarioPresetFields };

export const ALL_PRESET_FIELD_KEYS: (keyof ScenarioPresetFields)[] = [
  'subtitleOutcome',
  'fasterWhisperBeamSize',
  'fasterWhisperTemperature',
  'fasterWhisperCompressionRatioThreshold',
  'fasterWhisperLogProbThreshold',
  'useVAD',
  ...TASK_VAD_FIELDS,
  'maxContext',
  'reduceRepetition',
  'maxSubtitleChars',
  'subtitleMaxDuration',
  'subtitleMaxGap',
  'preserveSpeechPauses',
  'speakerDiarization',
  'speakerDiarizationCount',
  'speakerDiarizationEmbedInSubtitle',
  'aiCorrection',
  'subtitleFillerPolicy',
  'subtitleTranslationStyle',
  'subtitleLayout',
  'subtitleLineWidth',
];

export const SCENARIO_PRESETS: ScenarioPresetDef[] = [
  {
    id: 'interview',
    nameKey: 'presets.interview.name',
    descKey: 'presets.interview.desc',
    iconName: 'Mic',
    fields: {
      subtitleOutcome: 'clean',
      fasterWhisperBeamSize: 5,
      fasterWhisperTemperature: 0,
      useVAD: true,
      vadThreshold: 0.35,
      maxSubtitleChars: 28,
      subtitleMaxDuration: 3,
      subtitleMaxGap: 0.25,
      preserveSpeechPauses: true,
      speakerDiarization: true,
      speakerDiarizationCount: 0,
      speakerDiarizationEmbedInSubtitle: false,
    },
  },
  {
    id: 'lecture',
    nameKey: 'presets.lecture.name',
    descKey: 'presets.lecture.desc',
    iconName: 'GraduationCap',
    fields: {
      subtitleOutcome: 'clean',
      useVAD: true,
      aiCorrection: true,
      subtitleFillerPolicy: 'remove-hesitations',
      fasterWhisperBeamSize: 5,
      fasterWhisperTemperature: 0,
      fasterWhisperCompressionRatioThreshold: 2.2,
      fasterWhisperLogProbThreshold: -0.8,
    },
  },
  {
    id: 'movie',
    nameKey: 'presets.movie.name',
    descKey: 'presets.movie.desc',
    iconName: 'Film',
    fields: {
      subtitleOutcome: 'balanced',
      fasterWhisperBeamSize: 3,
      fasterWhisperTemperature: 0.2,
      subtitleFillerPolicy: 'preserve',
      subtitleTranslationStyle: 'conversational',
      subtitleLayout: 'two-line',
      subtitleLineWidth: 42,
    },
  },
  {
    id: 'shortDrama',
    nameKey: 'presets.shortDrama.name',
    descKey: 'presets.shortDrama.desc',
    iconName: 'Clapperboard',
    fields: {
      subtitleOutcome: 'balanced',
      fasterWhisperBeamSize: 3,
      fasterWhisperTemperature: 0.2,
      maxSubtitleChars: 32,
      subtitleMaxDuration: 3,
      subtitleMaxGap: 0.3,
      preserveSpeechPauses: true,
      subtitleFillerPolicy: 'preserve',
      subtitleTranslationStyle: 'conversational',
      subtitleLayout: 'two-line',
      subtitleLineWidth: 32,
    },
  },
  {
    id: 'balanced',
    nameKey: 'presets.balanced.name',
    descKey: 'presets.balanced.desc',
    iconName: 'Sliders',
    fields: {
      subtitleOutcome: 'balanced',
    },
  },
  {
    id: 'custom',
    nameKey: 'presets.custom.name',
    descKey: 'presets.custom.desc',
    iconName: 'Settings2',
    fields: {},
  },
];

export function getScenarioPresetDef(
  id: ScenarioPresetId,
): ScenarioPresetDef | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}

export function applyScenarioPreset(
  form: {
    setValue: (key: string, value: any, options?: any) => void;
    resetField?: (key: string, options?: any) => void;
    getValues?: () => Record<string, unknown>;
  },
  presetId: ScenarioPresetId,
): void {
  const preset = getScenarioPresetDef(presetId);
  if (!preset) return;

  form.setValue('scenarioPreset', presetId, { shouldDirty: true });

  if (presetId === 'custom') {
    const values = form.getValues?.();
    // Legacy/custom tasks still inherit global knobs. Do not freeze invented
    // defaults before the advanced sheet has loaded those settings.
    if (values?.subtitleOutcome && values.subtitleOutcome !== 'custom')
      convertToCustomOutcome(form, values);
    return;
  }

  ALL_PRESET_FIELD_KEYS.forEach((key) => {
    if (preset.fields[key] !== undefined) {
      form.setValue(key as string, preset.fields[key], { shouldDirty: true });
    } else if (key === 'useVAD') {
      form.setValue('useVAD', false, { shouldDirty: true });
    } else {
      if (typeof form.resetField === 'function') {
        form.resetField(key as string, { defaultValue: undefined });
      }
      form.setValue(key as string, undefined, { shouldDirty: true });
    }
  });
}

/**
 * The task-level values 手动调节 owns. `convertToCustomOutcome` writes the effective values
 * of the tier it replaces into them, so the user can tune from there; `leaveCustomOutcome`
 * takes them out again. A built-in tier ignores `maxContext` / `useVAD` / `reduceRepetition`
 * but not the VAD values (`resolveEffectiveSettings` lets task-level VAD values win under
 * every tier), so anything left behind would quietly change what the tier does.
 */
const CUSTOM_OUTCOME_KNOB_KEYS = [
  'maxContext',
  'useVAD',
  'reduceRepetition',
  ...TASK_VAD_FIELDS,
] as const;

export function convertToCustomOutcome(
  form: { setValue: (key: string, value: any, options?: any) => void },
  values: Record<string, unknown>,
  settings?: Record<string, unknown>,
): void {
  const effective = resolveEffectiveSettings(values, settings);
  for (const key of CUSTOM_OUTCOME_KNOB_KEYS) {
    if (effective[key] !== undefined)
      form.setValue(key, effective[key], { shouldDirty: true });
  }
  form.setValue('subtitleOutcome', 'custom', { shouldDirty: true });
  form.setValue('scenarioPreset', 'custom', { shouldDirty: true });
}

/**
 * Pick a built-in recognition strategy while on 手动调节: the task goes back to what that
 * tier does, so the values 手动调节 held are dropped (an `undefined` also takes them out of
 * the remembered task defaults). Only for leaving 手动调节: between built-in tiers the VAD
 * values a scenario set stay, as they always did. `scenarioPreset` stays `custom`, the
 * one-way direction `convertToCustomOutcome` has always had.
 */
export function leaveCustomOutcome(
  form: { setValue: (key: string, value: any, options?: any) => void },
  tier: Exclude<SubtitleOutcome, 'custom'>,
): void {
  for (const key of CUSTOM_OUTCOME_KNOB_KEYS)
    form.setValue(key, undefined, { shouldDirty: true });
  form.setValue('subtitleOutcome', tier, { shouldDirty: true });
}

/**
 * The two fields whose factory default is `0` ("let SmartSub decide": automatic subtitle
 * length, automatic speaker count). Every other unset field is undefined / null / '' / false,
 * so a zero only counts as "not touched" for these two. Reading the zero as a change made
 * every fresh install start on "专家自定义".
 */
const ZERO_IS_UNTOUCHED_KEYS: ReadonlySet<string> = new Set([
  'maxSubtitleChars',
  'speakerDiarizationCount',
]);

function isUntouchedValue(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false)
    return true;
  return value === 0 && ZERO_IS_UNTOUCHED_KEYS.has(key);
}

/**
 * The scenario a task is based on: the one the user picked, 通用均衡 when none was picked,
 * and 'custom' for an explicit 自定义 or an id this version does not know any more.
 */
export function getBaseScenarioPreset(
  formData: Record<string, any> | undefined,
): ScenarioPresetId {
  const id = formData?.scenarioPreset;
  if (!id) return 'balanced';
  return getScenarioPresetDef(id) ? id : 'custom';
}

/**
 * The preset fields that no longer hold what the scenario would set (and the fields the
 * scenario leaves alone but the task has touched), in `ALL_PRESET_FIELD_KEYS` order.
 * Empty when the task is exactly the scenario, and for 'custom', which has nothing to
 * compare against.
 *
 * `subtitleOutcome` is compared as shown on screen: a snapshot saved before the tiers
 * existed has none, and reads as the tier its VAD / context knobs add up to.
 */
export function getPresetDeviations(
  formData: Record<string, any> | undefined,
  presetId?: ScenarioPresetId,
): string[] {
  if (!formData) return [];
  const targetId = presetId ?? getBaseScenarioPreset(formData);
  const preset = getScenarioPresetDef(targetId);
  if (!preset || targetId === 'custom') return [];

  const deviations: string[] = [];
  for (const key of ALL_PRESET_FIELD_KEYS as string[]) {
    const expected = preset.fields[key];
    const actual =
      key === 'subtitleOutcome'
        ? inferDisplayOutcome(formData, undefined)
        : formData[key];
    const deviates =
      expected !== undefined
        ? actual !== expected
        : !isUntouchedValue(key, actual);
    if (deviates) deviations.push(key);
  }
  return deviations;
}

/** Groups a person recognises in the settings, the unit "已调整" counts in. */
export type PresetDeviationGroup =
  | 'recognitionStrategy'
  | 'decoding'
  | 'vadRepetition'
  | 'segmentLength'
  | 'segmentTuning'
  | 'speakerDiarization'
  | 'aiCorrection'
  | 'fillerPolicy'
  | 'translationStyle'
  | 'subtitleLayout';

const DEVIATION_GROUP_BY_KEY: Record<string, PresetDeviationGroup> = {
  subtitleOutcome: 'recognitionStrategy',
  fasterWhisperBeamSize: 'decoding',
  fasterWhisperTemperature: 'decoding',
  fasterWhisperCompressionRatioThreshold: 'decoding',
  fasterWhisperLogProbThreshold: 'decoding',
  useVAD: 'vadRepetition',
  ...Object.fromEntries(
    TASK_VAD_FIELDS.map((key) => [key, 'vadRepetition' as const]),
  ),
  maxContext: 'vadRepetition',
  reduceRepetition: 'vadRepetition',
  maxSubtitleChars: 'segmentLength',
  subtitleMaxDuration: 'segmentTuning',
  subtitleMaxGap: 'segmentTuning',
  preserveSpeechPauses: 'segmentTuning',
  speakerDiarization: 'speakerDiarization',
  speakerDiarizationCount: 'speakerDiarization',
  speakerDiarizationEmbedInSubtitle: 'speakerDiarization',
  aiCorrection: 'aiCorrection',
  subtitleFillerPolicy: 'fillerPolicy',
  subtitleTranslationStyle: 'translationStyle',
  subtitleLayout: 'subtitleLayout',
  subtitleLineWidth: 'subtitleLayout',
};

/** The groups that live on the 专家 page of 更多设置 (the others are on 常用 or the toolbar). */
const EXPERT_PAGE_GROUPS: ReadonlySet<PresetDeviationGroup> =
  new Set<PresetDeviationGroup>([
    'recognitionStrategy',
    'decoding',
    'vadRepetition',
    'segmentTuning',
  ]);

export function isExpertPageGroup(group: PresetDeviationGroup): boolean {
  return EXPERT_PAGE_GROUPS.has(group);
}

/** Folds field keys into the recognisable groups, once each, in first-seen order. */
export function groupPresetDeviations(
  keys: readonly string[],
): PresetDeviationGroup[] {
  const groups: PresetDeviationGroup[] = [];
  for (const key of keys) {
    const group = DEVIATION_GROUP_BY_KEY[key];
    if (group && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

export interface ScenarioState {
  /** The scenario the task is based on ('custom' when the user chose 自定义). */
  presetId: ScenarioPresetId;
  /** The field keys that differ from that scenario; always empty for 'custom'. */
  deviations: string[];
  /** The same differences as the groups a person recognises. */
  groups: PresetDeviationGroup[];
  /** Something differs from the scenario. */
  adjusted: boolean;
  /** Something on the 专家 page differs from the scenario. */
  expertAdjusted: boolean;
}

/** What the scenario button, the summary strip and the 专家 tab dot all read from. */
export function getScenarioState(
  formData: Record<string, any> | undefined,
): ScenarioState {
  const presetId = getBaseScenarioPreset(formData);
  const deviations = getPresetDeviations(formData, presetId);
  const groups = groupPresetDeviations(deviations);
  return {
    presetId,
    deviations,
    groups,
    adjusted: groups.length > 0,
    expertAdjusted: groups.some(isExpertPageGroup),
  };
}

export function detectCurrentPreset(
  formData: Record<string, any> | undefined,
): ScenarioPresetId {
  if (!formData) return 'balanced';
  const presetId = getBaseScenarioPreset(formData);
  if (presetId === 'custom') return 'custom';
  return getPresetDeviations(formData, presetId).length > 0
    ? 'custom'
    : presetId;
}
