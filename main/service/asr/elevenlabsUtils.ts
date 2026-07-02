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
 * 仅保留 `type === 'word'`（丢弃 `spacing` / `audio_event`）；缺 type 时按有文本+有时间保留。
 * 空白 token 一律丢弃，交由下游 needsSpaceBefore 复原空格。
 */
export function mapElevenLabsWords(raw: unknown): AsrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrWord[] = [];
  for (const w of raw) {
    const type = (w as { type?: unknown })?.type;
    if (typeof type === 'string' && type !== 'word') continue;
    const word = String((w as { text?: unknown })?.text ?? '').trim();
    if (!word) continue;
    const start = Number((w as { start?: unknown })?.start);
    const end = Number((w as { end?: unknown })?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ word, start, end });
    }
  }
  return out;
}

/** 网络层可重试状态码：429 限流 + 5xx 服务端错误（幂等转写重试安全）。 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
