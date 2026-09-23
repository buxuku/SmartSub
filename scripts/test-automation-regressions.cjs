const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-review-'));
const cache = new Map();
const handlers = new Map();
const items = new Map();
const runs = new Map();
let now = Date.now(),
  quitCount = 0,
  tick;
const electronApp = new EventEmitter();
electronApp.getPath = () => root;
electronApp.getVersion = () => 'test';
electronApp.quit = () => quitCount++;
const electron = {
  app: electronApp,
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
};
const definition = (relative) => path.resolve(relative);
const stubs = new Map();
function stub(relative, value) {
  stubs.set(definition(relative), value);
}
const real = new Set(
  [
    'main/automation/service.ts',
    'main/automation/jobs.ts',
    'main/automation/events.ts',
    'main/automation/progress.ts',
    'main/automation/server.ts',
    'automation/redact.ts',
    'automation/catalog.ts',
    'automation/schemas.ts',
    'types/taskSubmission.ts',
    'types/workItem.ts',
    'main/helpers/pythonRuntime/downloader.ts',
  ].map(definition),
);
const store = {
  get(key) {
    return key === 'settings'
      ? { proxyUrl: 'http://alice:privatepass@127.0.0.1:6553' }
      : {};
  },
};
stub('main/helpers/store.ts', { store });
stub('main/helpers/workItemStore.ts', {
  getWorkItems: () =>
    [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  getWorkItemById: (id) => items.get(id),
});
stub('main/helpers/taskProcessor.ts', {
  isTranscriptionBusy: () => false,
  isTaskProjectBusy: (id) => runs.has(id),
  getTaskProjectSignal: (id) => runs.get(id)?.signal,
  enqueueTaskSubmission({ projectId }) {
    runs.set(projectId, new AbortController());
    return { success: true };
  },
});
stub('main/automation/handlers.ts', {
  invokeHandler: async (name, event, ...args) => {
    assert.ok(handlers.has(name), `missing fixture: ${name}`);
    return handlers.get(name)(event, ...args);
  },
  sendHandler: async () => {},
});
stub('main/helpers/systemInfoManager.ts', { isModelDownloadBusy: () => false });
stub('main/helpers/pipeline/deriveComposeConfig.ts', {
  DEFAULT_PIPELINE_STYLE: {},
  platformDefaultFont: () => 'Arial',
});
stub('main/helpers/dubbing/configDraftStore.ts', {
  readConfigDraft: () => null,
  readCueDraft: () => null,
});
stub('main/helpers/dubbing/sessionOwnership.ts', {
  dubbingSessionOwnership: { acquire: () => true, release: () => {} },
});
stub('main/helpers/dubbing/dubbingProcessor.ts', {
  getDubbingSession: () => ({ subtitlePath: '/fixture.srt' }),
});
stub('main/helpers/compose/composeQueue.ts', { isComposeBusy: () => false });
stub('main/helpers/videoDownload/scheduler.ts', {
  isVideoDownloadBusy: () => false,
});
stub('main/helpers/download/mirrorDownloader.ts', {
  MirrorDownloader: class {
    getProgress() {
      return { status: 'idle' };
    }
  },
});
for (const [file, method, prefix] of [
  ['fasterWhisperModelDownloader', 'getCt2ProgressKey', 'ct2'],
  ['funasrModelDownloader', 'getFunasrProgressKey', 'funasr'],
  ['qwenModelDownloader', 'getQwenProgressKey', 'qwen'],
  ['fireRedModelDownloader', 'getFireRedProgressKey', 'firered'],
  ['parakeetModelDownloader', 'getParakeetProgressKey', 'parakeet'],
  ['ttsModelDownloader', 'getTtsProgressKey', 'tts'],
])
  stub(`main/helpers/${file}.ts`, { [method]: (id) => `${prefix}:${id}` });
function load(filename) {
  if (stubs.has(filename)) return stubs.get(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  if (!real.has(filename)) return {};
  const module = { exports: {} };
  cache.set(filename, module);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      console,
      Buffer,
      process,
      AbortController,
      setTimeout,
      clearTimeout,
      setImmediate,
      structuredClone,
      URL,
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      setInterval: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      clearInterval() {},
      require(request) {
        if (request === 'electron') return electron;
        if (!request.startsWith('.')) return require(request);
        return load(path.resolve(path.dirname(filename), request + '.ts'));
      },
    },
    { filename },
  );
  return module.exports;
}
const { redact, safeMessage, redactDiagnostics } = load(
  definition('automation/redact.ts'),
);
const json = (value) => JSON.parse(JSON.stringify(value));
const sourceText =
  'The password: example is shown. Bearer trees are nearby. sk-fictionalword';
