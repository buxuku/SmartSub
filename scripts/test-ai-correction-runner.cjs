/**
 * Offline regression checks for AI correction batch concurrency.
 *
 * The correction pass of AI 精修 (runAiCorrection) and the proofread page's AI
 * batch optimize both go through runSubtitleCorrection. That loop used to send
 * batches one after another and never read the provider's 「批次并发数」
 * (batchConcurrency) or 「请求间隔」 (requestInterval), while translation and AI
 * segmentation honour both, so users saw a fixed concurrency of 1.
 *
 * The real runAiCorrection / runSubtitleCorrection / runWithBatchConcurrency run
 * against a scripted model that meters how many requests are in flight at the
 * same moment, so every case states an observable property instead of peeking
 * at internals:
 *
 *  - concurrency: the peak number of simultaneous requests equals the
 *    configured value (numeric strings such as '4' included, capped at 10,
 *    default 1);
 *  - request interval: request start times are spaced out while requests still
 *    overlap;
 *  - invariants that must survive the change: cue order and times, per-item
 *    results in item order, failure isolation, the cancel contract and a
 *    strictly serial default (the proofread page relies on it).
 *
 * Electron and the translator registry are replaced with in-memory stubs, so
 * nothing here touches the network.
 *
 * Run: node scripts/test-ai-correction-runner.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const mainDir = path.join(repoRoot, 'main');

// The services print their config and every completion; keep the report readable.
const report = (line) => process.stdout.write(`${line}\n`);
const reportError = (line) => process.stderr.write(`${line}\n`);
console.log = () => {};
console.warn = () => {};
console.error = () => {};

/** Everything the app logged through storeManager.logMessage. */
const logs = [];
/** Replaces translationProvider's registry (and every service it would pull in). */
const TRANSLATOR_MAP = {};

const electronStub = {
  app: {
    getAppPath: () => repoRoot,
    getPath: () => path.join(repoRoot, 'node_modules', '.cache'),
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: { getAllWindows: () => [] },
};

// Stubs are keyed by resolved file path: the sources import these modules with
// different relative specifiers, so matching on the request string is brittle.
const stubsByFile = new Map([
  [
    path.join(mainDir, 'helpers', 'storeManager.ts'),
    {
      logMessage(message, level = 'info') {
        logs.push({ level, message: String(message) });
      },
      store: { get: () => ({}) },
    },
  ],
  [
    path.join(mainDir, 'helpers', 'glossaryManager.ts'),
    {
      getTaskGlossaryResolution: () => null,
      logGlossaryConflicts() {},
      logGlossaryMatches() {},
    },
  ],
  [
    path.join(mainDir, 'translate', 'services', 'translationProvider.ts'),
    { TRANSLATOR_MAP },
  ],
]);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (parent && /^\.{1,2}\//.test(request)) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      /* not resolvable here: let the real loader report it */
    }
    if (resolved && stubsByFile.has(resolved)) return stubsByFile.get(resolved);
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => repoRoot,
        getNewLine: () => '\n',
      }),
    );
  }
  module._compile(output.outputText, filename);
};

const {
  runAiCorrection,
} = require('../main/helpers/subtitleRefine/correctionRunner.ts');
const {
  runSubtitleCorrection,
} = require('../main/helpers/subtitleCorrectionService.ts');
const {
  runWithBatchConcurrency,
} = require('../main/translate/utils/batchConcurrency.ts');
const { isTaskCancelledError } = require('../main/helpers/taskContext.ts');

// ---------------------------------------------------------------- fixtures --

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
const stamp = (seconds, ms = 0) =>
  `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)},${pad(ms, 3)}`;
const textOf = (i) => `Subtitle number ${i + 1} about the cache layer`;
const range = (count) => Array.from({ length: count }, (_, i) => i);

/** Pipeline input: [start, end, text] cue triples. */
const makeCues = (count) =>
  range(count).map((i) => [stamp(i), stamp(i, 900), textOf(i)]);

/** Direct service input (proofread page shape). */
const makeItems = (count) =>
  range(count).map((i) => ({
    id: String(i + 1),
    index: i,
    source: textOf(i),
    target: `字幕 ${i + 1}`,
  }));

