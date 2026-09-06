import {
  getTaskSignal,
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { acquire, resolveRateLimitConfig } from './rateLimiter';
import type { Provider } from '../types';

const activeRequests = new Map<string, Set<Promise<void>>>();

function waitForCompletion(
  requests: Set<Promise<void>>,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new TaskCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    Promise.race(requests).then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** Hold a per-instance concurrency slot until the caller releases it. */
export async function acquireProviderRequestSlot(
  provider: Provider,
  signal: AbortSignal | undefined = getTaskSignal(),
): Promise<() => void> {
  const requested = Number.parseInt(String(provider.batchConcurrency), 10);
  const concurrency = Number.isFinite(requested)
    ? Math.min(10, Math.max(1, requested))
    : 1;
  let requests: Set<Promise<void>>;
  while (true) {
    throwIfSignalCancelled(signal);
    requests = activeRequests.get(provider.id) ?? new Set();
    if (requests.size < concurrency) break;
    await waitForCompletion(requests, signal);
  }

  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  requests.add(pending);
  activeRequests.set(provider.id, requests);
  const release = () => {
    requests.delete(pending);
    if (requests.size === 0) activeRequests.delete(provider.id);
    complete();
  };
  try {
    await acquire(
      `provider-fallback:${provider.id}`,
      resolveRateLimitConfig(provider),
      signal,
    );
    throwIfSignalCancelled(signal);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
