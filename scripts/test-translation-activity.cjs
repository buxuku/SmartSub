/** Real AI/API translation loops with controlled requests and save barriers. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/storeManager'))
    return { logMessage() {}, store: { get: () => ({}) } };
  if (request.endsWith('/glossaryManager'))
    return {
      // This fixture never supplied a glossary. No ids keeps that empty resolution.
      getActiveGlossaryResolution: () => ({ entries: [], conflicts: [] }),
      getTaskGlossaryResolution: () => ({ entries: [], conflicts: [] }),
      logGlossaryConflicts() {},
      logGlossaryMatches() {},
    };
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
const {
  handleAIBatchTranslation,
} = require('../main/translate/services/ai.ts');
const {
  handleAPIBatchTranslation,
} = require('../main/translate/services/api.ts');
const { runWithTaskContext } = require('../main/helpers/taskContext.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const subtitles = ['Hello there.', 'Good morning.'].map((text, i) => ({
  id: String(i + 1),
  startEndTime: '00:00:00,000 --> 00:00:01,000',
  content: [text],
}));
const output = {
  1: { src: 'Hello there.', tr: '你好。' },
  2: { src: 'Good morning.', tr: '早上好。' },
};
const config = {
  provider: {
    id: 'test',
    type: 'openai',
    name: 'test',
    isAi: true,
    batchConcurrency: 2,
  },
  sourceLanguage: 'en',
  targetLanguage: 'zh',
};
async function main() {
  for (const runner of [handleAIBatchTranslation, handleAPIBatchTranslation]) {
    const requests = [],
      events = [],
      writes = [],
      barrier = deferred();
    const running = runner(
      subtitles,
      {
        ...config,
        translator: () => {
          const request = deferred();
          requests.push(request);
          return request.promise;
        },
        onActivity: (event) => events.push(structuredClone(event)),
      },
      1,
      undefined,
      async (results) => {
        await barrier.promise;
        writes.push(results[0].id);
      },
    );
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(events[0].total, 2);
    assert.equal(events[0].completed, 0);
    assert.equal(
      events.at(-1).units.filter((u) => u.requestStartedAt).length,
      2,
    );
    requests[1].resolve(
      runner === handleAIBatchTranslation
        ? JSON.stringify({ 2: output['2'] })
        : ['早上好。'],
    );
    await tick();
    assert.equal(events.at(-1).completed, 1);
    assert.equal(events.at(-1).savedBatches, 0);
    assert.deepEqual(
      events.at(-1).units.map((u) => u.id),
      [1],
    );
    requests[0].resolve(
      runner === handleAIBatchTranslation
        ? JSON.stringify({ 1: output['1'] })
        : ['你好。'],
    );
    await tick();
    assert.equal(events.at(-1).phase, 'saving');
    assert.equal(events.at(-1).completed, 2);
    assert.equal(events.at(-1).savedBatches, 0);
    barrier.resolve();
    await running;
    assert.deepEqual(writes, ['1', '2']);
    assert.equal(events.at(-1).savedBatches, 2);

    const retryEvents = [];
    let calls = 0;
    await runner(
      subtitles.slice(0, 1),
      {
        ...config,
        translator: async () => {
          if (++calls === 1) throw new Error('temporary transport failure');
          return runner === handleAIBatchTranslation
            ? JSON.stringify({ 1: output['1'] })
            : ['你好。'];
        },
        onActivity: (event) => retryEvents.push(structuredClone(event)),
      },
      1,
      undefined,
      undefined,
      1,
    );
    const retry = retryEvents.find((e) => e.units[0]?.waitUntil);
    assert.equal(calls, 2);
    assert.equal(retry.units[0].retry, 1);
    assert.equal(retry.units[0].maxRetries, 1);
    assert.ok(retry.units[0].waitUntil > retry.units[0].startedAt);

    const late = deferred(),
      cancelEvents = [],
      controller = new AbortController();
    const cancelled = runWithTaskContext({ signal: controller.signal }, () =>
      runner(
        subtitles.slice(0, 1),
        {
          ...config,
          signal: controller.signal,
          translator: () => late.promise,
          onActivity: (e) => cancelEvents.push(structuredClone(e)),
        },
        1,
      ),
    );
    const rejection = assert.rejects(cancelled, /TASK_CANCELLED/);
    await tick();
    controller.abort();
    const count = cancelEvents.length;
    late.resolve(
      runner === handleAIBatchTranslation
        ? JSON.stringify({ 1: output['1'] })
        : ['你好。'],
    );
    await rejection;
    assert.equal(cancelEvents.length, count);
  }
  const intervalEvents = [];
  await handleAPIBatchTranslation(
    subtitles,
    {
      ...config,
      provider: { ...config.provider, requestInterval: 0.02 },
      translator: async () => ['你好。'],
      onActivity: (e) => intervalEvents.push(structuredClone(e)),
    },
    1,
  );
  assert.ok(
    intervalEvents.some((e) =>
      e.units.some((u) => u.phase === 'interval' && u.waitUntil),
    ),
  );
  const repairEvents = [];
  let calls = 0;
  await handleAIBatchTranslation(
    subtitles.slice(0, 1),
    {
      ...config,
      translator: async () =>
        ++calls <= 2 ? '{}' : JSON.stringify({ 1: output['1'] }),
      onActivity: (e) => repairEvents.push(structuredClone(e)),
    },
    1,
  );
  assert.equal(calls, 3);
  assert.ok(
    repairEvents.some((e) =>
      e.units.some((u) => u.reason === 'validation' && u.retry === 1),
    ),
  );
  assert.ok(repairEvents.some((e) => e.phase === 'repairing'));
  assert.ok(repairEvents.some((e) => e.phase === 'validating'));

  const failureEvents = [];
  await assert.rejects(
    handleAPIBatchTranslation(
      subtitles,
      {
        ...config,
        translator: async () => ['你好。'],
        onActivity: (e) => failureEvents.push(structuredClone(e)),
      },
      1,
      undefined,
      async () => {
        throw new Error('disk full');
      },
    ),
    /disk full/,
  );
  assert.equal(failureEvents.at(-1).savedBatches, 0);
  const partialEvents = [];
  await handleAPIBatchTranslation(
    subtitles,
    {
      ...config,
      translator: async () => {
        throw new Error('transport failed');
      },
      onActivity: (e) => partialEvents.push(structuredClone(e)),
    },
    1,
    undefined,
    async () => {},
  );
  assert.equal(partialEvents.at(-1).failedCues, 2);
  assert.equal(partialEvents.at(-1).savedBatches, 2);
  console.log(
    'Translation activity passed: AI/API concurrency, ordered saves, retries, repair, interval, cancellation and save failure',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