/**
 * batchConcurrency is deliberately NOT defaulted: "unset" is a case of its own.
 * The provider record is what the settings form stores, strings included.
 */
function makeProvider(overrides = {}) {
  return {
    id: 'fake-llm',
    name: 'Fake LLM',
    type: 'fakellm',
    isAi: true,
    batchSize: 5,
    requestInterval: 0,
    ...overrides,
  };
}

/** Pulls the batch the service put into the prompt, for either protocol. */
function extractBatch(prompt) {
  const marker = 'Subtitles to optimize:\n';
  if (prompt.includes(marker)) {
    return {
      protocol: 'legacyMap',
      batch: JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)),
    };
  }
  const start = prompt.indexOf('{\n');
  let depth = 0;
  for (let i = start; i < prompt.length; i += 1) {
    if (prompt[i] === '{') depth += 1;
    else if (prompt[i] === '}' && (depth -= 1) === 0)
      return {
        protocol: 'anchored',
        batch: JSON.parse(prompt.slice(start, i + 1)),
      };
  }
  throw new Error('no batch JSON found in the prompt');
}

/** A well-behaved model: anchored echoes the source, legacyMap returns text. */
function answerFor(protocol, batch) {
  const entries = Object.entries(batch);
  return JSON.stringify(
    Object.fromEntries(
      entries.map(([id, value]) =>
        protocol === 'anchored'
          ? [id, { src: value, tr: `${value}.` }]
          : [id, `${value.source} (opt)`],
      ),
    ),
  );
}

/**
 * Scripts the model and meters it. `latency` is milliseconds or (call) => ms;
 * `fail(call)` makes a request throw. Each call records when it started and
 * ended and which subtitle ids it carried.
 */
function installLlm({ latency = 30, fail } = {}) {
  const meter = { inFlight: 0, peak: 0, calls: [] };
  TRANSLATOR_MAP.fakellm = async (prompt) => {
    const { protocol, batch } = extractBatch(prompt);
    const call = {
      n: meter.calls.length,
      ids: Object.keys(batch),
      startedAt: Date.now(),
      endedAt: 0,
    };
    meter.calls.push(call);
    meter.inFlight += 1;
    meter.peak = Math.max(meter.peak, meter.inFlight);
    try {
      await sleep(typeof latency === 'function' ? latency(call) : latency);
      if (fail && fail(call)) throw new Error('scripted request failure');
      return answerFor(protocol, batch);
    } finally {
      meter.inFlight -= 1;
      call.endedAt = Date.now();
    }
  };
  return meter;
}

/** The pipeline entry (AI 精修 correction pass). */
const correct = (cues, { provider, ...rest } = {}) =>
  runAiCorrection({
    cues,
    formData: { sourceLanguage: 'en' },
    provider: provider || makeProvider(),
    ...rest,
  });

/** The shared service, as the proofread page (legacyMap) calls it. */
const correctDirect = (
  items,
  { provider, protocol = 'anchored', ...rest } = {},
) =>
  runSubtitleCorrection({
    items,
    provider: provider || makeProvider(),
    translator: TRANSLATOR_MAP.fakellm,
    mode: protocol === 'anchored' ? 'transcript' : 'translation',
    protocol,
    sourceLanguage: 'en',
    targetLanguage: protocol === 'anchored' ? 'en' : 'zh',
    batchSize: 5,
    maxRetries: 0,
    ...rest,
  });

const startGaps = (calls) => {
  const starts = calls.map((call) => call.startedAt).sort((a, b) => a - b);
  return starts.slice(1).map((time, i) => time - starts[i]);
};
const logged = (pattern) => logs.some((entry) => pattern.test(entry.message));

// ------------------------------------------------------------------ runner --

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------- scheduler --

test('scheduler: runs every unit once and never exceeds the worker count', async () => {
  const ran = [];
  let inFlight = 0;
  let peak = 0;
  await runWithBatchConcurrency({
    total: 10,
    concurrency: 3,
    run: async (index) => {
      ran.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight -= 1;
    },
  });
  assert.deepEqual(
    [...ran].sort((a, b) => a - b),
    range(10),
  );
  assert.equal(peak, 3);
});

