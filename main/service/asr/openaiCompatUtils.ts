/**
 * OpenAI 兼容 ASR service 的纯工具（无网络 / fs / electron），便于 test:engines 单测。
 */
import type { AsrSegment, AsrWord } from './types';

/**
 * 规范化 Base URL：必须 http(s)；去除误粘的 /audio/transcriptions 后缀；去尾部斜杠。
 */
export function normalizeBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) {
    throw new Error('Cloud ASR: API base URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      'Cloud ASR: API base URL must start with http:// or https://',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(
      'Cloud ASR: API base URL must start with http:// or https://',
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(normalizedPath)) {
    parsed.pathname =
      normalizedPath.replace(/\/audio\/transcriptions$/i, '') || '/';
  } else {
    parsed.pathname = normalizedPath || '/';
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ISO-639-1 语言提示：'auto'/空 → undefined（让服务自动检测）；zh-CN → zh。 */
export function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const lower = language.toLowerCase();
  if (lower === 'auto') return undefined;
  return lower.slice(0, 2);
}

export function mapWords(raw: unknown): AsrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrWord[] = [];
  for (const w of raw) {
    const word = String((w as { word?: unknown })?.word ?? '');
    const start = Number((w as { start?: unknown })?.start);
    const end = Number((w as { end?: unknown })?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ word, start, end });
    }
  }
  return out;
}

export function mapSegments(raw: unknown): AsrSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrSegment[] = [];
  for (const s of raw) {
    const text = String((s as { text?: unknown })?.text ?? '');
    const start = Number((s as { start?: unknown })?.start);
    const end = Number((s as { end?: unknown })?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ start, end, text });
    }
  }
  return out;
}

/** 是否为「服务不支持 verbose_json / timestamp_granularities」→ 据此降级到 plain json。 */
export function isVerboseUnsupportedError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 400 || status === 422) return true;
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes('verbose_json') ||
    message.includes('timestamp_granularities') ||
    message.includes('response_format') ||
    message.includes('granularit')
  );
}
