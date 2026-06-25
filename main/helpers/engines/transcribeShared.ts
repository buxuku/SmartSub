/**
 * 各引擎转写实现共用的纯工具：数值兜底、语言归一、SRT 时间格式化、VAD 设置归一。
 * 不依赖任何引擎实现，供 builtin / faster-whisper / localCli 适配器复用。
 */

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

export function secondsToSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export type AlignMode = 'hybrid' | 'run' | 'word' | 'legacy';
const ALIGN_MODES: readonly AlignMode[] = ['hybrid', 'run', 'word', 'legacy'];

export interface VadSettings {
  useVAD: boolean;
  vadThreshold: number;
  vadMinSpeechDuration: number;
  vadMinSilenceDuration: number;
  vadMaxSpeechDuration: number;
  vadSpeechPad: number;
  vadSamplesOverlap: number;
  /** [仅内置 whisper.cpp] 时间轴对齐策略（faster-whisper 自带词级对齐，忽略此项）。 */
  alignMode: AlignMode;
  /** [仅内置 whisper.cpp] 相邻 VAD 段合并阈值(ms)，更大间隔成为真实空档。 */
  vadMergeGap: number;
  /** [仅内置 whisper.cpp] word/hybrid 模式词级切分阈值(ms)。 */
  wordGap: number;
}

/** 归一化对齐模式：非法/缺省回落 hybrid。 */
export function getAlignMode(value: unknown): AlignMode {
  return ALIGN_MODES.includes(value as AlignMode)
    ? (value as AlignMode)
    : 'hybrid';
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
    alignMode: getAlignMode(settings?.alignMode),
    vadMergeGap: getNumericSetting(settings?.vadMergeGap, 2000),
    wordGap: getNumericSetting(settings?.wordGap, 500),
  };
}
