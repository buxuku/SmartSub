/// <reference path="./test-globals.d.ts" />

import axios from 'axios';
import translateWithOllama from '../main/service/ollama';
import {
  isTaskCancelledError,
  runWithTaskContext,
  waitForTaskDelay,
} from '../main/helpers/taskContext';
import { acquire } from '../main/translate/utils/rateLimiter';

let passed = 0;
let failed = 0;

function ok(value: unknown, name: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`x ${name}`);
  }
}

async function expectTaskCancelled(
  fn: () => Promise<unknown>,
  name: string,
): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`x ${name}\n    expected TaskCancelledError`);
  } catch (error) {
    ok(isTaskCancelledError(error), name);
  }
}

async function testAbortableDelay(): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);

  await expectTaskCancelled(
    () =>
      runWithTaskContext({ signal: controller.signal }, () =>
        waitForTaskDelay(5_000),
      ),
    'waitForTaskDelay rejects when task signal aborts',
  );

  ok(
    Date.now() - startedAt < 1_000,
    'waitForTaskDelay does not wait for the full timeout after abort',
  );
}

async function testOllamaAbortSignal(): Promise<void> {
  const originalPost = axios.post;
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;

  (axios as any).post = (_url: string, _body: unknown, config: any) => {
    observedSignal = config?.signal;
    return new Promise((_resolve, reject) => {
      observedSignal?.addEventListener(
        'abort',
        () => reject(new Error('axios request aborted')),
        { once: true },
      );
    });
  };

  try {
    setTimeout(() => controller.abort(), 20);

    await expectTaskCancelled(
      () =>
        translateWithOllama(
          '{"1":"hello"}',
          {
            apiUrl: 'http://localhost:11434/api/chat',
            modelName: 'llama3.1',
            prompt: '',
            systemPrompt: 'Translate JSON',
          },
          'en',
          'zh',
          { signal: controller.signal },
        ),
      'translateWithOllama normalizes aborted axios requests',
    );

    ok(
      observedSignal === controller.signal,
      'translateWithOllama passes AbortSignal to axios',
    );
  } finally {
    axios.post = originalPost;
  }
}

async function testRateLimiterQueuedAbortReleasesLock(): Promise<void> {
  const key = `translation-cancel-test-${Date.now()}`;
  await acquire(key);

  const holdingAcquire = acquire(key, { minIntervalMs: 80 });
  const controller = new AbortController();
  const queuedAcquire = acquire(key, {}, controller.signal);
  setTimeout(() => controller.abort(), 10);

  await holdingAcquire;
  await expectTaskCancelled(
    () => queuedAcquire,
    'rateLimiter acquire rejects a queued aborted request',
  );

  const nextAcquire = await Promise.race([
    acquire(key),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 200),
    ),
  ]);

  ok(
    nextAcquire !== 'timeout',
    'rateLimiter releases lock after queued abort',
  );
}

async function main(): Promise<void> {
  await testAbortableDelay();
  await testOllamaAbortSignal();
  await testRateLimiterQueuedAbortReleasesLock();

  console.log(`\ntranslation cancel tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
