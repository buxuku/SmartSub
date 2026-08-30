/**
 * ElevenLabs Scribe ASR service 的纯工具（无网络 / fs / electron），便于 test:engines 单测。
 */
import type { AsrWord } from './types';

const ELEVENLABS_DEFAULT_BASE = 'https://api.elevenlabs.io/v1';

/**
 * 规范化 Base URL：空/非法 → 官方默认；去除误粘的 /speech-to-text 后缀；去尾部斜杠。
 * 与 OpenAI 版不同：base 非必填，缺省回落官方端点。
 */
export function normalizeElevenLabsBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) return ELEVENLABS_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return ELEVENLABS_DEFAULT_BASE;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return ELEVENLABS_DEFAULT_BASE;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = normalizedPath.replace(/\/speech-to-text$/i, '') || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/** 拼接 Scribe 转写端点：`${base}/speech-to-text`。 */
export function buildSpeechToTextURL(baseURL: string): string {
  return `${baseURL.replace(/\/$/, '')}/speech-to-text`;
}

/**
 * Scribe 返回的 words 映射为词级时间戳（秒）。
 * `spacing` 没有语音时间语义，不单独生成词；将连续空白折叠为下一个有效词的前导空格，
 * 供阿拉伯文等不能由下游 ASCII 规则推断词间距的语言保留边界。`audio_event` 仍丢弃；
 * 缺 type 时按有文本+有时间保留。
 */
export function mapElevenLabsWords(raw: unknown): AsrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrWord[] = [];
  let hasPendingSpacing = false;
  for (const w of raw) {
    const type = (w as { type?: unknown })?.type;
    if (type === 'spacing') {
      const spacing = String((w as { text?: unknown })?.text ?? '');
      if (/\s/.test(spacing)) hasPendingSpacing = true;
      continue;
    }
    if (typeof type === 'string' && type !== 'word') continue;
    const word = String((w as { text?: unknown })?.text ?? '').trim();
    if (!word) continue;
    const leadingSpace = hasPendingSpacing ? ' ' : '';
    // spacing 属于紧随其后的词；该词时间非法被丢弃时不能泄漏到更后面的词。
    hasPendingSpacing = false;
    const start = Number((w as { start?: unknown })?.start);
    const end = Number((w as { end?: unknown })?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ word: leadingSpace + word, start, end });
    }
  }
  return out;
}

/** 网络层可重试状态码：429 限流 + 5xx 服务端错误（幂等转写重试安全）。 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
