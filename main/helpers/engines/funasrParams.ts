import { getNumericSetting } from './transcribeShared';

/** funasr/SenseVoice 专属参数映射：SmartSub 统一 settings → sidecar funasr 参数。 */

/** SmartSub 语言 → SenseVoice 语言标签（auto|zh|yue|en|ja|ko）。 */
export function getFunasrLanguage(language?: string): string {
  if (!language || language === 'auto') return 'auto';
  const n = language.toLowerCase();
  if (n.startsWith('yue') || n === 'zh-hk' || n === 'zh-yue') return 'yue';
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('en')) return 'en';
  if (n.startsWith('ja')) return 'ja';
  if (n.startsWith('ko')) return 'ko';
  return 'auto';
}

export interface FunasrEngineSettings {
  funasrUseItn?: boolean;
  /** sherpa-onnx provider；P1 仅 cpu 落地，cuda/coreml 预留 */
  funasrProvider?: 'cpu' | 'cuda' | 'coreml';
  funasrNumThreads?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  vadMinSilenceDuration?: number;
  vadMinSpeechDuration?: number;
  vadMaxSpeechDuration?: number;
}

export interface FunasrSidecarParams {
  language: string;
  use_itn: boolean;
  provider: string;
  num_threads: number;
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
}

/** 组装 funasr sidecar 的可选参数（不含 audio_file / 模型文件，由 adapter 注入）。 */
export function buildFunasrParams(
  settings: Record<string, unknown>,
  sourceLanguage?: string,
): FunasrSidecarParams {
  const s = settings as FunasrEngineSettings;
  return {
    language: getFunasrLanguage(sourceLanguage), // 'auto' → 引擎侧归一为 '' 自动
    use_itn: s.funasrUseItn !== false, // 默认开 ITN
    provider: s.funasrProvider || 'cpu',
    num_threads:
      Number(s.funasrNumThreads) > 0 ? Number(s.funasrNumThreads) : 2,
    // VAD 调参复用 SmartSub 统一开关（与 faster-whisper 一致；sidecar 缺省也安全）。
    vad_threshold: getNumericSetting(s.vadThreshold, 0.5),
    vad_min_silence_duration_ms: getNumericSetting(
      s.vadMinSilenceDuration,
      100,
    ),
    vad_min_speech_duration_ms: getNumericSetting(s.vadMinSpeechDuration, 250),
    // SmartSub 约定 0 = 不限制；sidecar 侧据此映射。
    vad_max_speech_duration_s: getNumericSetting(s.vadMaxSpeechDuration, 0),
  };
}
