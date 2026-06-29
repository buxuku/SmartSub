import type { Subtitle, TranslationResult } from '../types';
import {
  throwIfTaskCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';

export type TranslationBatch = {
  index: number;
  displayIndex: number;
  subtitles: Subtitle[];
};

const DEFAULT_BATCH_CONCURRENCY = 1;
const MAX_BATCH_CONCURRENCY = 10;

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function normalizeBatchSize(value: unknown, fallback: number): number {
  return Math.max(1, toPositiveInteger(value, fallback));
}

export function resolveBatchConcurrency(
  value: unknown,
  totalBatches: number,
): number {
  if (totalBatches <= 0) return DEFAULT_BATCH_CONCURRENCY;
  const requested = toPositiveInteger(value, DEFAULT_BATCH_CONCURRENCY);
  return Math.min(requested, totalBatches, MAX_BATCH_CONCURRENCY);
}

export function createTranslationBatches(
  subtitles: Subtitle[],
  batchSize: number,
): TranslationBatch[] {
  const batches: TranslationBatch[] = [];
  for (let i = 0; i < subtitles.length; i += batchSize) {
    batches.push({
      index: batches.length,
      displayIndex: batches.length + 1,
      subtitles: subtitles.slice(i, i + batchSize),
    });
  }
  return batches;
}

type RunTranslationBatchesOptions = {
  batches: TranslationBatch[];
  concurrency: number;
  requestIntervalMs: number;
  totalSubtitles: number;
  processBatch: (batch: TranslationBatch) => Promise<TranslationResult[]>;
  onProgress?: (progress: number) => void;
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>;
};

export async function runTranslationBatchesInOrder({
  batches,
  concurrency,
  requestIntervalMs,
  totalSubtitles,
  processBatch,
  onProgress,
  onTranslationResult,
}: RunTranslationBatchesOptions): Promise<TranslationResult[]> {
  if (batches.length === 0) return [];

  const results: TranslationResult[] = [];
  const completedBatches: Array<TranslationResult[] | undefined> = [];
  let nextBatchIndex = 0;
  let nextFlushIndex = 0;
  let processedSubtitles = 0;
  let nextRequestStartAt = 0;
  let flushPromise = Promise.resolve();

  const waitForRequestSlot = async (displayIndex: number) => {
    if (requestIntervalMs <= 0) return;

    const now = Date.now();
    const targetStartAt = Math.max(now, nextRequestStartAt);
    const waitMs = Math.max(targetStartAt - now, 0);
    nextRequestStartAt = targetStartAt + requestIntervalMs;

    if (waitMs > 0) {
      logMessage(
        `批次 ${displayIndex} 等待 ${(waitMs / 1000).toFixed(2)}s (请求间隔)`,
        'info',
      );
      await waitForTaskDelay(waitMs);
    }
  };

  const flushCompletedBatches = async () => {
    while (completedBatches[nextFlushIndex] !== undefined) {
      const batchResults = completedBatches[nextFlushIndex]!;
      if (onTranslationResult) {
        await onTranslationResult(batchResults);
      }
      results.push(...batchResults);
      completedBatches[nextFlushIndex] = undefined;
      nextFlushIndex++;
    }
  };

  const enqueueFlush = () => {
    flushPromise = flushPromise.then(flushCompletedBatches);
    return flushPromise;
  };

  const worker = async () => {
    while (true) {
      throwIfTaskCancelled();
      const batchIndex = nextBatchIndex++;
      if (batchIndex >= batches.length) return;

      const batch = batches[batchIndex];
      await waitForRequestSlot(batch.displayIndex);
      throwIfTaskCancelled();

      const batchResults = await processBatch(batch);
      completedBatches[batch.index] = batchResults;
      processedSubtitles += batch.subtitles.length;

      const progress = Math.min(
        (processedSubtitles / totalSubtitles) * 100,
        100,
      );
      onProgress?.(progress);
      logMessage(
        `进度更新: ${progress.toFixed(2)}% (${processedSubtitles}/${totalSubtitles})`,
        'info',
      );

      await enqueueFlush();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await flushPromise;

  return results;
}
