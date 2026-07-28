/**
 * faster-whisper sidecar 支持透传的任务级高级参数。
 *
 * 未设置（undefined）时不向 sidecar 下发字段，让 faster-whisper 使用自身默认值；
 * 非数字、非有限值、超出保守范围或整数参数传小数时同样忽略，避免导入/历史配置
 * 绕过 UI 校验。beam_size / best_of 需要包含对应白名单的新版 runtime。
 */
export const FASTER_WHISPER_ADVANCED_PARAM_SPECS = [
  {
    settingKey: 'fasterWhisperBeamSize',
    runtimeKey: 'beam_size',
    min: 1,
    max: 20,
    step: 1,
    integer: true,
    engineDefault: 5,
  },
  {
    settingKey: 'fasterWhisperBestOf',
    runtimeKey: 'best_of',
    min: 1,
    max: 20,
    step: 1,
    integer: true,
    engineDefault: 5,
  },
  {
    settingKey: 'fasterWhisperTemperature',
    runtimeKey: 'temperature',
    min: 0,
    max: 1,
    step: 0.1,
    integer: false,
    engineDefault: [0, 0.2, 0.4, 0.6, 0.8, 1] as const,
  },
  {
    settingKey: 'fasterWhisperCompressionRatioThreshold',
    runtimeKey: 'compression_ratio_threshold',
    min: 0,
    max: 10,
    step: 0.1,
    integer: false,
    engineDefault: 2.4,
  },
  {
    settingKey: 'fasterWhisperLogProbThreshold',
    runtimeKey: 'log_prob_threshold',
    min: -5,
    max: 0,
    step: 0.1,
    integer: false,
    engineDefault: -1,
  },
  {
    settingKey: 'fasterWhisperNoSpeechThreshold',
    runtimeKey: 'no_speech_threshold',
    min: 0,
    max: 1,
    step: 0.1,
    integer: false,
    engineDefault: 0.6,
  },
] as const;

export type FasterWhisperAdvancedParamSpec =
  (typeof FASTER_WHISPER_ADVANCED_PARAM_SPECS)[number];

export type FasterWhisperAdvancedSettingKey =
  (typeof FASTER_WHISPER_ADVANCED_PARAM_SPECS)[number]['settingKey'];

export type FasterWhisperAdvancedRuntimeKey =
  (typeof FASTER_WHISPER_ADVANCED_PARAM_SPECS)[number]['runtimeKey'];

export type FasterWhisperAdvancedParams = Partial<
  Record<FasterWhisperAdvancedRuntimeKey, number>
>;

/** 高级解码字段只对 faster-whisper 有效；其它引擎不展示、也不消费。 */
export function supportsFasterWhisperAdvancedParams(
  engine: unknown,
): engine is 'fasterWhisper' {
  return engine === 'fasterWhisper';
}

export function isValidFasterWhisperAdvancedParamValue(
  value: unknown,
  spec: Pick<FasterWhisperAdvancedParamSpec, 'min' | 'max' | 'integer'>,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= spec.min &&
    value <= spec.max &&
    (!spec.integer || Number.isInteger(value))
  );
}

/**
 * 把任务表单中的命名空间字段映射为 sidecar 参数。
 * 返回值只含经过类型与范围校验的显式设置；空对象即完全沿用引擎默认行为。
 */
export function buildFasterWhisperAdvancedParams(
  config: Record<string, unknown> | undefined,
): FasterWhisperAdvancedParams {
  const params: Record<string, number> = {};
  for (const spec of FASTER_WHISPER_ADVANCED_PARAM_SPECS) {
    const value = config?.[spec.settingKey];
    if (isValidFasterWhisperAdvancedParamValue(value, spec)) {
      params[spec.runtimeKey] = value;
    }
  }
  return params as FasterWhisperAdvancedParams;
}
