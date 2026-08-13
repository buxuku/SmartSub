/**
 * 通读摘要的无 electron 纯函数（可被 tsc+node 单测）。
 * 调模型、读 store 的编排在 episodeSummary.ts。
 */
import { renderTemplate } from './template';
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
  SUMMARY_MIN_BATCHES,
  SUMMARY_MIN_CUES,
} from '../../types/summaryPrompt';
import type { ResolvedGlossaryEntry } from '../../types/glossary';

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