assert.deepEqual(
  json(
    redact({
      cues: [{ text: sourceText }],
      filePath: '/tmp/Bearer trees/password: example.srt',
    }),
  ),
  {
    cues: [{ text: sourceText }],
    filePath: '/tmp/Bearer trees/password: example.srt',
  },
);
for (const url of [
  'http://alice:privatepass@127.0.0.1:6553',
  'socks5://alice:p%40ss@localhost:6553',
  '//alice:privatepass@host',
]) {
  assert.ok(!redact({ proxyUrl: url }).proxyUrl.includes('alice'));
  assert.ok(!safeMessage(`Cannot connect to ${url}`).includes('alice'));
  assert.ok(
    !JSON.stringify(redactDiagnostics({ message: url })).includes(
      'privatepass',
    ),
  );
}
assert.equal(redact({ apiKey: 'credential' }).apiKey, '[REDACTED]');
const { AutomationService } = load(definition('main/automation/service.ts'));
const { automationEvents } = load(definition('main/automation/events.ts'));
const service = new AutomationService();
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition timed out');
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function main() {
  assert.ok(
    !(await service.call('settings.get', {})).settings.proxyUrl.includes(
      'privatepass',
    ),
  );
  handlers.set('optimizeSubtitle', (_event, payload) => {
    assert.equal(payload.mode, 'transcript');
    return { success: true, text: sourceText };
  });
  const optimized = await service.call('subtitles.optimize', {
    sourceText,
    providerId: 'fixture',
    mode: 'source',
  });
  assert.equal(
    (await service.jobs.wait(optimized.id, 1000)).result.text,
    sourceText,
  );
  handlers.set('dubbing:loadSubtitle', () => ({ success: true, data: {} }));
  const wave = path.join(root, 'retained.wav');
  fs.writeFileSync(wave, 'partial');
  handlers.set('dubbing:start', () => ({
    success: true,
    data: {
      doneCount: 1,
      failedIndexes: [1],
      cues: [{ wavPath: wave, text: sourceText }],
    },
  }));
  const dub = await service.call('dubbing.run', {
    sessionId: 'fixture',
    config: {
      engine: { kind: 'cloud', providerId: 'fixture' },
      voice: 'alloy',
    },
  });
  const failed = await service.jobs.wait(dub.id, 1000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'DUBBING_CUES_FAILED');
  assert.equal(failed.result.data.doneCount, 1);
  assert.equal(failed.result.data.cues[0].text, sourceText);
  assert.ok(failed.artifacts.some((a) => a.path === wave));
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(root, 'automation/jobs', dub.id + '.json')),
    ).result.data.doneCount,
    1,
  );
  for (let n = 1; n <= 5; n++)
    items.set(`history-${n}`, {
      id: `history-${n}`,
      type: 'proofread',
      status: 'done',
      createdAt: n,
      updatedAt: n,
    });
  assert.deepEqual(
    json(
      (await service.call('tasks.list', { limit: 2 })).desktop.map((t) => t.id),
    ),
    ['history-5', 'history-4'],
  );
  items.set('retry-project', {
    id: 'retry-project',
    type: 'generateOnly',
    status: 'interrupted',
    pipelineFiles: [],
    configSnapshot: {},
  });
  const retry = await service.call('tasks.retry', {
    id: 'retry-project',
    requestId: 'retry-key',
  });
  await until(() => runs.has('retry-project'));
  assert.equal(
    (
      await service.call('tasks.retry', {
        id: 'retry-project',
        requestId: 'retry-key',
      })
    ).id,
    retry.id,
  );
  await assert.rejects(
    service.call('tasks.retry', {
      id: 'different-project',
      requestId: 'retry-key',
    }),
    /REQUEST_CONFLICT/,
  );
  // Simulate the shared processor's controller being aborted by desktop IPC.
  runs.get('retry-project').abort();
  runs.delete('retry-project');
  assert.equal((await service.jobs.wait(retry.id, 1000)).status, 'cancelled');
  const listeners = automationEvents.listenerCount('event');
  const media = [];
  for (const [operation, channel] of [
    ['media.trim', 'toolbox:trimProgress'],
    ['media.extract-audio', 'toolbox:audioProgress'],
    ['media.compress', 'toolbox:compressProgress'],
    ['media.gif', 'toolbox:gifProgress'],
  ]) {
    const gate = deferred();
    const job = service.jobs.submit(operation, {}, () => gate.promise);
    media.push({ gate, job, channel });
  }
  await until(() => media.every(({ job }) => job.status === 'running'));
  for (const { job, channel } of media) {
    automationEvents.emit('event', channel, { jobId: 'other', percent: 99 });
    assert.equal(job.progress, undefined);
    automationEvents.emit('event', channel, { jobId: job.id, percent: 42 });
    assert.equal(job.progress.data[0].percent, 42);
  }
  const downloadGate = deferred();
  handlers.set('downloadCt2Model', () => downloadGate.promise);
  const model = await service.call('models.install', {
    engine: 'fasterWhisper',
    model: 'tiny',
  });
  await until(() => model.status === 'running');
  automationEvents.emit('event', 'downloadProgress', 'ct2:other', 0.5);
  assert.equal(model.progress, undefined);
  automationEvents.emit('event', 'downloadProgress', 'ct2:tiny', 0.5);
  assert.equal(model.progress.data[1], 0.5);
  automationEvents.emit('event', 'modelDownloadDetail', 'ct2:tiny', {
    downloaded: 50,
    total: 100,
  });
  assert.equal(model.progress.data[1].downloaded, 50);
  const composeGate = deferred();
  handlers.set('subtitleMerge:startMerge', () => composeGate.promise);
  const compose = await service.call('compose.run', {
    videoPath: '/v.mp4',
    subtitlePath: '/s.srt',
  });
  await until(() => compose.status === 'running');
  automationEvents.emit('event', 'compose:queue', [
    { id: 'foreign', requestId: 'other' },
    { id: 'queue-id', requestId: compose.id, status: 'running' },
  ]);
  assert.equal(compose.progress.data[0].id, 'queue-id');
  automationEvents.emit('event', 'subtitleMerge:progress', {
    jobId: 'foreign',
    percent: 98,
  });
  assert.equal(compose.progress.channel, 'compose:queue');
  automationEvents.emit('event', 'subtitleMerge:progress', {
    jobId: 'queue-id',
    percent: 24,
  });
  assert.equal(compose.progress.data[0].percent, 24);
  for (const { gate } of media) gate.resolve({ success: true });
  downloadGate.resolve({ success: true });
  composeGate.resolve({ success: true });
  await Promise.all(
    [...media.map((m) => m.job), model, compose].map((j) =>
      service.jobs.wait(j.id, 1000),
    ),
  );
  assert.equal(automationEvents.listenerCount('event'), listeners);
  const errored = service.jobs.submit('media.trim', {}, async () => {
    throw new Error('fixture processing failure');
  });
  assert.equal((await service.jobs.wait(errored.id, 1000)).status, 'failed');
  assert.equal(automationEvents.listenerCount('event'), listeners);
  const cancelGate = deferred();
  const cancellable = service.jobs.submit('media.gif', {}, async (ctx) => {
    ctx.setCancel(() => cancelGate.resolve({ cancelled: true }));
    return cancelGate.promise;
  });
  await until(() => cancellable.status === 'running');
  await service.jobs.cancel(cancellable.id);
  assert.equal(
    (await service.jobs.wait(cancellable.id, 1000)).status,
    'cancelled',
  );
  assert.equal(automationEvents.listenerCount('event'), listeners);
  const before = JSON.stringify(model.progress);
  automationEvents.emit('event', 'downloadProgress', 'ct2:tiny', 1);
  assert.equal(JSON.stringify(model.progress), before);
  const downloader = load(
    definition('main/helpers/pythonRuntime/downloader.ts'),
  );
  const runtime = downloader.getPyEngineDownloader('faster-whisper');
  const server = load(definition('main/automation/server.ts'));
  await server.startAutomationServer();
  now += 6 * 60 * 1000;
  runtime.isOperating = true;
  tick();
  assert.equal(quitCount, 0);
  runtime.isOperating = false;
  for (const status of ['downloading', 'extracting', 'verifying']) {
    runtime.core.getProgress = () => ({ status });
    tick();
    assert.equal(quitCount, 0);
  }
  runtime.core.getProgress = () => ({ status: 'done' });
  tick();
  assert.equal(quitCount, 1);
  electronApp.emit('will-quit');
  console.log(
    'Automation review regressions passed: content/URL redaction, transcript mode, partial dubbing failure, shared cancellation, retry replay, newest history, progress isolation/cleanup and runtime idle guard.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  electronApp.emit('will-quit');
});
