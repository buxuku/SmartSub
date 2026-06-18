import { getNumericSetting } from './transcribeShared';

/**
 * Qwen3-ASR 专属参数映射：SmartSub 统一 settings → sherpa-onnx addon 参数。
 *
 * 解码参数默认值对齐 sherpa-onnx 上游 `OfflineQwen3ASRModelConfig`：
 *   max_total_len=512, max_new_tokens=128, temperature=1e-6, top_p=0.8, seed=42。
 * 注意：Node 绑定对该 config 先 memset(0) 再覆盖存在的键，故每个字段都必须显式给值。
 *
 * 当前范围（P2）：仅 0.6B / CPU / 段级时间戳。语言由 Qwen 内部 prompt 处理，
 * sherpa 的 qwen3Asr 配置不暴露 language 字段，故此处不接收/不映射 sourceLanguage。
 */

export interface QwenEngineSettings {
  /** sherpa-onnx provider；P2 仅 cpu 落地，cuda 预留未来阶段。 */
  qwenProvider?: 'cpu' | 'cuda';
  qwenNumThreads?: number;
  qwenMaxTotalLen?: number;
  qwenMaxNewTokens?: number;
  qwenTemperature?: number;
  qwenTopP?: number;
  qwenSeed?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  vadMinSilenceDuration?: number;
  vadMinSpeechDuration?: number;
  vadMaxSpeechDuration?: number;
}

export interface QwenAddonParams {
  provider: string;
  num_threads: number;
  max_total_len: number;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  seed: number;
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
}

/** 组装 qwen 的可选参数（不含 audio_file / 模型文件，由 adapter 注入）。 */
export function buildQwenParams(
  settings: Record<string, unknown>,
): QwenAddonParams {
  const s = settings as QwenEngineSettings;
  return {
    // P2 仅 cpu 落地（design D7）；非法/未设回退 cpu。
    provider: s.qwenProvider === 'cuda' ? 'cuda' : 'cpu',
    num_threads: Number(s.qwenNumThreads) > 0 ? Number(s.qwenNumThreads) : 2,
    max_total_len: getNumericSetting(s.qwenMaxTotalLen, 512),
    max_new_tokens: getNumericSetting(s.qwenMaxNewTokens, 128),
    temperature: getNumericSetting(s.qwenTemperature, 1e-6),
    top_p: getNumericSetting(s.qwenTopP, 0.8),
    seed: getNumericSetting(s.qwenSeed, 42),
    // VAD 调参复用 SmartSub 统一开关（与 funasr / faster-whisper 一致）。
    vad_threshold: getNumericSetting(s.vadThreshold, 0.5),
    vad_min_silence_duration_ms: getNumericSetting(
      s.vadMinSilenceDuration,
      100,
    ),
    vad_min_speech_duration_ms: getNumericSetting(s.vadMinSpeechDuration, 250),
    // SmartSub 约定 0 = 不限制；addon 侧据此映射。
    vad_max_speech_duration_s: getNumericSetting(s.vadMaxSpeechDuration, 0),
  };
}
