/**
 * 各引擎转写实现共用的纯工具：数值兜底、语言归一、SRT 时间格式化、VAD 设置归一、
 * whisper.cpp flash attention 的后端判定。
 * 不依赖任何引擎实现，供 builtin / faster-whisper / localCli 适配器复用。
 */
import type { WhisperBackend } from '../../../types/addon';

export function getNumericSetting(
  value: unknown,
  defaultValue: number,
): number {
  return typeof value === 'number' && isFinite(value) ? value : defaultValue;
}

export function getWhisperLanguage(language?: string): string {
  if (!language || language === 'auto') {
    return 'auto';
  }

  const normalized = language.toLowerCase();
  // 所有中文变体（简体/繁体/台湾/香港等）统一映射为 zh，
  // Whisper 对 zh 的训练数据最充分，识别国语/普通话最准确；
  // 粤语请通过下拉框单独选择 yue 传入。
  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  return normalized;
}

/**
 * 内置 whisper.cpp 是否开启 flash attention（上下文参数 `flash_attn`）。
 *
 * 上游自 v1.8.0 起默认开启。上游同机 A/B 基准里，Metal 与 CUDA 的编码器 / 解码器耗时
 * 都明显下降（CUDA 的基准目前只有 Blackwell 显卡），所以对这两类后端开启。
 * CoreML 的编码器跑在 ANE 上，FA 只作用于走 Metal 的解码器。
 *
 * 其余后端维持原行为（关闭）——没有收益数据，或存在已知风险：
 * - cpu：没有基准数据；
 * - vulkan：已发布 addon 的 ggml 早于 Vulkan FA 共享内存越界写的修复
 *   （llama.cpp #29988，症状为 NVIDIA DeviceLost 崩溃，随 whisper.cpp v1.9.5 发布）；
 * - custom：用户自备的 addon，构建版本未知。
 * 放开其它后端前，应先用对应后端的 addon 做 A/B（耗时 + 转写文本）。
 *
 * 本应用只用普通 token_timestamps；FA 只与 DTW token 时间戳互斥，不受影响。
 */
export function shouldUseFlashAttn(backend: WhisperBackend): boolean {
  return backend === 'metal' || backend === 'coreml' || backend === 'cuda';
}

export function secondsToSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export interface VadSettings {
  useVAD: boolean;
  vadThreshold: number;
  vadMinSpeechDuration: number;
  vadMinSilenceDuration: number;
  vadMaxSpeechDuration: number;
  vadSpeechPad: number;
  vadSamplesOverlap: number;
}

/** 抗幻觉/抗重复总开关（全局设置 settings.reduceRepetition）。 */
export function isReduceRepetitionEnabled(
  settings: Record<string, unknown> | undefined,
): boolean {
  return settings?.reduceRepetition === true;
}

/**
 * faster-whisper 的抗幻觉/抗重复参数包：仅在开关开启时返回覆盖值，
 * 关闭时返回空对象（sidecar 缺键回落 faster-whisper 默认，行为不变）。
 * - condition_on_previous_text=false：断开上文喂入，最有效地打断重复/幻觉级联
 * - no_repeat_ngram_size=3 / repetition_penalty=1.1：禁止重复 n-gram、惩罚重复 token
 * - hallucination_silence_threshold=2.0：跳过长静音（依赖 word_timestamps，已开）
 */
export function getFasterWhisperAntiRepetitionParams(
  settings: Record<string, unknown> | undefined,
): Record<string, number | boolean> {
  if (!isReduceRepetitionEnabled(settings)) return {};
  return {
    condition_on_previous_text: false,
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.1,
    hallucination_silence_threshold: 2.0,
  };
}

/** 从 store 的 settings 归一化出 VAD 参数（各引擎再映射到自己的字段名）。 */
export function getVadSettings(settings: Record<string, unknown>): VadSettings {
  return {
    useVAD: settings?.useVAD !== false,
    vadThreshold: getNumericSetting(settings?.vadThreshold, 0.5),
    vadMinSpeechDuration: getNumericSetting(
      settings?.vadMinSpeechDuration,
      250,
    ),
    vadMinSilenceDuration: getNumericSetting(
      settings?.vadMinSilenceDuration,
      100,
    ),
    vadMaxSpeechDuration: getNumericSetting(settings?.vadMaxSpeechDuration, 0),
    vadSpeechPad: getNumericSetting(settings?.vadSpeechPad, 200),
    vadSamplesOverlap: getNumericSetting(settings?.vadSamplesOverlap, 0.1),
  };
}
