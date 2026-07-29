/**
 * 克隆参考文本 ASR 的纯工具（无 Electron / ffmpeg 依赖，便于单元测试）。
 */

/**
 * CT2 / ggml 最小模型启发式顺序（tiny → … → large）。
 * 无命中时回落已装列表首项。
 */
export const WHISPER_MODEL_SIZE_ORDER = [
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large-v2',
  'large-v3',
  'large-v3-turbo',
  'large',
] as const;

/** 去掉 ggml 量化后缀后与偏好档对齐，取已装集合中最小档。 */
export function pickSmallestWhisperModel(installed: string[]): string | null {
  if (!installed.length) return null;
  for (const pref of WHISPER_MODEL_SIZE_ORDER) {
    const hit = installed.find((m) => {
      const base = m.toLowerCase().replace(/-q\d+_\d+$/, '');
      return base === pref;
    });
    if (hit) return hit;
  }
  return installed[0];
}

/** 拼接段文本；中文用顿号分隔、其它用逗号。 */
export function joinSegmentTexts(
  segments: Array<{ text?: string } | unknown>,
  language: 'zh' | 'en',
): string {
  const parts = segments
    .map((s) => {
      if (Array.isArray(s)) return String(s[2] ?? '').trim();
      if (s && typeof s === 'object' && 'text' in s) {
        return String((s as { text?: string }).text ?? '').trim();
      }
      return '';
    })
    .filter(Boolean);
  return parts.join(language === 'zh' ? '，' : ', ');
}
