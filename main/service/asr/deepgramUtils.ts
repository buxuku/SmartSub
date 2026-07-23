/**
 * Deepgram（`/v1/listen`）ASR service 的纯工具（无网络 / fs / electron），便于 test:engines 单测。
 */
import type { AsrWord } from './types';

const DEEPGRAM_DEFAULT_BASE = 'https://api.deepgram.com/v1';

/**
 * Deepgram 的日语 punctuated_word 偶尔会把上一句的收尾标点放到下一个词前面，
 * 例如 plain word 为「次」而 punctuated_word 为「。次」。成句器只会把纯标点 token
 * 贴回上一条，因此这里先把「收尾标点 + 正文」拆开并归还给前一个词。
 *
 * 左引号（「『“）不在集合内，避免把新一句的开引号错误移到上一句。
 */
const LEADING_CLOSING_PUNCTUATION =
  /^((?:[。．!！?？…，,、:：;；]+["'」』”’）)\]】》〉〕］}]*|[」』”’）)\]】》〉〕］}]+))(.+)$/u;

function reattachLeadingClosingPunctuation(
  word: string,
  previous?: AsrWord,
): string {
  if (!previous) return word;
  let remaining = word;
  let matched = remaining.match(LEADING_CLOSING_PUNCTUATION);
  while (matched) {
    previous.word = `${previous.word}${matched[1]}`;
    remaining = matched[2];
    matched = remaining.match(LEADING_CLOSING_PUNCTUATION);
  }
  return remaining;
}

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
      const normalizedWord = reattachLeadingClosingPunctuation(
        word,
        out[out.length - 1],
      );
      if (normalizedWord) out.push({ word: normalizedWord, start, end });
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
