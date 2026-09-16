const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(initial) {
  let disk = initial || {
    workItemsMigrationVersion: 1,
    workItems: [],
    translationProviders: [],
  };
  let writeFailure = false;
  let writes = 0;
  let releaseDetection;
  const detection = new Promise((resolve) => {
    releaseDetection = resolve;
  });
  const handlers = new Map();
  const cache = new Map();
  const processed = [];
  const events = [];
  const store = {
    get: (key) => structuredClone(disk[key]),
    set(key, value) {
      if (writeFailure) throw new Error('ENOSPC');
      disk = {
        ...disk,
        ...structuredClone(typeof key === 'string' ? { [key]: value } : key),
      };
      writes++;
    },
  };
  const sender = { send: (...args) => events.push(args) };
  const stubs = {
    electron: {
      ipcMain: {
        handle: (name, handler) => handlers.set(name, handler),
        on() {},
      },
      BrowserWindow: { fromWebContents: () => ({ isFocused: () => true }) },
      Notification: {},
    },
    './store': { store },
    './storeManager': { store, logMessage() {} },
    './fileProcessor': {
      processFile: async (event, file) => {
        processed.push(file);
        event.sender.send('taskStatusChange', file, 'extractSubtitle', 'done');
      },
    },
    './whisper': { checkOpenAiWhisper: () => detection },
    './utils': { isAppleSilicon: () => false },
    './providerMigration': { resolveProviderFallbacks: () => [] },
    '../service/configurationManager': { configurationManager: {} },
    './audioProcessor': { killFfmpegForFiles() {} },
    './engines/registry': {
      getEngineAdapterForTask: () => ({}),
      listEngineAdapters: () => [],
    },
    './pythonRuntime': {},
    './powerSaveManager': {
      acquireTaskPowerSaveBlocker() {},
      releaseTaskPowerSaveBlocker() {},
    },
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
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
        structuredClone,
        AbortController,
        console,
        setTimeout: () => ({ unref() {} }),
        clearTimeout() {},
        require(request) {
          if (stubs[request]) return stubs[request];
          if (request.startsWith('.')) {
            const resolved = path.resolve(path.dirname(filename), request);
            return load(
              fs.existsSync(`${resolved}.ts`)
                ? `${resolved}.ts`
                : path.join(resolved, 'index.ts'),
            );
          }
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  }
  const items = load(
    path.resolve(__dirname, '../main/helpers/workItemStore.ts'),
  );
  items.initializeWorkItemStore();
  const processor = load(
    path.resolve(__dirname, '../main/helpers/taskProcessor.ts'),
  );
  processor.setupTaskProcessor({
    isDestroyed: () => false,
    setProgressBar() {},
    webContents: sender,
  });
  return {
    items,
    processor,
    processed,
    events,
    submit: (payload) => handlers.get('submitTask')({ sender }, payload),
    status: (id) => handlers.get('getTaskStatus')({}, id),
    disk: () => structuredClone(disk),
    writes: () => writes,
    fail: (value) => {
      writeFailure = value;
    },
    release: () => releaseDetection(false),
  };
}

async function main() {
  const payload = {
    projectId: 'project',
    requestId: 'request',
    files: [{ uuid: 'file', filePath: '/tmp/source.mp4', fileName: 'source' }],
    formData: {
      taskType: 'generateOnly',
      transcriptionEngine: 'builtin',
      model: 'base',
      nested: { value: 1 },
    },
  };
  const originalRequest = structuredClone(payload);
  const state = harness();
  state.fail(true);
  assert.match(state.submit(payload).error, /ENOSPC/);
  assert.equal(state.processor.getTranscriptionBusyCount(), 0);
  assert.equal(state.items.getWorkItemById('project'), null);
  state.fail(false);
  const accepted = state.submit(payload);
  assert.equal(accepted.success, true);
  assert.equal(accepted.duplicate, false);
  assert.equal(state.status('project'), 'running');
  assert.deepEqual(state.disk().workItems[0].configSnapshot, payload.formData);
  assert.deepEqual(state.disk().workItems[0].pipelineFiles, payload.files);
  const savedWrites = state.writes();
  assert.equal(state.submit(payload).duplicate, true);
  assert.equal(state.writes(), savedWrites);
  assert.equal(state.processor.getTranscriptionBusyCount(), 1);
  assert.match(
    state.submit({
      ...payload,
      formData: { ...payload.formData, model: 'large' },
    }).error,
    /REQUEST_CONFLICT/,
  );
  assert.match(
    state.submit({ ...payload, requestId: 'second' }).error,
    /FILES_BUSY/,
  );
  assert.match(
    state.submit({
      ...payload,
      requestId: 'new-config',
      files: [{ ...payload.files[0], uuid: 'second-file' }],
      formData: { ...payload.formData, model: 'large' },
    }).error,
    /CONFIG_BUSY/,
  );
  assert.equal(state.processor.getTranscriptionBusyCount(), 1);
  const resumed = harness(state.disk());
  assert.equal(
    resumed.submit(payload).duplicate,
    true,
    'lost reply retry after restart is not a new run',
  );
  assert.equal(resumed.processor.getTranscriptionBusyCount(), 0);
  payload.formData.nested.value = 99;
  payload.files[0].filePath = '/tmp/mutated.mp4';
  assert.equal(state.disk().workItems[0].configSnapshot.nested.value, 1);
  state.release();
  await new Promise(setImmediate);
  assert.equal(state.processed.length, 1);
  assert.equal(
    state.events.find(([channel]) => channel === 'taskStatusChange')[1]
      .taskProjectId,
    'project',
  );
  assert.equal(state.processed[0].filePath, '/tmp/source.mp4');
  assert.equal(state.processor.getTranscriptionBusyCount(), 0);

  const retry = { ...payload, requestId: 'retry' };
  state.fail(true);
  assert.match(state.submit(retry).error, /ENOSPC/);
  assert.equal(state.disk().workItems[0].configSnapshot.nested.value, 1);
  assert.equal(state.processor.getTranscriptionBusyCount(), 0);
  state.fail(false);
  assert.equal(state.submit(retry).success, true);
  await new Promise(setImmediate);
  assert.equal(state.processed.length, 2);
  assert.equal(
    state.submit(originalRequest).duplicate,
    true,
    'older accepted requests stay idempotent after later runs',
  );
  assert.equal(state.processor.getTranscriptionBusyCount(), 0);
  for (const invalid of [
    null,
    {},
    { ...payload, files: [] },
    { ...payload, files: [payload.files[0], payload.files[0]] },
    { ...payload, formData: { taskType: 'unknown' } },
  ])
    assert.equal(state.submit(invalid).success, false);

  const pinned = harness();
  pinned.items.saveWorkItem(
    {
      id: 'project',
      type: 'generateOnly',
      name: 'Pinned',
      createdAt: 1,
      updatedAt: 1,
      status: 'waiting',
      pipelineFiles: [{ uuid: 'retained', filePath: '/tmp/retained.mp4' }],
      configSnapshot: {
        ...payload.formData,
        model: 'pinned-model',
        compose: { subtitle: 'hard' },
      },
    },
    { durable: true },
  );
  assert.equal(pinned.submit(payload).success, true);
  assert.equal(pinned.disk().workItems[0].configSnapshot.model, 'pinned-model');
  assert.equal(
    pinned.disk().workItems[0].pipelineFiles.length,
    2,
    'subset retry preserves the rest of the project',
  );
  const other = {
    ...originalRequest,
    projectId: 'other-project',
    requestId: 'other-request',
  };
  assert.equal(pinned.submit(other).success, true);
  pinned.release();
  await new Promise(setImmediate);
  for (const id of ['project', 'other-project']) {
    assert.equal(
      pinned.items
        .getWorkItemById(id)
        .pipelineFiles.find((file) => file.uuid === 'file').extractSubtitle,
      'done',
      'shared file UUID events update their own project',
    );
  }
  console.log(
    'Task submission: durable acceptance, rollback, replay, busy/config conflicts, snapshot isolation, restart and queue dispatch passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
