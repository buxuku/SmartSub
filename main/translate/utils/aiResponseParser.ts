import { toJson } from 'really-relaxed-json';
import { jsonrepair } from 'jsonrepair';
import {
  JSON_CONTENT_REGEX,
  RESULT_TAG_REGEX,
  THINK_TAG_REGEX,
} from '../constants';

export type AITranslationResponse = Record<string, string>;

/**
 * 锚定解析结果：单条译文 + 可选的原文回显。
 * 回显锚定协议下模型返回 {id: {src, tr}}；旧协议 {id: 译文} 时 hasEcho=false，
 * 调用方据此降级为「条数+空值」校验（兼容用户自定义提示词，见 design D5）。
 */
export interface AnchoredTranslationEntry {
  translation: string;
  srcEcho?: string;
  hasEcho: boolean;
}

export type AnchoredTranslationResponse = Record<
  string,
  AnchoredTranslationEntry
>;

const JSON_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)```/gi;
const UNCLOSED_THINK_REGEX = /<think>[\s\S]*?(?=(?:```|<result|\{)|$)/gi;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pushCandidate(candidates: string[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || candidates.includes(trimmed)) return;
  candidates.push(trimmed);
}

export function stripAIThinkingContent(response: string): string {
  return response
    .replace(THINK_TAG_REGEX, '')
    .replace(UNCLOSED_THINK_REGEX, '')
    .trim();
}

function extractFirstJsonObject(text: string): string | undefined {
  if (text.trimStart().startsWith('[')) return undefined;

  const start = text.indexOf('{');
  if (start < 0) return undefined;
  if (text.slice(0, start).trimEnd().endsWith('[')) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

export function collectAIJsonCandidates(response: string): string[] {
  const cleanResponse = stripAIThinkingContent(response);
  const candidates: string[] = [];

  const resultMatch = cleanResponse.match(RESULT_TAG_REGEX);
  pushCandidate(candidates, resultMatch?.[1]);

  JSON_BLOCK_REGEX.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = JSON_BLOCK_REGEX.exec(cleanResponse)) !== null) {
    pushCandidate(candidates, blockMatch[1]);
  }

  const jsonBlockMatch = cleanResponse.match(JSON_CONTENT_REGEX);
  pushCandidate(candidates, jsonBlockMatch?.[1]);

  pushCandidate(candidates, extractFirstJsonObject(cleanResponse));
  pushCandidate(candidates, cleanResponse);

  return candidates;
}

function parseJsonWithFallbacks(jsonContent: string): unknown {
  try {
    return JSON.parse(jsonContent);
  } catch {}

  try {
    const relaxedJson = toJson(jsonContent);
    return typeof relaxedJson === 'string'
      ? JSON.parse(relaxedJson)
      : relaxedJson;
  } catch {}

  const repairedJson = jsonrepair(jsonContent);
  return JSON.parse(repairedJson);
}

function coerceTranslationValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value !== 'object' || Array.isArray(value)) return undefined;

  const nested = value as Record<string, unknown>;
  for (const key of [
    'targetContent',
    'translation',
    'translated',
    'target',
    'tr',
    'text',
    'value',
  ]) {
    const nestedValue = nested[key];
    if (typeof nestedValue === 'string') return nestedValue;
  }

  return undefined;
}

function toAnchoredEntry(value: unknown): AnchoredTranslationEntry | undefined {
  if (typeof value === 'string') {
    return { translation: value, hasEcho: false };
  }
  if (value == null) {
    return { translation: '', hasEcho: false };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { translation: String(value), hasEcho: false };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;

  const nested = value as Record<string, unknown>;
  if (typeof nested.tr === 'string') {
    const srcEcho = typeof nested.src === 'string' ? nested.src : undefined;
    return {
      translation: nested.tr,
      srcEcho,
      hasEcho: srcEcho !== undefined,
    };
  }

  const coerced = coerceTranslationValue(value);
  if (coerced === undefined) return undefined;
  return { translation: coerced, hasEcho: false };
}

function normalizeAnchoredObject(
  parsedContent: unknown,
): AnchoredTranslationResponse | undefined {
  if (
    !parsedContent ||
    typeof parsedContent !== 'object' ||
    Array.isArray(parsedContent)
  ) {
    return undefined;
  }

  const normalized: AnchoredTranslationResponse = {};
  for (const [key, value] of Object.entries(
    parsedContent as Record<string, unknown>,
  )) {
    const entry = toAnchoredEntry(value);
    if (entry === undefined) return undefined;
    normalized[key] = entry;
  }

  return normalized;
}

function normalizeTranslationObject(
  parsedContent: unknown,
): AITranslationResponse | undefined {
  if (
    !parsedContent ||
    typeof parsedContent !== 'object' ||
    Array.isArray(parsedContent)
  ) {
    return undefined;
  }

  const normalized: AITranslationResponse = {};
  for (const [key, value] of Object.entries(
    parsedContent as Record<string, unknown>,
  )) {
    const translationValue = coerceTranslationValue(value);
    if (translationValue === undefined) return undefined;
    normalized[key] = translationValue;
  }

  return normalized;
}

function parseWithNormalizer<T>(
  response: string,
  normalize: (parsedContent: unknown) => T | undefined,
): T {
  const candidates = collectAIJsonCandidates(response);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsedContent = parseJsonWithFallbacks(candidate);
      const normalized = normalize(parsedContent);
      if (normalized) return normalized;
      errors.push('解析结果不是字幕翻译 JSON 对象');
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }

  const lastError = errors[errors.length - 1] || '未找到 JSON 内容';
  throw new Error(`无法解析AI返回的JSON内容: ${lastError}`);
}

export function parseAITranslationResponse(
  response: string,
): AITranslationResponse {
  return parseWithNormalizer(response, normalizeTranslationObject);
}

/**
 * 锚定解析：值为 {src, tr} 时保留回显供对齐校验，
 * 纯字符串/旧嵌套形态降级为无回显条目；两种形态可混合出现。
 */
export function parseAIAnchoredTranslationResponse(
  response: string,
): AnchoredTranslationResponse {
  return parseWithNormalizer(response, normalizeAnchoredObject);
}
