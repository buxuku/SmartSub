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
    /** Qwen3-ASR 四件套 + 自回归解码参数（sherpa-onnx >= 1.12.34）。 */
    qwen3Asr?: {
      convFrontend: string;
      encoder: string;
      decoder: string;
      tokenizer: string;
      maxTotalLen: number;
      maxNewTokens: number;
      temperature: number;
      topP: number;
      seed: number;
    };
    /** FireRedASR-AED：encoder + decoder 两件套（tokens 走顶层 tokens.txt）。 */
    fireRedAsr?: {
      encoder: string;
      decoder: string;
    };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: number;
  };
}

/** buildVadConfig 仅需的 VAD 字段（funasr / qwen 参数均结构兼容）。 */
export interface SherpaVadParams {
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
}

export function buildVadConfig(
  vadModel: string,
  p: SherpaVadParams,
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

/** Qwen3-ASR 解码相关参数（VAD 字段见 SherpaVadParams）。 */
export interface QwenRecognizerParams {
  num_threads: number;
  provider: string;
  max_total_len: number;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  seed: number;
}

/**
 * Qwen3-ASR OfflineRecognizer 配置：四件套（convFrontend/encoder/decoder + tokenizer 目录）
 * 映射到 sherpa 的 `qwen3Asr` 块。Qwen 无 tokens.txt（用 tokenizer 目录），故 tokens 置空。
 *
 * ⚠️ 原生绑定对该 config 先 `memset(0)` 再按存在的键覆盖，故每个数值字段都必须显式给值，
 *    否则 maxTotalLen / maxNewTokens 等会变成 0（而非 C++ 结构体默认值）导致解码失败。
 */
export function buildQwenRecognizerConfig(
  files: {
    convFrontend: string;
    encoder: string;
    decoder: string;
    tokenizer: string;
  },
  p: QwenRecognizerParams,
): OfflineRecognizerConfig {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      qwen3Asr: {
        convFrontend: files.convFrontend,
        encoder: files.encoder,
        decoder: files.decoder,
        tokenizer: files.tokenizer,
        maxTotalLen: p.max_total_len,
        maxNewTokens: p.max_new_tokens,
        temperature: p.temperature,
        topP: p.top_p,
        seed: p.seed,
      },
      tokens: '',
      numThreads: p.num_threads,
      provider: p.provider,
      debug: 0,
    },
  };
}

/** FireRedASR-AED 解码相关参数（VAD 字段见 SherpaVadParams）。 */
export interface FireRedRecognizerParams {
  num_threads: number;
  provider: string;
}

/**
 * FireRedASR-AED OfflineRecognizer 配置：encoder + decoder 两件套映射到 sherpa 的
 * `fireRedAsr` 块，tokens.txt 走**顶层 `tokens`**（与 sense_voice/paraformer 同位，
 * 区别于 qwen 的 tokenizer 目录 + 空 tokens）。AED beam search 无暴露的数值解码超参，
 * 故不存在 qwen 那样的 memset(0) 数值清零陷阱。
 */
export function buildFireRedRecognizerConfig(
  files: {
    encoder: string;
    decoder: string;
  },
  tokens: string,
  p: FireRedRecognizerParams,
): OfflineRecognizerConfig {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      fireRedAsr: {
        encoder: files.encoder,
        decoder: files.decoder,
      },
      tokens,
      numThreads: p.num_threads,
      provider: p.provider,
      debug: 0,
    },
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
