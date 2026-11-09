import type { Subtitle, TranslationResult } from '../types';
import {
  throwIfSignalCancelled,
  throwIfTaskCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import { ProviderFallbackExhaustedError } from '../services/providerFallback';
import type { TranslationActivity } from './translationActivity';

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

type RunWithBatchConcurrencyOptions = {
  /** Units (batches, windows) to run, addressed by index `0..total-1`. */
  total: number;
  /**
   * Parallel workers. Feed the provider's 「批次并发数」 through
   * `resolveBatchConcurrency` first: parsing, the default and the cap of 10
   * live there, this only clamps the result to `[1, total]`.
   */
  concurrency: number;
  /** Minimum gap between two units starting (provider 「请求间隔」); 0 disables it. */
  requestIntervalMs?: number;
  /** Cancels the run: see the abort note on `runWithBatchConcurrency`. */
  signal?: AbortSignal;
  /** Return true to stop handing out units quietly; units already running finish. */
  shouldStop?: () => boolean;
  /** Called synchronously, just before a unit sleeps until `waitUntil` (epoch ms). */
  onWait?: (index: number, waitUntil: number) => void;
  /** Runs one unit. Throwing fails the whole run. */
  run: (index: number) => Promise<void>;
};

/**
 * Runs `total` independent units on a worker pool: a shared cursor hands out
 * indexes, so up to `concurrency` units are in flight and a slow one never holds
 * the others back. The AI refine passes (segmentation windows, correction
 * batches) share it; they write into an index-addressed array, so unlike
 * `runTranslationBatchesInOrder` they need no ordered flush.
 *
 * - Fail fast: the first rejection settles the returned promise at once and no
 *   new unit starts. Units already in flight are not awaited, so `run` has to
 *   discard its late results once the caller has moved on.
 * - Request interval: a unit reserves its start slot before sleeping, so workers
 *   are spaced one interval apart instead of all waking together. The first unit
 *   starts immediately.
 * - Abort: a unit that is about to start (including one waiting for its interval
 *   slot) is dropped and the run rejects with the task-cancelled error. Units
 *   already running are the caller's to cancel, and once every unit has been
 *   handed out there is nothing left to abort, so the run resolves.
 * - `shouldStop` is the quiet counterpart: no more units are started and the run
 *   resolves. It is checked before a unit is dispatched and again once its
 *   interval wait is over.
 */
export async function runWithBatchConcurrency({
  total,
  concurrency,
  requestIntervalMs = 0,
  signal,
  shouldStop,
  onWait,
  run,
}: RunWithBatchConcurrencyOptions): Promise<void> {
  if (total <= 0) return;

  // Also catches NaN from a malformed setting, which would poison the slots.
  const intervalMs = requestIntervalMs > 0 ? requestIntervalMs : 0;
  let cursor = 0;
  let nextStartAt = 0;
  let failed = false;

  const stopped = () => failed || !!shouldStop?.();

  const awaitStartSlot = async (index: number) => {
    if (intervalMs <= 0) return;
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    nextStartAt = startAt + intervalMs;
    if (startAt <= now) return;
    onWait?.(index, startAt);
    await waitForTaskDelay(startAt - now, signal);
  };

  const worker = async () => {
    try {
      for (;;) {
        if (cursor >= total || stopped()) return;
        const index = cursor++;
        await awaitStartSlot(index);
        if (stopped()) return;
        throwIfSignalCancelled(signal);
        await run(index);
      }
    } catch (error) {
      // Set here rather than in a .catch on the promise, so a sibling worker
      // resuming in the same tick can't start one more unit.
      failed = true;
      throw error;
    }
  };

  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency) || 1, total),
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
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
  activity?: TranslationActivity;
  batches: TranslationBatch[];
  concurrency: number;
  requestIntervalMs: number;
  totalSubtitles: number;
  processBatch: (batch: TranslationBatch) => Promise<TranslationResult[]>;
  onProgress?: (progress: number) => void;
  onTranslationResult?: (results: TranslationResult[]) => Promise<void>;
};

export async function runTranslationBatchesInOrder({
  activity,
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
  let failure: { error: unknown } | undefined;

  const waitForRequestSlot = async (displayIndex: number) => {
    if (requestIntervalMs <= 0) return;

    const now = Date.now();
    const targetStartAt = Math.max(now, nextRequestStartAt);
    const waitMs = Math.max(targetStartAt - now, 0);
    nextRequestStartAt = targetStartAt + requestIntervalMs;

    if (waitMs > 0) {
      activity?.update(displayIndex, {
        phase: 'interval',
        waitUntil: targetStartAt,
      });
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
        activity?.update(batches[nextFlushIndex].displayIndex, {
          phase: 'saving',
        });
        await onTranslationResult(batchResults);
        activity?.saved(batches[nextFlushIndex].displayIndex);
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
      if (failure) return;
      const batchIndex = nextBatchIndex++;
      if (batchIndex >= batches.length) return;

      const batch = batches[batchIndex];
      activity?.update(batch.displayIndex, { phase: 'queued' });
      await waitForRequestSlot(batch.displayIndex);
      throwIfTaskCancelled();
      if (failure) return;

      const batchResults = await processBatch(batch);
      throwIfTaskCancelled();
      activity?.received(
        batch.displayIndex,
        batchResults.filter((result) => result.translationStatus === 'failed')
          .length,
      );
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

  // Stop assigning batches on failure, and settle all in-flight writes before
  // returning control to the task/pipeline failure handler.
  await Promise.all(
    Array.from({ length: concurrency }, () =>
      worker().catch((error) => {
        failure ??= { error };
      }),
    ),
  );
  await flushPromise;

  if (failure) {
    if (failure.error instanceof ProviderFallbackExhaustedError) {
      // A failed batch can leave a gap before later successful batches.
      for (let index = nextFlushIndex; index < batches.length; index++) {
        const batchResults = completedBatches[index];
        if (batchResults && onTranslationResult) {
          activity?.update(batches[index].displayIndex, { phase: 'saving' });
          await onTranslationResult(batchResults);
          activity?.saved(batches[index].displayIndex);
        }
      }
    }
    throw failure.error;
  }

  return results;
}
