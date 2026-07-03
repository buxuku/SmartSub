/**
 * Gladia v2 pre-recorded ASR service 的纯工具（无网络 / fs / electron），便于 test:engines 单测。
 *
 * 接口形态（2026-07 实测）：
 * - 鉴权：`x-gladia-key` 头，无签名；
 * - 流程：POST /v2/upload（multipart）→ POST /v2/pre-recorded（JSON, audio_url）
 *   → GET /v2/pre-recorded/{id} 轮询 status（queued/processing/done/error）；
 * - 词级时间戳：utterances[].words[]，拉丁词自带前导空格、标点内联（"识别、"/" recognition,"）。
 */
import type { AsrSegment, AsrWord } from './types';

export const GLADIA_DEFAULT_BASE = 'https://api.gladia.io';
export const GLADIA_UPLOAD_PATH = '/v2/upload';
export const GLADIA_PRERECORDED_PATH = '/v2/pre-recorded';

/**
 * 连通性探针用的固定「不存在 job id」：有效 key 过鉴权后报 404（job 不存在）即证明
 * 凭据可用；无效 key 得 401（"gladia user not found"）。零成本——不上传、不建任务、不计费。
 */
export const GLADIA_PROBE_JOB_ID = '00000000-0000-4000-8000-000000000000';

/** 模型清单（服务端校验实测枚举）：solaria-1 全语种默认档；solaria-3 欧语实录特化档。 */
export const GLADIA_MODELS = ['solaria-1', 'solaria-3'] as const;
export const GLADIA_DEFAULT_MODEL = 'solaria-1';

/**
 * 规范化 Base URL：空/非法 → 官方默认；去除误粘的 /v2（及其子路径）后缀；去尾部斜杠。
 * base 非必填，缺省回落官方端点（走反向代理时才需要填写）。
 */
export function normalizeGladiaBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) return GLADIA_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return GLADIA_DEFAULT_BASE;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return GLADIA_DEFAULT_BASE;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = normalizedPath.replace(/\/v2(\/.*)?$/i, '') || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/** 已知模型原样保留（宽容大小写/空白），未知/缺省回落 solaria-1（全语种默认档）。 */
export function normalizeGladiaModel(model?: string): string {
  const m = String(model ?? '')
    .trim()
    .toLowerCase();
  return (GLADIA_MODELS as readonly string[]).includes(m)
    ? m
    : GLADIA_DEFAULT_MODEL;
}

/**
 * Gladia 支持语种（language_config.languages 服务端校验枚举，2026-07 实测抓取）。
 * 多为 ISO-639-1 两字母码，含少量三字母（haw）与遗留码（jw 爪哇语）。
 */
export const GLADIA_LANGUAGES = new Set([
  'af',
  'am',
  'ar',
  'as',
  'az',
  'ba',
  'be',
  'bg',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fo',
  'fr',
  'gl',
  'gu',
  'ha',
  'haw',
  'he',
  'hi',
  'hr',
  'ht',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'jw',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'la',
  'lb',
  'ln',
  'lo',
  'lt',
  'lv',
  'mg',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'ne',
  'nl',
  'nn',
  'no',
  'oc',
  'pa',
  'pl',
  'ps',
  'pt',
  'ro',
  'ru',
  'sa',
  'sd',
  'si',
  'sk',
  'sl',
  'sn',
  'so',
  'sq',
  'sr',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'tk',
  'tl',
  'tr',
  'tt',
  'uk',
  'ur',
  'uz',
  'vi',
  'yi',
  'yo',
  'zh',
]);

export type GladiaLanguageResolution =
  | { kind: 'auto' }
  | { kind: 'ok'; code: string }
  | { kind: 'unsupported'; code: string };

/**
 * 任务原语言 → Gladia 语言参数（上传前守卫）：
 * - 'auto'/空 → 自动检测（不传 language_config）；
 * - 取主语言子标签（zh-CN → zh）后查支持清单，命中即传（提升准确率与省一次检测）；
 * - 不支持（如 yue 粤语）→ unsupported，调用方报可行动错误（继续上传只会产出乱码还照常计费）。
 */
export function resolveGladiaLanguage(
  language?: string,
): GladiaLanguageResolution {
  const raw = String(language ?? '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'auto') return { kind: 'auto' };
  const primary = raw.split(/[-_]/)[0];
  if (GLADIA_LANGUAGES.has(primary)) return { kind: 'ok', code: primary };
  return { kind: 'unsupported', code: raw };
}

/**
 * 建任务请求体：audio_url + model 必传；已知语言传 language_config.languages 单元素
 * （code_switching 维持服务端默认 false），未知语言整体省略 → 服务端自动检测。
 */
export function buildGladiaInitBody(opts: {
  audioUrl: string;
  model: string;
  language?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audio_url: opts.audioUrl,
    model: opts.model,
  };
  if (opts.language) {
    body.language_config = { languages: [opts.language] };
  }
  return body;
}

/** HTTP 状态分类：401/403 鉴权；408/429/5xx 可重试；其余 4xx（含 400 参数错）致命。 */
export function classifyGladiaStatus(
  status: number,
): 'auth' | 'retriable' | 'fatal' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return 'retriable';
  }
  return 'fatal';
}

/** 轮询 404 = 任务不存在/已失效（续查场景回落新上传）。 */
export function isGladiaJobGone(status: number): boolean {
  return status === 404;
}

export interface GladiaExtractedResult {
  text: string;
  words: AsrWord[];
  segments: AsrSegment[];
  language?: string;
  duration?: number;
}

/**
 * 从轮询完成体提取 { text, words, segments, language, duration }：
 * - words 拍平自 utterances[].words（trim 掉拉丁词自带的前导空格，交由内置管线统一补空格）；
 * - utterances 本身充当段级结果（有 start/end/text，词级缺失时降级可用）；
 * - 任意字段缺失/形态异常 → 安全空值（不抛错）。
 */
export function extractGladiaResult(data: unknown): GladiaExtractedResult {
  const result = (data as { result?: Record<string, unknown> })?.result;
  const transcription = result?.transcription as
    | {
        full_transcript?: unknown;
        languages?: unknown;
        utterances?: unknown;
      }
    | undefined;
  const metadata = result?.metadata as { audio_duration?: unknown } | undefined;

  const text = String(transcription?.full_transcript ?? '');
  const languages = Array.isArray(transcription?.languages)
    ? (transcription?.languages as unknown[])
    : [];
  const language =
    typeof languages[0] === 'string' ? (languages[0] as string) : undefined;
  const durationRaw = Number(metadata?.audio_duration);
  const duration = Number.isFinite(durationRaw) ? durationRaw : undefined;

  const utterances = Array.isArray(transcription?.utterances)
    ? (transcription?.utterances as Array<Record<string, unknown>>)
    : [];
  const words: AsrWord[] = [];
  const segments: AsrSegment[] = [];
  for (const u of utterances) {
    const uStart = Number(u?.start);
    const uEnd = Number(u?.end);
    const uText = String(u?.text ?? '').trim();
    if (Number.isFinite(uStart) && Number.isFinite(uEnd) && uText) {
      segments.push({ start: uStart, end: uEnd, text: uText });
    }
    const rawWords = Array.isArray(u?.words)
      ? (u.words as Array<Record<string, unknown>>)
      : [];
    for (const w of rawWords) {
      const word = String(w?.word ?? '').trim();
      if (!word) continue;
      const start = Number(w?.start);
      const end = Number(w?.end);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        words.push({ word, start, end });
      }
    }
  }
  return { text, words, segments, language, duration };
}
