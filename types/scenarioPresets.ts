export type ScenarioPresetId =
  | 'interview'
  | 'lecture'
  | 'movie'
  | 'balanced'
  | 'custom';

export interface ScenarioPresetFields {
  subtitleOutcome?: 'accurate' | 'balanced' | 'clean' | 'custom';
  fasterWhisperBeamSize?: number;
  fasterWhisperTemperature?: number;
  fasterWhisperCompressionRatioThreshold?: number;
  fasterWhisperLogProbThreshold?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  [key: string]: unknown;
}

export interface ScenarioPresetDef {
  id: ScenarioPresetId;
  nameKey: string;
  descKey: string;
  iconName: string;
  fields: ScenarioPresetFields;
}
