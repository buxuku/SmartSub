/** Offline integration: real AI runners with controlled service and disk boundaries. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
let translate;
let adapter;
let checkBarrier;
let saveBarrier;
let saveError;
let saved = 0;
const provider = {
  id: 'test',
  type: 'test',
  name: 'Test',
  isAi: true,
  batchConcurrency: '2',
  requestInterval: '0',
};
Module._load = function (request, parent, isMain) {
  if (request === './engines/registry')
    return { getEngineAdapterForTask: () => adapter };
  if (request === './missedSpeechStage')
    return {
      runMissedSpeechCheck: async () => {
        if (checkBarrier) await checkBarrier;
      },
    };
  if (request.endsWith('/storeManager'))
    return {
      logMessage() {},
      store: {
        get: (key) => (key === 'translationProviders' ? [provider] : {}),
      },
    };
  if (request.endsWith('/translationProvider'))
    return { TRANSLATOR_MAP: { test: (...args) => translate(...args) } };
  if (request.endsWith('/types/provider'))
    return { isProviderConfigured: () => true };
  if (request.endsWith('/wordTimelineSidecar'))
    return { readWordTimelineSidecar: () => null };
  if (request.endsWith('/fileUtils'))
    return {
      formatSrtContent: (cues) =>
        cues
          .map((c, i) => `${i + 1}\n${c[0]} --> ${c[1]}\n${c[2]}\n`)
          .join('\n'),
    };
  if (request.endsWith('/atomicFile'))
    return {
      atomicReplaceTextFile: async (file, content) => {
        if (saveBarrier) await saveBarrier;
        if (saveError) throw saveError;
        await fs.promises.writeFile(file, content);
        saved++;
      },
    };
  if (request.endsWith('/glossaryManager'))
    return { getActiveGlossaryResolution: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );

const {
  routeTranscription,
} = require('../main/helpers/transcriptionRouter.ts');
const {
  runAiSegmentation,
} = require('../main/helpers/subtitleRefine/segmentationRunner.ts');
const {
  runAiCorrection,
} = require('../main/helpers/subtitleRefine/correctionRunner.ts');
const {
  runSubtitleRefineStage,
} = require('../main/helpers/subtitleRefineStage.ts');
const { TaskActivityReporter } = require('../main/helpers/taskActivity.ts');
const { runWithTaskContext } = require('../main/helpers/taskContext.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const cues = [
  ['00:00:00.000', '00:00:01.000', 'Hello there.'],
  ['00:00:03.000', '00:00:04.000', 'Nice day.'],
];
const config = {
  preserveSpeechPauses: true,
  aiSegmentation: true,
  refineProvider: 'test',
};
const input =
  '1\n00:00:00,000 --> 00:00:01,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nNice day.\n';
const echo = (prompt) => prompt.split('\n')[1];

async function main() {
  const asrEvents = [];
  const asrActivity = [];
  const check = deferred();
  checkBarrier = check.promise;
  adapter = {
    id: 'localCli',
    displayName: 'fixture',
    isAvailable: async () => ({ state: 'ready' }),
    transcribe: async ({ event, file }) => {
      event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
      event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
      return '/fixture.srt';
    },
  };
  const asrReporter = new TaskActivityReporter(1, (a) => asrActivity.push(a));
  const asr = runWithTaskContext({ activity: asrReporter }, () =>
    routeTranscription({
      file: { uuid: 'asr' },
      formData: {},
      hasOpenAiWhisper: false,
      event: { sender: { send: (...args) => asrEvents.push(args) } },
    }),
  );
  await tick();
  assert.equal(asrActivity.at(-1).phase, 'checking');
  assert.ok(
    !asrEvents.some(
      (e) => e[0] === 'taskFileChange' && e[1].extractSubtitle === 'done',
    ),
  );
  assert.equal(asrEvents.find((e) => e[0] === 'taskProgressChange')[3], 99);
  check.resolve();
  assert.equal(await asr, '/fixture.srt');
  asrReporter.close();
  assert.equal(asrActivity.at(-1).status, 'done');
  assert.ok(
    asrEvents.some(
      (e) => e[0] === 'taskFileChange' && e[1].extractSubtitle === 'done',
    ),
  );
  checkBarrier = undefined;

  const pending = [];
  const updates = [];
  translate = () => {
    const request = deferred();
    pending.push(request);
    return request.promise;
  };
  const running = runAiSegmentation({
    cues,
    words: null,
    formData: config,
    provider,
    onActivity: (detail) => updates.push(structuredClone(detail)),
  });
  await tick();
  assert.equal(pending.length, 2);
  assert.equal(updates[0].completed, 0, 'publish total before first response');
  assert.equal(updates[0].total, 2);
  assert.equal(
    updates.at(-1).units.length,
    2,
    'both in-flight batches visible',
  );
  pending[1].resolve('Nice day.');
  await tick();
  assert.equal(updates.at(-1).completed, 1);
  assert.deepEqual(
    updates.at(-1).units.map((u) => u.id),
    [1],
    'out-of-order completion preserves remaining request',
  );
  pending[0].resolve('Hello there.');
  const outcome = await running;
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(
    outcome.cues.map((c) => c[2]).join(' '),
    'Hello there. Nice day.',
  );

  let calls = 0;
  const retries = [];
  translate = async () => {
    calls++;
    return 'invented unrelated content';
  };
  const fallback = await runAiSegmentation({
    cues: cues.slice(0, 1),
    words: null,
    formData: config,
    provider,
    onActivity: (detail) => retries.push(structuredClone(detail)),
  });
  assert.equal(calls, 3, 'observer does not add retries');
  assert.equal(fallback.degradedWindows, 1);
  assert.ok(
    retries.some((d) =>
      d.units?.some((u) => u.retry === 2 && u.reason === 'validation'),
    ),
  );
  assert.equal(fallback.cues[0][2], cues[0][2]);

  translate = async () => {
    throw new Error('service unreachable');
  };
  const allFailed = await runAiSegmentation({
    cues,
    words: null,
    formData: config,
    provider,
  });
  assert.equal(allFailed.degraded, true);
  assert.equal(allFailed.totalWindows, 2);
  assert.equal(allFailed.degradedWindows, 2);

  const controller = new AbortController();
  const cancelRequests = [];
  const cancelEvents = [];
  translate = () => {
    const d = deferred();
    cancelRequests.push(d);
    return d.promise;
  };
  const cancelled = runAiSegmentation({
    cues,
    words: null,
    formData: config,
    provider,
    signal: controller.signal,
    onActivity: (detail) => cancelEvents.push(detail),
  });
  await tick();
  controller.abort();
  cancelRequests[0].resolve('Hello there.');
  await assert.rejects(cancelled, /CANCELLED/);
  const count = cancelEvents.length;
  cancelRequests[1].resolve('Nice day.');
  await tick();
  assert.equal(
    cancelEvents.length,
    count,
    'cancelled parallel workers cannot emit late activity',
  );

  const correctionEvents = [];
  let correctionCalls = 0;
  translate = async () => {
    correctionCalls++;
    if (correctionCalls === 1) throw new Error('temporary outage');
    return JSON.stringify({
      1: { src: 'Hello there.', tr: 'Hello there.' },
      2: { src: 'Nice day.', tr: 'Nice day.' },
    });
  };
  const corrected = await runAiCorrection({
    cues,
    formData: config,
    provider,
    onActivity: (detail) => correctionEvents.push(structuredClone(detail)),
  });
  assert.equal(correctionCalls, 2);
  assert.deepEqual(corrected.cues, cues);
  assert.ok(
    correctionEvents.some((d) =>
      d.units?.some(
        (u) =>
          u.phase === 'interval' && u.retry === 1 && u.waitUntil > u.startedAt,
      ),
    ),
  );
  assert.equal(correctionEvents.at(-1).completed, 2);
  assert.equal(correctionEvents.at(-1).unit, 'cues');

  let timedCalls = 0;
  const intervalEvents = [];
  translate = async (prompt) => {
    timedCalls++;
    return echo(prompt);
  };
  await runAiSegmentation({
    cues,
    words: null,
    formData: config,
    provider: { ...provider, requestInterval: '0.02' },
    onActivity: (detail) => intervalEvents.push(structuredClone(detail)),
  });
  assert.equal(timedCalls, 2);
  assert.ok(
    intervalEvents.some((d) =>
      d.units?.some((u) => u.phase === 'interval' && u.waitUntil > u.startedAt),
    ),
  );

  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-activity-'),
  );
  try {
    const file = {
      uuid: 'test',
      fileName: 'test',
      srtFile: path.join(directory, 'source.srt'),
    };
    const execute = async (options = config) => {
      const events = [];
      const activity = [];
      const reporter = new TaskActivityReporter(Date.now(), (a) =>
        activity.push(a),
      );
      const done = runWithTaskContext({ activity: reporter }, () =>
        runSubtitleRefineStage(
          { sender: { send: (...args) => events.push(structuredClone(args)) } },
          file,
          options,
        ),
      ).finally(() => reporter.close());
      return { events, activity, done };
    };
    await fs.promises.writeFile(file.srtFile, input);
    translate = async (prompt) => echo(prompt);
    const barrier = deferred();
    saveBarrier = barrier.promise;
    const stage = await execute();
    for (let n = 0; n < 100 && stage.activity.at(-1)?.phase !== 'saving'; n++)
      await tick();
    assert.equal(stage.activity.at(-1).phase, 'saving');
    assert.equal(stage.activity.at(-1).sourceSaved, true);
    assert.equal(saved, 0);
    assert.ok(
      stage.events
        .filter((e) => e[0] === 'taskProgressChange')
        .every((e) => e[3] < 100),
    );
    assert.equal(stage.activity.at(-1).status, 'running');
    barrier.resolve();
    await stage.done;
    assert.equal(saved, 1);
    assert.equal(stage.activity.at(-1).status, 'done');
    assert.ok(
      stage.events.some((e) => e[0] === 'taskProgressChange' && e[3] === 100),
    );

    saveBarrier = undefined;
    saveError = new Error('disk full');
    await fs.promises.writeFile(file.srtFile, input);
    const failedSave = await execute();
    await failedSave.done;
    assert.equal(failedSave.activity.at(-1).summary.saveFailed, true);
    assert.equal(await fs.promises.readFile(file.srtFile, 'utf8'), input);
    saveError = undefined;

    translate = async () => {
      throw new Error('network unavailable');
    };
    const degraded = await execute();
    await degraded.done;
    assert.deepEqual(degraded.activity.at(-1).summary.segmentation, {
      total: 2,
      accepted: 0,
      fallback: 2,
    });

    translate = async (prompt) => {
      if (prompt.startsWith('Insert <br>')) return echo(prompt);
      return JSON.stringify({
        1: { src: 'Hello there.', tr: 'Hello there.' },
        2: { src: 'Nice day.', tr: 'Nice day.' },
      });
    };
    for (const aiSegmentation of [false, true]) {
      await fs.promises.writeFile(file.srtFile, input);
      const correction = await execute({
        ...config,
        aiSegmentation,
        aiCorrection: true,
      });
      await correction.done;
      assert.ok(correction.activity.some((a) => a.phase === 'correcting'));
      assert.equal(
        correction.activity.some((a) => a.phase === 'segmenting'),
        aiSegmentation,
      );
      assert.equal(correction.activity.at(-1).status, 'done');
      assert.equal(
        correction.activity.at(-1).summary.correctionFailed,
        undefined,
      );
    }

    translate = async () => {
      throw new Error('empty input must not call AI');
    };
    await fs.promises.writeFile(file.srtFile, '');
    const empty = await execute();
    await empty.done;
    assert.equal(empty.activity.at(-1).status, 'done');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
  console.log(
    'Task activity integration passed: slow/concurrent requests, retries, fallback, cancellation, save boundary and empty input',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTsLoader;
  });