test('scheduler: never starts more workers than there are units', async () => {
  let inFlight = 0;
  let peak = 0;
  await runWithBatchConcurrency({
    total: 2,
    concurrency: 8,
    run: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight -= 1;
    },
  });
  assert.equal(peak, 2);
});

test('scheduler: spaces start times by the interval while units still overlap', async () => {
  const starts = [];
  let inFlight = 0;
  let peak = 0;
  const startedAt = Date.now();
  await runWithBatchConcurrency({
    total: 6,
    concurrency: 3,
    requestIntervalMs: 60,
    run: async () => {
      starts.push(Date.now());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(150);
      inFlight -= 1;
    },
  });
  const gaps = starts.slice(1).map((time, i) => time - starts[i]);
  assert.equal(starts.length, 6);
  assert.ok(
    gaps.every((gap) => gap >= 50),
    `start gaps should be about 60ms: ${gaps}`,
  );
  assert.ok(peak >= 2, 'the interval spaces starts out, it does not serialise');
  assert.ok(Date.now() - startedAt >= 5 * 60 - 10);
});

test('scheduler: onWait reports each delayed unit, and stays quiet without an interval', async () => {
  const waits = [];
  await runWithBatchConcurrency({
    total: 3,
    concurrency: 3,
    requestIntervalMs: 40,
    onWait: (index, waitUntil) =>
      waits.push({ index, waitUntil, at: Date.now() }),
    run: async () => {},
  });
  assert.deepEqual(
    waits.map((wait) => wait.index).sort(),
    [1, 2],
    'the first unit starts immediately',
  );
  for (const wait of waits)
    assert.ok(
      wait.waitUntil > wait.at,
      `unit ${wait.index} reports a future time`,
    );
  const [first, second] = waits.sort((a, b) => a.index - b.index);
  assert.ok(
    Math.abs(second.waitUntil - first.waitUntil - 40) <= 2,
    'slots are one interval apart',
  );

  const quiet = [];
  await runWithBatchConcurrency({
    total: 3,
    concurrency: 3,
    requestIntervalMs: 0,
    onWait: (index) => quiet.push(index),
    run: async () => {},
  });
  assert.deepEqual(quiet, []);
});

test('scheduler: fails fast without waiting for a straggler that never settles', async () => {
  const started = [];
  const straggler = deferred();
  const outcome = await Promise.race([
    runWithBatchConcurrency({
      total: 4,
      concurrency: 2,
      run: async (index) => {
        started.push(index);
        if (index === 0) await straggler.promise;
        else throw new Error('boom');
      },
    }).then(
      () => 'resolved',
      (error) => error,
    ),
    sleep(2000).then(() => 'hung'),
  ]);
  straggler.resolve();
  assert.ok(
    outcome instanceof Error && /boom/.test(outcome.message),
    `expected a prompt rejection, got ${outcome}`,
  );
  assert.deepEqual(
    [...started].sort(),
    [0, 1],
    'nothing new starts after the failure',
  );
});

test('scheduler: shouldStop stops dispatching but lets running units finish', async () => {
  const started = [];
  const finished = [];
  let stopped = false;
  await runWithBatchConcurrency({
    total: 10,
    concurrency: 2,
    shouldStop: () => stopped,
    run: async (index) => {
      started.push(index);
      if (index === 1) stopped = true;
      await sleep(15);
      finished.push(index);
    },
  });
  assert.deepEqual([...started].sort(), [0, 1]);
  assert.deepEqual([...finished].sort(), [0, 1]);
});

test('scheduler: shouldStop is checked again once a unit has waited for its slot', async () => {
  // Unit 1 sleeps for its interval slot while unit 0 raises the stop: starting it
  // afterwards would only send one more request that nobody wants.
  const started = [];
  let stopped = false;
  await runWithBatchConcurrency({
    total: 3,
    concurrency: 2,
    requestIntervalMs: 60,
    shouldStop: () => stopped,
    run: async (index) => {
      started.push(index);
      stopped = true;
      await sleep(10);
    },
  });
  assert.deepEqual(started, [0]);
});

test('scheduler: an abort stops dispatching and rejects with the cancel error', async () => {
  const controller = new AbortController();
  const started = [];
  const running = runWithBatchConcurrency({
    total: 10,
    concurrency: 2,
    signal: controller.signal,
    run: async (index) => {
      started.push(index);
      if (index === 1) controller.abort();
      await sleep(10);
    },
  });
  await assert.rejects(running, (error) => isTaskCancelledError(error));
  assert.deepEqual(
    [...started].sort(),
    [0, 1],
    'nothing new starts after the abort',
  );
});

