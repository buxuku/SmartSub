/**
 * 通读摘要的无 electron 纯函数（可被 tsc+node 单测）。
 * 调模型、读 store 的编排在 episodeSummary.ts。
 */
import { createHash } from 'crypto';
import { renderTemplate } from './template';
import { isTaskCancelledError } from './taskContext';
import { stripAIThinkingContent } from '../translate/utils/aiResponseParser';
import { DEFAULT_BATCH_SIZE } from '../translate/constants';
import { BATCH_SCHEMA_MAX_PROPERTIES } from '../translate/constants/schema';

function effectiveAiBatchSize(providerBatchSize: unknown): number {
  const parsed =
    typeof providerBatchSize === 'number'
      ? providerBatchSize
      : Number.parseInt(String(providerBatchSize ?? ''), 10);
  const requested =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : DEFAULT_BATCH_SIZE.AI;
  return Math.min(Math.max(1, requested), BATCH_SCHEMA_MAX_PROPERTIES);
}
import {
  SUMMARY_GLOSSARY_HEADING,
  SUMMARY_MAX_UNITS,
  SUMMARY_MIN_BATCHES,
  SUMMARY_MIN_CUES,
  isCjkSummaryTarget,
  isSummaryWhitespace,
  measureSummary,
  nextSummaryCodePoint,
  summaryWordSegmenter,
} from '../../types/summaryPrompt';
import type { ResolvedGlossaryEntry } from '../../types/glossary';
import type { SummaryErrorCode } from '../../types/summaryPrompt';

export function buildSummaryInput(
  cues: Array<{ id: string; text: string }>,
): string {
  return cues
    .map((cue) => `${cue.id}\t${String(cue.text || '').replace(/\r?\n/g, ' / ')}`)
    .join('\n');
}

export function buildSummaryGlossaryBlock(
  matches: ResolvedGlossaryEntry[],
): string {
  if (!matches.length) return '';
  const lines = matches.map((entry) => {
    const note = entry.note ? `（${entry.note}）` : '';
    return `${entry.source} = ${entry.target}${note}`;
  });
  return `${SUMMARY_GLOSSARY_HEADING}\n${lines.join('\n')}`;
}

export function buildSummaryInstructions(opts: {
  prompt: string;
  sourceLanguage: string;
  targetLanguage: string;
  glossaryBlock?: string;
}): string {
  const rendered = renderTemplate(opts.prompt, {
    sourceLanguage: opts.sourceLanguage,
    targetLanguage: opts.targetLanguage,
  });
  const block = (opts.glossaryBlock || '').trim();
  if (!block) return rendered;
  return `${rendered.trimEnd()}\n\n${block}`;
}

export function estimateSummaryBatches(
  cueCount: number,
  providerBatchSize: unknown,
): number {
  if (cueCount <= 0) return 0;
  const effective = effectiveAiBatchSize(providerBatchSize);
  return Math.ceil(cueCount / effective);
}

export function shouldSkipTrivialSummary(
  cueCount: number,
  providerBatchSize: unknown,
): boolean {
  if (cueCount < SUMMARY_MIN_CUES) return true;
  return estimateSummaryBatches(cueCount, providerBatchSize) < SUMMARY_MIN_BATCHES;
}

export function normalizeSummaryResponse(raw: string | string[]): string {
  return (Array.isArray(raw) ? raw.join('\n') : raw || '').trim();
}

export function settleSummaryText(
  raw: string | string[],
): { ok: true; text: string } | { ok: false; error: string } {
  const joined = Array.isArray(raw) ? raw.join('\n') : raw || '';
  const stripped = stripAIThinkingContent(joined);
  if (stripped) return { ok: true, text: stripped };
  const hadThink = /<think>/i.test(joined);
  return { ok: false, error: hadThink ? 'empty-after-think-strip' : 'empty' };
}

export function computeSummaryFingerprint(input: {
  source: string;
  prompt: string;
  providerId: string;
  sourceLanguage: string;
  targetLanguage: string;
}): string {
  const payload = JSON.stringify([
    input.source,
    input.prompt,
    input.providerId,
    input.sourceLanguage,
    input.targetLanguage,
  ]);
  return createHash('sha1').update(payload, 'utf8').digest('hex');
}

export function clearedSummaryFields(): {
  episodeSummary: undefined;
  summaryUsage: undefined;
  summarySourceHash: undefined;
} {
  return {
    episodeSummary: undefined,
    summaryUsage: undefined,
    summarySourceHash: undefined,
  };
}

export function disabledSummaryPatch(): {
  episodeSummary: undefined;
  summaryUsage: undefined;
  summarySourceHash: undefined;
  summarizeEpisode: undefined;
  summarizeEpisodeError: undefined;
} {
  return {
    ...clearedSummaryFields(),
    summarizeEpisode: undefined,
    summarizeEpisodeError: undefined,
  };
}

