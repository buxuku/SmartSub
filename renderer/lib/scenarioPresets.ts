import type {
  ScenarioPresetId,
  ScenarioPresetDef,
  ScenarioPresetFields,
} from '../../types/scenarioPresets';
import {
  resolveEffectiveSettings,
  TASK_VAD_FIELDS,
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

export function convertToCustomOutcome(
  form: { setValue: (key: string, value: any, options?: any) => void },
  values: Record<string, unknown>,
  settings?: Record<string, unknown>,
): void {
  const effective = resolveEffectiveSettings(values, settings);
  for (const key of [
    'maxContext',
    'useVAD',
    'reduceRepetition',
    ...TASK_VAD_FIELDS,
  ]) {
    if (effective[key] !== undefined)
      form.setValue(key, effective[key], { shouldDirty: true });
  }
  form.setValue('subtitleOutcome', 'custom', { shouldDirty: true });
  form.setValue('scenarioPreset', 'custom', { shouldDirty: true });
}

export function detectCurrentPreset(
  formData: Record<string, any> | undefined,
): ScenarioPresetId {
  if (!formData) return 'balanced';
  if (formData.scenarioPreset === 'custom') return 'custom';

  const targetId: ScenarioPresetId = formData.scenarioPreset || 'balanced';
  const preset = getScenarioPresetDef(targetId);
  if (!preset || targetId === 'custom') return 'custom';

  for (const key of ALL_PRESET_FIELD_KEYS) {
    const expected = preset.fields[key];
    const actual = formData[key];
    if (expected !== undefined) {
      if (actual !== expected) {
        return 'custom';
      }
    } else {
      if (
        actual !== undefined &&
        actual !== null &&
        actual !== '' &&
        actual !== false
      ) {
        return 'custom';
      }
    }
  }

  return targetId;
}