test('scheduler: an abort after every unit was handed out lets them finish and resolves', async () => {
  const controller = new AbortController();
  const finished = [];
  await runWithBatchConcurrency({
    total: 2,
    concurrency: 2,
    signal: controller.signal,
    run: async (index) => {
      if (index === 1) controller.abort();
      await sleep(15);
      finished.push(index);
    },
  });
  assert.deepEqual([...finished].sort(), [0, 1]);
});

test('scheduler: an abort during the interval wait rejects with the cancel error', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runWithBatchConcurrency({
    total: 3,
    concurrency: 3,
    requestIntervalMs: 10_000,
    signal: controller.signal,
    run: async () => {
      await sleep(10);
    },
  });
  await sleep(30);
  controller.abort();
  await assert.rejects(running, (error) => isTaskCancelledError(error));
  assert.ok(Date.now() - startedAt < 2000, 'the wait must not run its course');
});

// ------------------------------------------------- correction: concurrency --

for (const configured of [4, '4']) {
  test(`correction: batches run at the provider batchConcurrency (${JSON.stringify(configured)})`, async () => {
    const meter = installLlm({ latency: 40 });
    const cues = makeCues(60);
    const outcome = await correct(cues, {
      provider: makeProvider({ batchConcurrency: configured }),
    });
    assert.equal(outcome.degraded, false);
    assert.equal(meter.calls.length, 12, '60 cues / batchSize 5');
    assert.equal(meter.peak, 4, 'four batches are in flight at once');
    assert.equal(outcome.changed, 60);
    assert.deepEqual(
      outcome.cues.map((cue) => cue[2]),
      cues.map((_, i) => `${textOf(i)}.`),
    );
    assert.ok(
      logged(/^Correction batches=12, concurrency=4, requestInterval=0ms/),
      `the effective concurrency is logged: ${JSON.stringify(logs.map((l) => l.message).slice(0, 4))}`,
    );
  });
}

test('correction: concurrency is capped at 10, like translation', async () => {
  const meter = installLlm({ latency: 30 });
  const outcome = await correct(makeCues(75), {
    provider: makeProvider({ batchConcurrency: 50 }),
  });
  assert.equal(outcome.degraded, false);
  assert.equal(meter.calls.length, 15);
  assert.equal(meter.peak, 10);
  assert.ok(logged(/concurrency=10,/));
});

for (const configured of [undefined, 1]) {
  test(`correction: batchConcurrency ${configured === undefined ? 'unset' : configured} stays strictly serial`, async () => {
    const meter = installLlm({ latency: 15 });
    const provider = makeProvider(
      configured === undefined ? {} : { batchConcurrency: configured },
    );
    const outcome = await correct(makeCues(25), { provider });
    assert.equal(outcome.degraded, false);
    assert.equal(meter.peak, 1);
    meter.calls.forEach((call, i) => {
      if (i === 0) return;
      assert.ok(
        call.startedAt >= meter.calls[i - 1].endedAt,
        `batch ${i + 1} must wait for batch ${i}`,
      );
    });
    assert.deepEqual(
      meter.calls.map((call) => call.ids[0]),
      ['1', '6', '11', '16', '21'],
      'batches go out in order',
    );
  });
}

test('correction: out-of-order completion keeps cue order and times', async () => {
  // The first requests are the slowest, so batches finish in the reverse of the
  // order they started in.
  const meter = installLlm({
    latency: (call) => Math.max(10, 140 - call.n * 30),
  });
  const cues = makeCues(20);
  const outcome = await correct(cues, {
    provider: makeProvider({ batchConcurrency: 4 }),
  });
  const finishOrder = [...meter.calls]
    .sort((a, b) => a.endedAt - b.endedAt)
    .map((call) => call.n);
  assert.notDeepEqual(
    finishOrder,
    [0, 1, 2, 3],
    'the scenario must really complete out of order',
  );
  assert.deepEqual(
    outcome.cues.map((cue) => cue[2]),
    cues.map((_, i) => `${textOf(i)}.`),
  );
  assert.deepEqual(
    outcome.cues.map((cue) => [cue[0], cue[1]]),
    cues.map((cue) => [cue[0], cue[1]]),
    'every start/end time is untouched',
  );
});

