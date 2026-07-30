import { stripSpeakerLabelPrefix } from '../speakerDiarization/alignment';

/**
 * 配音引擎实际朗读的文本规范化。
 *
 * 说话者标签属于字幕展示元数据，不应进入 TTS；其余文本仍沿用原有的换行折叠与
 * 首尾空白清理行为。
 */
export function normalizeDubbingSpeechText(text: string): string {
  const flattened = (text || '').replace(/\n+/g, ' ').trim();
  return stripSpeakerLabelPrefix(flattened).trim();
}
