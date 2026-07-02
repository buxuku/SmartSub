/**
 * Deepgram（`/v1/listen`）ASR service 的纯工具（无网络 / fs / electron），便于 test:engines 单测。
 */
import type { AsrWord } from './types';

const DEEPGRAM_DEFAULT_BASE = 'https://api.deepgram.com/v1';

/**
 * 规范化 Base URL：空/非法 → 官方默认；去除误粘的 /listen 后缀；去尾部斜杠。
 * base 非必填，缺省回落官方端点。
 */
export function normalizeDeepgramBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) return DEEPGRAM_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEEPGRAM_DEFAULT_BASE;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return DEEPGRAM_DEFAULT_BASE;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = normalizedPath.replace(/\/listen$/i, '') || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * 拼接 `/listen` 端点 + 查询：
 * - smart_format/punctuate 开启（拿到 punctuated_word 与更好的断句）；
 * - 指定 language 则传 language，否则 detect_language=true（自动识别）。
 */
export function buildListenURL(
  baseURL: string,
  opts: { model: string; language?: string },
): string {
  const params = new URLSearchParams();
  params.set('model', opts.model);
  params.set('smart_format', 'true');
  params.set('punctuate', 'true');
  if (opts.language) params.set('language', opts.language);
  else params.set('detect_language', 'true');
  return `${baseURL.replace(/\/$/, '')}/listen?${params.toString()}`;
}

/** Deepgram 词映射：优先 punctuated_word（含标点/大小写），回落 word；秒级、过滤非有限时间。 */
export function mapDeepgramWords(raw: unknown): AsrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrWord[] = [];
  for (const w of raw) {
    const punctuated = (w as { punctuated_word?: unknown })?.punctuated_word;
    const plain = (w as { word?: unknown })?.word;
    const word = String(punctuated ?? plain ?? '').trim();
    if (!word) continue;
    const start = Number((w as { start?: unknown })?.start);
    const end = Number((w as { end?: unknown })?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ word, start, end });
    }
  }
  return out;
}

/**
 * 从 Deepgram 响应提取 { text, words, language }。
 * 结构：results.channels[0].alternatives[0].{transcript,words[]}；语言在 channels[0].detected_language。
 */
export function extractDeepgramResult(data: unknown): {
  text: string;
  words: AsrWord[];
  language?: string;
} {
  const channel = (
    data as {
      results?: { channels?: Array<Record<string, unknown>> };
    }
  )?.results?.channels?.[0];
  const alt = (
    channel as { alternatives?: Array<Record<string, unknown>> } | undefined
  )?.alternatives?.[0];
  const text = String((alt as { transcript?: unknown })?.transcript ?? '');
  const words = mapDeepgramWords((alt as { words?: unknown })?.words);
  const detected = (channel as { detected_language?: unknown })
    ?.detected_language;
  return {
    text,
    words,
    language: typeof detected === 'string' ? detected : undefined,
  };
}

/** 网络层可重试状态码：429 限流 + 5xx 服务端错误。 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
