export type ScenarioPresetId =
  | 'interview'
  | 'lecture'
  | 'movie'
  | 'shortDrama'
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
  maxContext?: number;
  reduceRepetition?: boolean;
  maxSubtitleChars?: number;
  subtitleMaxDuration?: number;
  subtitleMaxGap?: number;
  preserveSpeechPauses?: boolean;
  speakerDiarization?: boolean;
  speakerDiarizationCount?: number;
  speakerDiarizationEmbedInSubtitle?: boolean;
  aiCorrection?: boolean;
  subtitleFillerPolicy?: 'remove-hesitations' | 'preserve';
  subtitleTranslationStyle?: 'neutral' | 'conversational';
  subtitleLayout?: 'original' | 'two-line';
  subtitleLineWidth?: number;
  [key: string]: unknown;
}

export interface ScenarioPresetDef {
  id: ScenarioPresetId;
  nameKey: string;
  descKey: string;
  iconName: string;
  fields: ScenarioPresetFields;
}