export function decideSummaryReuse(input: {
  existing: string;
  storedHash: string | undefined;
  fingerprint: string;
}): 'reuse' | 'regenerate' {
  if (input.existing.trim() === '') return 'regenerate';
  if (typeof input.storedHash !== 'string' || input.storedHash === '') {
    return 'regenerate';
  }
  return input.storedHash === input.fingerprint ? 'reuse' : 'regenerate';
}

export function isSummaryStageActive(input: {
  generateSummary?: boolean;
  taskType?: string;
  translateProvider?: string;
}): boolean {
  return (
    input.generateSummary === true &&
    (input.taskType === 'generateAndTranslate' ||
      input.taskType === 'translateOnly') &&
    input.translateProvider !== '-1'
  );
}

/**
 * 续跑快路径的摘要阶段态。译文已经复用，这里不补打摘要。
 * 阶段未开启返回 null（调用方不发事件）；指纹可复用则标 done，
 * 并把 summarizeEpisodeError 写成 undefined，清掉渲染层上的旧提示；
 * 否则标 done + skipped-resume，并清掉旧摘要。
 */
export function resolveResumeSummaryState(input: {
  stageActive: boolean;
  existing: string | undefined;
  storedHash: string | undefined;
  fingerprint: string | null;
}):
  | null
  | { summarizeEpisode: 'done'; summarizeEpisodeError: undefined }
  | {
      summarizeEpisode: 'done';
      summarizeEpisodeError: SummaryErrorCode;
      episodeSummary: undefined;
      summaryUsage: undefined;
      summarySourceHash: undefined;
    } {
  if (!input.stageActive) return null;
  if (
    input.fingerprint !== null &&
    decideSummaryReuse({
      existing: input.existing ?? '',
      storedHash: input.storedHash,
      fingerprint: input.fingerprint,
    }) === 'reuse'
  ) {
    return { summarizeEpisode: 'done', summarizeEpisodeError: undefined };
  }
  return {
    summarizeEpisode: 'done',
    summarizeEpisodeError: 'skipped-resume',
    ...clearedSummaryFields(),
  };
}

/** 句末标点。截断优先落在这些字符之后。 */
const SUMMARY_SENTENCE_TERMINATORS = new Set(['。', '！', '？', '.', '!', '?']);
/** 紧跟句末的收尾引号 / 括号。不配对，只认连续的收尾符。 */
const SUMMARY_SENTENCE_CLOSERS = new Set([
  '"',
  "'",
  '”',
  '’',
  '）',
  ')',
  ']',
  '」',
  '』',
  '】',
  '》',
]);

/** 按码点硬切。空白不计入，代理对不拆开。 */
function hardCutCodePoints(text: string, maxUnits: number): string {
  let counted = 0;
  let end = 0;
  for (let i = 0; i < text.length; ) {
    const step = nextSummaryCodePoint(text, i);
    if (!isSummaryWhitespace(step.ch)) {
      if (counted === maxUnits) break;
      counted += 1;
    }
    end = step.end;
    i = step.end;
    if (counted === maxUnits && !isSummaryWhitespace(step.ch)) break;
  }
  return text.slice(0, end).trim();
}

function hardCutWordsFallback(text: string, maxUnits: number): string {
  const matcher = /\S+/g;
  let words = 0;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (words === maxUnits) break;
    words += 1;
    end = match.index + match[0].length;
  }
  return text.slice(0, end).trim();
}

/** 按词硬切。切在第 maxUnits 个词的末尾，不把词从中间切开。 */
function hardCutWords(text: string, targetLang: string, maxUnits: number): string {
  const segmenter = summaryWordSegmenter(targetLang.trim());
  if (!segmenter) return hardCutWordsFallback(text, maxUnits);
  const parts = Array.from(segmenter.segment(text));
  let words = 0;
  let end = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.isWordLike) continue;
    if (words === maxUnits) break;
    words += 1;
    end = part.index + part.segment.length;
  }
  return text.slice(0, end).trim();
}

function hardCutSummary(
  text: string,
  targetLang: string,
  maxUnits: number,
): string {
  if (maxUnits <= 0) return '';
  if (isCjkSummaryTarget(targetLang)) return hardCutCodePoints(text, maxUnits);
  return hardCutWords(text, targetLang, maxUnits);
}

/**
 * 不超过上限的最长句末前缀。句末含 。！？.!? ，后面紧跟的收尾引号/括号可以带走。
 * 前缀不足上限的一半时返回 null，交给硬切。
 */
function sentenceBoundedPrefix(
  text: string,
  targetLang: string,
  maxUnits: number,
): string | null {
  const half = maxUnits / 2;
  let bestEnd = -1;
  for (let i = 0; i < text.length; ) {
    const step = nextSummaryCodePoint(text, i);
    if (SUMMARY_SENTENCE_TERMINATORS.has(step.ch)) {
      const cuts = [step.end];
      let closerEnd = step.end;
      while (closerEnd < text.length) {
        const closer = nextSummaryCodePoint(text, closerEnd);
        if (!SUMMARY_SENTENCE_CLOSERS.has(closer.ch)) break;
        closerEnd = closer.end;
      }
      if (closerEnd !== step.end) cuts.push(closerEnd);
      for (let c = 0; c < cuts.length; c += 1) {
        const end = cuts[c];
        if (end <= bestEnd) continue;
        const units = measureSummary(text.slice(0, end), targetLang);
        if (units <= maxUnits && units >= half) bestEnd = end;
      }
    }
    i = step.end;
  }
  if (bestEnd < 0) return null;
  return text.slice(0, bestEnd).trim();
}

