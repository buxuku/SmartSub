/**
 * ggml 模型名（去掉量化后缀后）→ faster-whisper(CT2) 仓库/目录名 的显式映射。
 * 显式优于隐式正则，覆盖 large-v3-turbo 等边界，未来可扩展更多列。
 *
 * 本模块刻意保持「纯」（不依赖 electron/store），便于单元测试直接导入。
 */
export const GGML_TO_CT2: Record<string, string> = {
  tiny: 'tiny',
  'tiny.en': 'tiny.en',
  base: 'base',
  'base.en': 'base.en',
  small: 'small',
  'small.en': 'small.en',
  medium: 'medium',
  'medium.en': 'medium.en',
  'large-v1': 'large-v1',
  'large-v2': 'large-v2',
  'large-v3': 'large-v3',
  'large-v3-turbo': 'large-v3-turbo',
};

/**
 * 把 ggml 模型名（可能含 -q5_0 等量化后缀）解析为 faster-whisper 模型名。
 * 未命中映射表时回退原值（去后缀后）并记日志，避免硬失败。
 */
export function toFasterWhisperModel(model?: string): string {
  const base = (model || 'base').toLowerCase().replace(/-q\d+_\d+$/, '');
  const mapped = GGML_TO_CT2[base];
  if (mapped) return mapped;
  console.warn(
    `faster-whisper model name "${base}" not in GGML_TO_CT2 map, using as-is`,
  );
  return base;
}
