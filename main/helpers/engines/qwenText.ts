/**
 * Qwen3-ASR 解码原文常带聊天模板前缀，例如：
 *   language Chinese<asr_text>所以
 *   **language Chinese<asr_text>开玩笑 **
 * 剥掉语种头、asr_text 标签和装饰星号，只留听写正文。
 *
 * 静音/幻听时还会整条吐出拉丁碎片（demand、imageUrl、Finds.）。
 * 第一性：没有汉字的单 token 默认不是中文课听写；
 * 只保留公式字母、数学符号名、口语短回应和正常英文句子。
 */

const QWEN_TEMPLATE_LEFTOVER =
  /^(?:language|chinese|english|none|zh|en|auto)$/i;

/** 中文 STEM 课里单独出现也合理的拉丁短词。 */
const QWEN_LATIN_KEEP = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'yeah',
  'yep',
  'nope',
  'right',
  'so',
  'well',
  'um',
  'uh',
  'ah',
  'oh',
  'wow',
  'next',
  'thanks',
  'hello',
  'hi',
  'bye',
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'theta',
  'lambda',
  'mu',
  'nu',
  'xi',
  'pi',
  'rho',
  'sigma',
  'tau',
  'phi',
  'psi',
  'chi',
  'eta',
  'omega',
]);

function stripCueDecorations(text: string): string {
  return text
    .replace(/^[("'“‘]+/, '')
    .replace(/[)"'”’.,!?。！？]+$/, '')
    .trim();
}

function isFormulaToken(token: string): boolean {
  return (
    /^[A-Za-z]$/.test(token) ||
    /^[A-Za-z]\d{1,3}$/.test(token) ||
    /^[A-Z]{2,4}$/.test(token) ||
    /^[A-Z]{2,4}\d{1,3}$/.test(token)
  );
}

function isQwenHallucinatedCue(text: string): boolean {
  const token = stripCueDecorations(text);
  if (!token) return true;
  if (QWEN_TEMPLATE_LEFTOVER.test(token)) return true;
  if (/[\u4e00-\u9fff]/.test(text)) return false;
  if (/\s/.test(token)) return false;
  if (/^[\d.]+$/.test(token)) return false;
  if (isFormulaToken(token)) return false;
  if (QWEN_LATIN_KEEP.has(token.toLowerCase())) return false;
  return /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(token);
}

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

  if (isQwenHallucinatedCue(text)) return '';
  return text;
}
