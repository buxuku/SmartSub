import { toJson } from 'really-relaxed-json';
import { jsonrepair } from 'jsonrepair';
import {
  JSON_CONTENT_REGEX,
  RESULT_TAG_REGEX,
  THINK_TAG_REGEX,
} from '../constants';

export type AITranslationResponse = Record<string, string>;

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
    'text',
    'value',
  ]) {
    const nestedValue = nested[key];
    if (typeof nestedValue === 'string') return nestedValue;
  }

  return undefined;
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

export function parseAITranslationResponse(
  response: string,
): AITranslationResponse {
  const candidates = collectAIJsonCandidates(response);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsedContent = parseJsonWithFallbacks(candidate);
      const normalized = normalizeTranslationObject(parsedContent);
      if (normalized) return normalized;
      errors.push('解析结果不是字幕翻译 JSON 对象');
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }

  const lastError = errors[errors.length - 1] || '未找到 JSON 内容';
  throw new Error(`无法解析AI返回的JSON内容: ${lastError}`);
}