test('correction: requestInterval spaces batch starts while batches still overlap', async () => {
  const meter = installLlm({ latency: 150 });
  await correct(makeCues(30), {
    provider: makeProvider({ batchConcurrency: 3, requestInterval: '0.05' }),
  });
  const gaps = startGaps(meter.calls);
  assert.equal(meter.calls.length, 6);
  assert.ok(
    gaps.every((gap) => gap >= 40),
    `start gaps should be about 50ms: ${gaps}`,
  );
  assert.ok(meter.peak >= 2, 'the interval must not serialise the batches');
  assert.ok(logged(/requestInterval=50ms/));
});

// ------------------------------------------ correction: invariants & status --

test('correction: a failing batch does not disturb the other batches', async () => {
  installLlm({ latency: 20, fail: (call) => call.ids.includes('6') });
  const run = await correctDirect(makeItems(30), {
    provider: makeProvider({ batchConcurrency: 3 }),
  });
  assert.equal(run.cancelled, false);
  assert.deepEqual(
    run.results.map((result) => result.index),
    range(30),
    'results stay in item order',
  );
  for (const result of run.results) {
    const inFailingBatch = result.index >= 5 && result.index < 10;
    assert.equal(
      result.status,
      inFailingBatch ? 'error' : 'success',
      `item ${result.index}`,
    );
    assert.equal(
      result.corrected,
      inFailingBatch ? result.source : `${result.source}.`,
      'a failed batch keeps its original text',
    );
  }
  assert.equal(run.processedCount, 30);
});

test('correction: activity lists every in-flight batch and ends complete', async () => {
  installLlm({ latency: 40 });
  const events = [];
  await correct(makeCues(30), {
    provider: makeProvider({ batchConcurrency: 3 }),
    onActivity: (detail) => events.push(structuredClone(detail)),
  });
  const widest = Math.max(...events.map((detail) => detail.units?.length ?? 0));
  assert.ok(
    widest >= 2,
    `several batches should be visible at once: ${widest}`,
  );
  const last = events.at(-1);
  assert.equal(last.phase, 'correcting');
  assert.equal(last.completed, 30);
  assert.equal(last.total, 30);
  assert.equal(last.unit, 'cues');
  assert.deepEqual(last.units, []);
});

test('correction: progress advances as batches complete', async () => {
  // Three batches released at different times: partial progress must show up
  // instead of sitting at 0 until everything is done.
  installLlm({ latency: (call) => 30 + call.n * 40 });
  const seen = [];
  await correct(makeCues(15), {
    provider: makeProvider({ batchConcurrency: 3 }),
    onProgress: (done, total) => seen.push([done, total]),
  });
  const values = seen.map(([done]) => done);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
    'progress never goes backwards',
  );
  assert.equal(values.at(-1), 15, 'the last report is the finished count');
  assert.ok(
    values.some((value) => value > 0 && value < 15),
    `partial progress is reported: ${values}`,
  );
  assert.ok(seen.every(([, total]) => total === 15));
});

// ------------------------------------------------- correction: cancellation --

for (const concurrency of [1, 3]) {
  test(`correction: abort mid-flight (concurrency ${concurrency}) returns cancelled and starts nothing new`, async () => {
    const controller = new AbortController();
    const started = [];
    TRANSLATOR_MAP.fakellm = (prompt) => {
      const { protocol, batch } = extractBatch(prompt);
      const pending = deferred();
      started.push({ pending, answer: () => answerFor(protocol, batch) });
      return pending.promise;
    };
    const streamed = [];
    const running = correctDirect(makeItems(60), {
      provider: makeProvider({ batchConcurrency: concurrency }),
      signal: controller.signal,
      onResult: (result) => streamed.push(result),
    });
    await sleep(30);
    assert.equal(started.length, concurrency, 'requests in flight');
    controller.abort();
    // A service that answers anyway: the answers arrive after the abort.
    for (const request of started) request.pending.resolve(request.answer());
    const run = await running;
    await sleep(30);
    assert.equal(run.cancelled, true);
    assert.equal(
      started.length,
      concurrency,
      'no request starts after the abort',
    );
    assert.equal(
      run.results.length,
      0,
      'answers after the abort are discarded',
    );
    assert.equal(streamed.length, 0, 'and not streamed either');
  });
}

