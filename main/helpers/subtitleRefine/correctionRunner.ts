/**
 * 校正遍编排（遍 B，design D7）：cues 文本 → 共享校正服务（anchored 协议）→ 写回。
 * **非纯逻辑层**（依赖翻译客户端/任务上下文），不经 index.ts 导出。
 *
 * 不变性（spec: ai-subtitle-correction）：只替换 cue 的文本槽位，输出条数与
 * 每条起止时间与输入完全一致（由构造保证）；失败/错位/空结果条目保留原文。
 */

import type { TokenTriple } from '../subtitleSegmentation';
import { logMessage } from '../storeManager';
import { TaskCancelledError } from '../taskContext';
import { runSubtitleCorrection } from '../subtitleCorrectionService';
import { TRANSLATOR_MAP } from '../../translate/services/translationProvider';
import type { Provider, TranslatorFunction } from '../../translate/types';

export interface AiCorrectionParams {
  cues: TokenTriple[];
  formData: Record<string, unknown>;
  provider: Provider;
  signal?: AbortSignal;
  /** 低置信词标注（Tier 'word' 下由 sidecar 词概率派生）。 */
  suspectWords?: string[];
  onProgress?: (processed: number, total: number) => void;
}

export interface AiCorrectionOutcome {
  cues: TokenTriple[];
  /** 实际发生文本变更的条数。 */
  changed: number;
  /** 整体降级（服务商不可用等）：cues 与输入一致。 */
  degraded: boolean;
}

/** 模型偶发在校正文本里带换行：字幕单条内折叠为空格，避免交付层格式扰动。 */
function sanitizeCorrectedText(text: string): string {
  return text.replace(/\s*\r?\n+\s*/g, ' ').trim();
}

export async function runAiCorrection(
  params: AiCorrectionParams,
): Promise<AiCorrectionOutcome> {
  const { cues, formData, provider, signal, suspectWords, onProgress } = params;
  if (cues.length === 0) return { cues, changed: 0, degraded: false };

  const translator = TRANSLATOR_MAP[
    provider?.type as keyof typeof TRANSLATOR_MAP
  ] as unknown as TranslatorFunction | undefined;
  if (!provider?.isAi || !translator) {
    logMessage(
      `AI correction degraded: provider ${provider?.name ?? '(none)'} is not an AI provider`,
      'warning',
    );
    return { cues, changed: 0, degraded: true };
  }

  // 转写校正：语言即原语言（不涉及目标语言语义，透传同值满足 translator 签名）。
  const sourceLanguage = String(formData?.sourceLanguage ?? 'auto');
  const items = cues.map((cue, i) => ({
    id: String(i + 1),
    index: i,
    source: cue?.[2] ?? '',
  }));

  const { results, cancelled } = await runSubtitleCorrection({
    items,
    provider,
    translator,
    mode: 'transcript',
    protocol: 'anchored',
    sourceLanguage,
    targetLanguage: sourceLanguage,
    batchSize: Math.max(1, Math.floor(Number(provider.batchSize) || 10)),
    maxRetries: 2,
    signal,
    useGlossary: true,
    glossaryLabel: 'AI 字幕校正',
    suspectWords,
    onBatchProgress: (info) =>
      onProgress?.(info.processedCount, info.totalCount),
  });
  if (cancelled) throw new TaskCancelledError();

  const byIndex = new Map(results.map((r) => [r.index ?? -1, r]));
  let changed = 0;
  let errorCount = 0;
  const out: TokenTriple[] = cues.map((cue, i): TokenTriple => {
    const r = byIndex.get(i);
    if (r?.status === 'error') errorCount += 1;
    const corrected =
      r?.status === 'success' ? sanitizeCorrectedText(r.corrected) : '';
    const text = corrected || (cue?.[2] ?? '');
    if (text !== cue?.[2]) changed += 1;
    // 只换文本槽位：条数与起止时间与输入严格一致（spec 不变性）。
    return [cue?.[0] ?? '', cue?.[1] ?? '', text];
  });

  const degraded = errorCount >= items.length;
  logMessage(
    `AI correction done: ${changed}/${cues.length} entries changed, errors ${errorCount}${degraded ? ' (degraded)' : ''}`,
    degraded ? 'warning' : 'info',
  );
  return { cues: out, changed, degraded };
}