/**
 * 把摘要收到上限以内。未超限只 trim；超限优先在句末截断（前缀至少要留下一半），
 * 否则按码点（CJK）或词边界硬切。结果再量一次也不会超过上限。
 */
export function truncateSummary(
  text: string,
  targetLang: string,
  maxUnits: number = SUMMARY_MAX_UNITS,
): string {
  const trimmed = String(text ?? '').trim();
  if (maxUnits <= 0) return '';
  if (measureSummary(trimmed, targetLang) <= maxUnits) return trimmed;
  const sentence = sentenceBoundedPrefix(trimmed, targetLang, maxUnits);
  if (sentence !== null) return sentence;
  return hardCutSummary(trimmed, targetLang, maxUnits);
}

export interface SummaryCapResult {
  text: string;
  originalUnits: number;
  retryUnits?: number;
  finalUnits: number;
  retried: boolean;
  truncated: boolean;
  /** 压缩抛错时留下消息，调用方负责打日志。取消错误不进这里。 */
  retryError?: string;
}

/** 复用旧摘要时只截断，不重新请求。changed 为 false 时调用方不要改写正文。 */
export function normalizeReusedSummary(
  existing: string,
  targetLang: string,
  maxUnits: number = SUMMARY_MAX_UNITS,
): {
  text: string;
  changed: boolean;
  originalUnits: number;
  finalUnits: number;
} {
  const text = truncateSummary(existing, targetLang, maxUnits);
  return {
    text,
    changed: text !== existing,
    originalUnits: measureSummary(existing, targetLang),
    finalUnits: measureSummary(text, targetLang),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncatedCapResult(
  text: string,
  targetLang: string,
  maxUnits: number,
  originalUnits: number,
  extra: { retryUnits?: number; retryError?: string } = {},
): SummaryCapResult {
  const cut = truncateSummary(text, targetLang, maxUnits);
  return {
    text: cut,
    originalUnits,
    finalUnits: measureSummary(cut, targetLang),
    retried: true,
    truncated: true,
    ...(extra.retryUnits !== undefined ? { retryUnits: extra.retryUnits } : {}),
    ...(extra.retryError !== undefined ? { retryError: extra.retryError } : {}),
  };
}

async function compressionRetry(
  input: {
    text: string;
    targetLang: string;
    compress: (text: string, maxUnits: number) => Promise<string | string[]>;
  },
  maxUnits: number,
  originalUnits: number,
): Promise<SummaryCapResult> {
  const raw = await input.compress(input.text, maxUnits);
  const settled = settleSummaryText(raw);
  if (!settled.ok) {
    return truncatedCapResult(input.text, input.targetLang, maxUnits, originalUnits);
  }
  const retryUnits = measureSummary(settled.text, input.targetLang);
  if (retryUnits <= maxUnits) {
    return {
      text: settled.text,
      originalUnits,
      retryUnits,
      finalUnits: retryUnits,
      retried: true,
      truncated: false,
    };
  }
  return truncatedCapResult(input.text, input.targetLang, maxUnits, originalUnits, {
    retryUnits,
  });
}

/**
 * 超限先压缩一次。压缩结果仍超限、落空或抛错时，截断第一轮原文。
 * 抛错把消息放进 retryError。取消错误原样抛出。
 */
export async function enforceSummaryCap(input: {
  text: string;
  targetLang: string;
  maxUnits?: number;
  compress: (text: string, maxUnits: number) => Promise<string | string[]>;
}): Promise<SummaryCapResult> {
  const maxUnits = input.maxUnits ?? SUMMARY_MAX_UNITS;
  const originalUnits = measureSummary(input.text, input.targetLang);
  if (originalUnits <= maxUnits) {
    return {
      text: input.text,
      originalUnits,
      finalUnits: originalUnits,
      retried: false,
      truncated: false,
    };
  }
  try {
    return await compressionRetry(input, maxUnits, originalUnits);
  } catch (error) {
    if (isTaskCancelledError(error)) throw error;
    return truncatedCapResult(input.text, input.targetLang, maxUnits, originalUnits, {
      retryError: errorText(error),
    });
  }
}

export function shouldUseEpisodeSummary(
  formData: { generateSummary?: boolean } | null | undefined,
  file: { episodeSummary?: string } | null | undefined,
): boolean {
  return (
    formData?.generateSummary === true &&
    String(file?.episodeSummary || '').trim() !== ''
  );
}
