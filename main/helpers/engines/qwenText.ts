/**
 * Qwen3-ASR 解码原文常带聊天模板前缀，例如：
 *   language Chinese<asr_text>所以
 *   **language Chinese<asr_text>开玩笑 **
 * 剥掉语种头、asr_text 标签和装饰星号，只留听写正文。
 */
export function sanitizeQwenAsrText(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let text = raw;
  if (/<\s*asr_text\s*>/i.test(text)) {
    const parts = text.split(/<\s*asr_text\s*>/i);
    text = parts[parts.length - 1] ?? '';
  }

  text = text.replace(/<\s*\/\s*asr_text\s*>/gi, '');
  text = text
    .replace(/^\*+\s*/, '')
    .replace(/\s*\*+$/, '')
    .trim();

  if (
    /^language\s*[:：]?\s*[A-Z][A-Za-z]+(?:[\s-][A-Z][A-Za-z]+){0,2}$/.test(
      text,
    )
  ) {
    return '';
  }

  return text;
}
