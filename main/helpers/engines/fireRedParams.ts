import { getNumericSetting } from './transcribeShared';

/**
 * FireRedASR-AED 专属参数映射：SmartSub 统一 settings → sherpa-onnx addon 参数。
 *
 * 与 qwen 的关键差异：
 * - FireRedASR-AED 走 beam search，sherpa 的 `fireRedAsr` 配置**不暴露数值解码超参**
 *   （无 max_new_tokens / temperature 等），故无 qwen 那样的 memset(0) 清零陷阱。
 * - **不接 language**：FireRedASR 内部处理中英，sherpa 配置无 language 字段。
 *
 * 段长安全闸（design D8）：FireRedASR-AED 仅支持 ≤60s 输入（>60s 易幻觉、
 * >200s 触发位置编码错误）。故 fireRed **不沿用 SmartSub「0=不限制」约定**：
 * 默认 30s，且实际生效值硬钳到 (0, 60] —— 0/未设/超限均收敛到安全范围内。
 */

/** FireRedASR-AED 默认最大语音段长（秒）：留足 60s 硬限下的安全裕度。 */
export const FIRERED_DEFAULT_MAX_SPEECH_S = 30;
/** FireRedASR-AED 最大语音段长硬上限（秒）：超过此值模型会幻觉/位置编码报错。 */
export const FIRERED_HARD_MAX_SPEECH_S = 60;

export interface FireRedEngineSettings {
  /** sherpa-onnx provider；本期仅 cpu 落地，cuda 预留未来阶段。 */
  fireRedProvider?: 'cpu' | 'cuda';
  fireRedNumThreads?: number;
  useVAD?: boolean;
  vadThreshold?: number;
  vadMinSilenceDuration?: number;
  vadMinSpeechDuration?: number;
  vadMaxSpeechDuration?: number;
}

export interface FireRedAddonParams {
  provider: string;
  num_threads: number;
  vad_threshold: number;
  vad_min_silence_duration_ms: number;
  vad_min_speech_duration_ms: number;
  vad_max_speech_duration_s: number;
}

/**
 * 段长安全闸：把任意输入收敛到 FireRedASR-AED 安全范围。
 * - 未设/非数值 → 默认 30s；
 * - 0（SmartSub「不限制」语义）或 > 60 → 硬上限 60s（绝不放行不限制）；
 * - (0, 60] → 原样采用。
 */
export function clampFireRedMaxSpeech(raw: unknown): number {
  const v = getNumericSetting(raw, FIRERED_DEFAULT_MAX_SPEECH_S);
  if (v <= 0 || v > FIRERED_HARD_MAX_SPEECH_S) return FIRERED_HARD_MAX_SPEECH_S;
  return v;
}

/** 组装 fireRed 的可选参数（不含 audio_file / 模型文件，由 adapter 注入）。 */
export function buildFireRedParams(
  settings: Record<string, unknown>,
): FireRedAddonParams {
  const s = settings as FireRedEngineSettings;
  return {
    // 本期仅 cpu 落地（design D6）；非法/未设回退 cpu。
    provider: s.fireRedProvider === 'cuda' ? 'cuda' : 'cpu',
    num_threads:
      Number(s.fireRedNumThreads) > 0 ? Number(s.fireRedNumThreads) : 2,
    // VAD 调参复用 SmartSub 统一开关（与 funasr / qwen / faster-whisper 一致）。
    vad_threshold: getNumericSetting(s.vadThreshold, 0.5),
    vad_min_silence_duration_ms: getNumericSetting(
      s.vadMinSilenceDuration,
      100,
    ),
    vad_min_speech_duration_ms: getNumericSetting(s.vadMinSpeechDuration, 250),
    // 段长安全闸：FireRedASR-AED 不允许「不限制」，默认 30s、硬钳 ≤60s。
    vad_max_speech_duration_s: clampFireRedMaxSpeech(s.vadMaxSpeechDuration),
  };
}
