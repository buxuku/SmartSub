import { getNumericSetting } from './transcribeShared';

/** Parakeet TDT 专属参数映射：SmartSub 统一 settings → sherpa-onnx addon 参数。 */

export interface ParakeetEngineSettings {
  parakeetProvider?: 'cpu' | 'cuda';
  parakeetNumThreads?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  vadMinSilenceDuration?: number;
  vadMinSpeechDuration?: number;
  vadMaxSpeechDuration?: number;
}

export interface ParakeetAddonParams {
  provider: string;
  num_threads: number;
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
}

export function buildParakeetParams(
  settings: Record<string, unknown>,
): ParakeetAddonParams {
  const s = settings as ParakeetEngineSettings;
  return {
    provider: s.parakeetProvider === 'cuda' ? 'cuda' : 'cpu',
    num_threads:
      Number(s.parakeetNumThreads) > 0 ? Number(s.parakeetNumThreads) : 2,
    vad_threshold: getNumericSetting(s.vadThreshold, 0.5),
    vad_min_silence_duration_ms: getNumericSetting(
      s.vadMinSilenceDuration,
      100,
    ),
    vad_min_speech_duration_ms: getNumericSetting(s.vadMinSpeechDuration, 250),
    vad_max_speech_duration_s: getNumericSetting(s.vadMaxSpeechDuration, 0),
  };
}