test('correction: runAiCorrection turns a cancel into a task-cancelled error', async () => {
  const controller = new AbortController();
  installLlm({ latency: 60 });
  const running = correct(makeCues(30), {
    provider: makeProvider({ batchConcurrency: 3 }),
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await assert.rejects(running, (error) => isTaskCancelledError(error));
});

test('correction: a cancel during the interval wait returns promptly, even if a request ignores abort', async () => {
  const controller = new AbortController();
  const stuck = deferred();
  let started = 0;
  const streamed = [];
  TRANSLATOR_MAP.fakellm = () => {
    started += 1;
    return stuck.promise;
  };
  const running = correctDirect(makeItems(20), {
    provider: makeProvider({ batchConcurrency: 2, requestInterval: 30 }),
    signal: controller.signal,
    onResult: (result) => streamed.push(result),
  });
  await sleep(30);
  controller.abort();
  const outcome = await Promise.race([running, sleep(1500).then(() => 'hung')]);
  stuck.resolve('{}');
  assert.notEqual(
    outcome,
    'hung',
    'a cancel must not wait for the stuck request',
  );
  assert.equal(outcome.cancelled, true);
  assert.equal(started, 1, 'the second batch was still waiting for its slot');
  await sleep(30);
  assert.equal(streamed.length, 0, 'a late answer produces no result events');
});

// ------------------------------------------- proofread page (legacyMap) path --

test('proofread (legacyMap): same concurrency, per-item results, ordered output', async () => {
  const meter = installLlm({ latency: 40 });
  const streamed = [];
  const progress = [];
  const run = await correctDirect(makeItems(60), {
    protocol: 'legacyMap',
    provider: makeProvider({ batchConcurrency: 4 }),
    onResult: (result) => streamed.push(result.index),
    onBatchProgress: (info) => progress.push(info),
  });
  assert.equal(meter.peak, 4);
  assert.equal(run.cancelled, false);
  assert.equal(run.processedCount, 60);
  assert.deepEqual(
    run.results.map((result) => result.index),
    range(60),
    'results stay in item order',
  );
  assert.ok(
    run.results.every(
      (result) =>
        result.status === 'success' && result.corrected.endsWith(' (opt)'),
    ),
  );
  assert.deepEqual(
    [...streamed].sort((a, b) => a - b),
    range(60),
    'every item is streamed exactly once',
  );
  assert.equal(progress.at(-1).processedCount, 60);
  assert.equal(progress.at(-1).totalCount, 60);
});

test('proofread (legacyMap): without concurrency a batch is streamed before the next request starts', async () => {
  const streamed = [];
  let streamedBeforeSecondRequest = -1;
  let requests = 0;
  TRANSLATOR_MAP.fakellm = async (prompt) => {
    const { protocol, batch } = extractBatch(prompt);
    requests += 1;
    if (requests === 2) streamedBeforeSecondRequest = streamed.length;
    return answerFor(protocol, batch);
  };
  const run = await correctDirect(makeItems(2), {
    protocol: 'legacyMap',
    batchSize: 1,
    onResult: (result) => streamed.push(result.index),
  });
  assert.equal(run.results.length, 2);
  assert.equal(streamedBeforeSecondRequest, 1);
});

// ------------------------------------------------------------------ driver --

/** A hung test must fail the run, not block CI until its job timeout. */
const TEST_DEADLINE_MS = 20_000;
function withDeadline(promise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no result within ${TEST_DEADLINE_MS}ms (hung)`)),
      TEST_DEADLINE_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    logs.length = 0;
    for (const key of Object.keys(TRANSLATOR_MAP)) delete TRANSLATOR_MAP[key];
    try {
      await withDeadline(fn());
      passed += 1;
    } catch (error) {
      failed += 1;
      reportError(
        `✗ ${name}\n    ${String((error && error.message) || error)
          .split('\n')
          .join('\n    ')}`,
      );
    }
  }
  report(`ai correction runner: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
