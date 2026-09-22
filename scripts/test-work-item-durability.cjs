const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');

function harness(initial = { workItemsMigrationVersion: 1, workItems: [] }) {
  let disk = structuredClone(initial);
  let failure = false;
  const writes = [];
  const errors = [];
  const timers = new Map();
  const cache = new Map();
  const handlers = new Map();
  const store = {
    get: (key) => structuredClone(disk[key]),
    set(key, value) {
      if (failure) throw new Error('ENOSPC: test disk is full');
      disk = {
        ...disk,
        ...structuredClone(typeof key === 'string' ? { [key]: value } : key),
      };
      writes.push(structuredClone(disk));
    },
    delete(key) {
      if (failure) throw new Error('ENOSPC: test disk is full');
      delete disk[key];
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
        Date,
        console: { log() {}, error: (...args) => errors.push(args) },
        setTimeout(callback, delay) {
          const timer = { unref() {} };
          timers.set(timer, { callback, delay });
          return timer;
        },
        clearTimeout: (timer) => timers.delete(timer),
        require(request) {
          if (request === 'electron')
            return {
              ipcMain: {
                handle: (name, handler) => handlers.set(name, handler),
              },
            };
          if (request === './taskContext')
            return { getTaskContext: () => undefined };
          if (request === './store' || request === './storeManager')
            return { store };
          if (request === 'uuid') return { v4: randomUUID };
          if (request.startsWith('.'))
            return load(path.resolve(path.dirname(filename), `${request}.ts`));
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  }
  return {
    setupTasks: () =>
      load(
        path.resolve(__dirname, '../main/helpers/taskManager.ts'),
      ).setupTaskManager(),
    taskEvent: (...args) =>
      load(
        path.resolve(__dirname, '../main/helpers/taskManager.ts'),
      ).applyTaskEventToProjects(...args),
    handlers,
    items: load(path.resolve(__dirname, '../main/helpers/workItemStore.ts')),
    proofread: load(
      path.resolve(__dirname, '../main/helpers/proofreadStore.ts'),
    ),
    disk: () => structuredClone(disk),
    writes,
    errors,
    timers,
    fail: (value) => {
      failure = value;
    },
    tick() {
      const [timer, { callback }] = timers.entries().next().value;
      timers.delete(timer);
      callback();
    },
  };
}

const item = {
  id: 'task-1',
  name: 'Original',
  type: 'generateOnly',
  status: 'waiting',
  createdAt: 1,
  updatedAt: 1,
  pipelineFiles: [],
};
const test = harness();
test.items.initializeWorkItemStore();
test.setupTasks();
const draftPayload = {
  id: 'draft-project',
  taskType: 'generateOnly',
  files: [],
  taskDraft: { config: { scenarioPreset: 'movie' }, manuscripts: [] },
  preserveTaskProgress: true,
};
assert.equal(
  test.handlers.get('saveTaskProject')({}, draftPayload).id,
  'draft-project',
);
assert.equal(test.disk().workItems[0].taskDraft.config.scenarioPreset, 'movie');
test.fail(true);
assert.throws(
  () =>
    test.handlers.get('saveTaskProject')(
      {},
      {
        ...draftPayload,
        taskDraft: { config: { scenarioPreset: 'lecture' }, manuscripts: [] },
      },
    ),
  /ENOSPC/,
);
assert.equal(
  test.items.getWorkItemById('draft-project').taskDraft.config.scenarioPreset,
  'movie',
);
test.fail(false);
test.items.saveWorkItem(
  {
    ...test.items.getWorkItemById('draft-project'),
    pipelineFiles: [
      { uuid: 'clip', filePath: '/clip.mp4', extractSubtitle: 'done' },
    ],
    configSnapshot: { model: 'base' },
  },
  { durable: true },
);
test.handlers.get('saveTaskProject')(
  {},
  {
    ...draftPayload,
    files: [
      { uuid: 'clip', filePath: '/clip.mp4', extractSubtitle: 'loading' },
    ],
  },
);
assert.equal(
  test.items.getWorkItemById('draft-project').pipelineFiles[0].extractSubtitle,
  'done',
);
assert.equal(
  test.items.getWorkItemById('draft-project').configSnapshot.model,
  'base',
);
test.taskEvent('taskFileChange', {
  uuid: 'clip',
  dubbingSessionId: 'new-session',
});
assert.equal(
  test.disk().workItems[0].pipelineFiles[0].dubbingSessionId,
  'new-session',
  'the session link is durable before synthesis starts',
);
test.fail(true);
assert.throws(
  () =>
    test.taskEvent('taskFileChange', {
      uuid: 'clip',
      dubbingSessionId: 'replacement-session',
    }),
  /ENOSPC/,
);
assert.equal(
  test.items.getWorkItemById('draft-project').pipelineFiles[0].dubbingSessionId,
  'new-session',
  'failed replacement does not publish its task reference',
);
test.fail(false);
const linkWrites = test.writes.length;
test.taskEvent('taskProgressChange', { uuid: 'clip' }, 'dubbing', 50);
assert.equal(
  test.writes.length,
  linkWrites,
  'ordinary progress remains batched',
);
test.items.deleteWorkItem('draft-project');
const saved = test.items.saveWorkItem(item, { durable: true });
assert.equal(
  test.disk().workItems[0].name,
  'Original',
  'explicit save is persisted before returning',
);
saved.name = 'Return value mutated';
item.name = 'Input mutated';
assert.equal(test.items.getWorkItemById(item.id).name, 'Original');
test.fail(true);
for (const operation of [
  () => test.items.saveWorkItem({ ...item, name: 'New' }, { durable: true }),
  () => test.items.saveWorkItem({ ...item, id: 'new-item' }, { durable: true }),
  () => test.items.renameWorkItem(item.id, 'Renamed'),
  () => test.items.deleteWorkItem(item.id),
  () => test.items.clearAllWorkItems(),
]) {
  assert.throws(operation, /ENOSPC/);
  assert.equal(test.items.getWorkItems().length, 1);
  assert.equal(test.items.getWorkItemById(item.id).name, 'Original');
  assert.equal(test.disk().workItems[0].name, 'Original');
}
test.fail(false);
const deletionEvents = [];
test.items.setWorkItemDeletionHandler((items) => {
  deletionEvents.push(['stage', items.map((item) => item.id)]);
  return {
    commit: () => deletionEvents.push(['commit']),
    rollback: () => deletionEvents.push(['rollback']),
  };
});
test.fail(true);
assert.throws(() => test.items.deleteWorkItem(item.id), /ENOSPC/);
assert.deepEqual(
  deletionEvents.map(([event]) => event),
  ['stage', 'rollback'],
);
assert.ok(test.items.getWorkItemById(item.id));
test.fail(false);
test.items.deleteWorkItem(item.id);
assert.deepEqual(
  deletionEvents.map(([event]) => event),
  ['stage', 'rollback', 'stage', 'commit'],
);
test.items.saveWorkItem({ ...item, name: 'Original' }, { durable: true });
test.items.setWorkItemDeletionHandler(undefined);
const task = test.proofread.createProofreadTask(
  [
    {
      id: 'cue-file',
      sourceSubtitlePath: '/tmp/source.srt',
      detectedSubtitles: [],
    },
  ],
  'Batch',
);
assert.equal(
  task.items[0].id,
  'cue-file',
  'creation preserves renderer item identity',
);
assert.equal(
  test.disk().workItems.find((entry) => entry.id === task.id).proofreadEntries
    .length,
  1,
);
test.fail(true);
const before = JSON.stringify(test.proofread.getProofreadTaskById(task.id));
for (const operation of [
  () => test.proofread.updateProofreadTask(task.id, { name: 'Edited' }),
  () =>
    test.proofread.updateProofreadItem(task.id, 'cue-file', {
      status: 'completed',
    }),
  () => test.proofread.completeProofreadItem(task.id, 'cue-file'),
  () =>
    test.proofread.addItemsToTask(task.id, [
      { sourceSubtitlePath: '/tmp/extra.srt' },
    ]),
  () => test.proofread.removeItemFromTask(task.id, 'cue-file'),
]) {
  assert.throws(operation, /ENOSPC/);
  assert.equal(
    JSON.stringify(test.proofread.getProofreadTaskById(task.id)),
    before,
    'failed proofread edits cannot mutate committed entries',
  );
}
test.fail(false);
// Batch saves use updateProofreadTask, not the single-item completion endpoint.
let completedTask = test.proofread.updateProofreadTask(task.id, {
  items: task.items.map((entry) => ({ ...entry, status: 'completed' })),
});
assert.equal(completedTask.status, 'completed');
assert.equal(test.items.getWorkItemById(task.id).status, 'done');
assert.equal(
  test.disk().workItems.find((entry) => entry.id === task.id).status,
  'done',
);
test.proofread.updateProofreadItem(task.id, 'cue-file', {
  status: 'in_progress',
});
assert.equal(test.items.getWorkItemById(task.id).status, 'running');
test.proofread.updateProofreadTask(task.id, {
  items: [
    { ...task.items[0], status: 'completed' },
    { ...task.items[0], id: 'pending-file', status: 'pending' },
  ],
});
assert.equal(test.items.getWorkItemById(task.id).status, 'running');
test.proofread.removeItemFromTask(task.id, 'pending-file');
assert.equal(test.items.getWorkItemById(task.id).status, 'done');
const legacyProofread = harness({
  workItemsMigrationVersion: 1,
  workItems: [
    {
      ...test.items.getWorkItemById(task.id),
      status: 'running',
      finishedAt: undefined,
    },
  ],
});
legacyProofread.items.initializeWorkItemStore();
assert.equal(legacyProofread.items.getWorkItemById(task.id).status, 'done');
assert.equal(legacyProofread.disk().workItems[0].status, 'done');
test.proofread.completeProofreadItem(task.id, 'cue-file');
assert.equal(
  test.disk().workItems.find((entry) => entry.id === task.id).status,
  'done',
);
test.items.saveWorkItem({ ...item, name: 'Progress' });
assert.equal(
  test.disk().workItems.find((entry) => entry.id === item.id).name,
  'Original',
);
test.fail(true);
test.tick();
assert.equal(test.errors.length, 1, 'deferred errors are handled');
assert.equal(test.timers.size, 1, 'deferred errors schedule retry');
assert.throws(
  () => test.items.flushWorkItemStore(),
  /ENOSPC/,
  'quit can detect pending write failure',
);
test.fail(false);
test.tick();
assert.equal(
  test.disk().workItems.find((entry) => entry.id === item.id).name,
  'Progress',
);
assert.equal(test.timers.size, 0);
test.items.saveWorkItem({ ...item, name: 'Pending before explicit save' });
test.items.saveWorkItem({ ...item, id: 'second' }, { durable: true });
assert.equal(
  test.disk().workItems.find((entry) => entry.id === item.id).name,
  'Pending before explicit save',
);
assert.equal(test.timers.size, 0);

const legacy = [
  {
    uuid: 'legacy-file',
    fileName: 'legacy.mp4',
    refineSubtitle: 'loading',
    manuscriptMatch: 'loading',
    speakerDiarization: 'loading',
  },
];
const migration = harness({ tasks: legacy });
migration.fail(true);
assert.throws(() => migration.items.initializeWorkItemStore(), /ENOSPC/);
assert.equal(migration.disk().workItemsMigrationVersion, undefined);
assert.deepEqual(migration.disk().tasks, legacy);
migration.fail(false);
migration.items.initializeWorkItemStore();
assert.ok(
  migration.writes.every(
    (write) => !write.workItemsMigrationVersion || write.workItems.length === 1,
  ),
  'migration marker never precedes migrated data',
);
assert.equal(migration.disk().workItems[0].status, 'interrupted');
for (const stage of [
  'refineSubtitle',
  'manuscriptMatch',
  'speakerDiarization',
]) {
  assert.equal(migration.disk().workItems[0].pipelineFiles[0][stage], 'error');
}
console.log(
  'Work item durability: immediate persistence, error rollback, identity, deferred retry, quit flush and atomic migration passed.',
);
