import type { FunasrAddonParams } from '../engines/funasrParams';

/**
 * 纯配置映射：FunasrAddonParams → sherpa-onnx VAD / OfflineRecognizer 配置，
 * 以及段时间与进度的数学。无 electron / fs / 原生库依赖，便于单测。
 *
 * 注意：worker（extraResources 纯 JS，不经 webpack）内联了等价逻辑，
 * 两者必须保持一致（见 sherpa-worker.js 的 loadConfigHelpers）。
 */

const SAMPLE_RATE = 16000;
/** SmartSub 约定 0 = 不限制最大语音时长；sherpa 用一个足够大的秒数表达「不限制」。 */
const UNLIMITED_SPEECH_SECONDS = 100000;
/** silero-vad 窗口大小（样本数），sherpa 推荐值。 */
const VAD_WINDOW_SIZE = 512;

export interface VadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
    maxSpeechDuration: number;
  };
  sampleRate: number;
  numThreads: number;
  debug: number;
}

export interface OfflineRecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: {
    senseVoice?: {
      model: string;
      language: string;
      useInverseTextNormalization: number;
    };
    paraformer?: { model: string };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: number;
  };
}

export function buildVadConfig(
  vadModel: string,
  p: FunasrAddonParams,
): VadConfig {
  return {
    sileroVad: {
      model: vadModel,
      threshold: p.vad_threshold,
      minSpeechDuration: p.vad_min_speech_duration_ms / 1000,
      minSilenceDuration: p.vad_min_silence_duration_ms / 1000,
      windowSize: VAD_WINDOW_SIZE,
      maxSpeechDuration:
        p.vad_max_speech_duration_s > 0
          ? p.vad_max_speech_duration_s
          : UNLIMITED_SPEECH_SECONDS,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  };
}

export function buildRecognizerConfig(
  modelType: 'sense_voice' | 'paraformer',
  asrModel: string,
  tokens: string,
  p: FunasrAddonParams,
): OfflineRecognizerConfig {
  const modelConfig: OfflineRecognizerConfig['modelConfig'] = {
    tokens,
    numThreads: p.num_threads,
    provider: p.provider,
    debug: 0,
  };
  if (modelType === 'paraformer') {
    modelConfig.paraformer = { model: asrModel };
  } else {
    modelConfig.senseVoice = {
      model: asrModel,
      // 'auto' → '' 让 SenseVoice 自动检测语言
      language: p.language === 'auto' ? '' : p.language,
      useInverseTextNormalization: p.use_itn ? 1 : 0,
    };
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
  };
}

export interface SegmentTiming {
  start: number;
  end: number;
}

/** VAD 段的样本区间 → 秒。 */
export function segmentTiming(
  startSample: number,
  numSamples: number,
  sampleRate = SAMPLE_RATE,
): SegmentTiming {
  return {
    start: startSample / sampleRate,
    end: (startSample + numSamples) / sampleRate,
  };
}

/** 进度百分比（0..100，整数；total<=0 视为已完成）。 */
export function progressPercent(processed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}
