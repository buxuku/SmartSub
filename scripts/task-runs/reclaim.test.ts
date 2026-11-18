import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// storageRuntime needs Electron, electron-store and the live run store. Only those are
// replaced; the collector, reclaim and registry code under test is the real thing.
const here = path.resolve(__dirname, 'reclaim.test.ts');
const load = createRequire(here);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const state: {
  userData: string;
  store: any;
  workItems: any[];
  logs: Array<{ message: string; type?: string }>;
} = { userData: '', store: undefined, workItems: [], logs: [] };

const stubs: Record<string, () => unknown> = {
  electron: () => ({
    app: { getPath: () => state.userData },
    BrowserWindow: class {},
  }),
  '../../automation/handlers': () => ({
    ipcMain: { handle() {}, on() {} },
  }),
  '../store': () => ({
    store: {
      path: path.join(state.userData, 'config.json'),
      store: {},
      get: () => undefined,
    },
  }),
  '../workItemStore': () => ({ getWorkItems: () => state.workItems }),
  './runtime': () => ({ getRunStore: () => state.store }),
  './migration': () => ({
    createTaskRunMigration: () => ({ journal: () => undefined }),
  }),
  '../logger': () => ({
    logMessage: (message: string, type?: string) =>
      state.logs.push({ message: String(message), type }),
  }),
};
const originalLoad = (Module as any)._load;
(Module as any)._load = function (
  request: string,
  parent: any,
  ...rest: any[]
) {
  if (
    parent?.filename?.endsWith(`taskRuns${path.sep}storageRuntime.ts`) &&
    request in stubs
  )
    return stubs[request]();
  return originalLoad.call(this, request, parent, ...rest);
};
const runtime = load('../../main/helpers/taskRuns/storageRuntime');
const { createTaskRunStore } = load('../../main/helpers/taskRuns/store');
const { createTaskRunLocations } = load(
  '../../main/helpers/taskRuns/locations',
);
const { setTaskDataReclaimer, startTaskDataReclaim, settleTaskDataReclaim } =
  load('../../main/helpers/taskDataReclaim');

function setup(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reclaim-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  state.userData = path.join(base, 'user');
  state.logs = [];
  state.workItems = [];
  const root = path.join(state.userData, 'task-runs');
  const locations = createTaskRunLocations(
    path.join(base, 'locations.json'),
    root,
    () => root,
  );
  const store = createTaskRunStore(root, fs, locations);
  state.store = store;
  const run = (projectId: string, status: string) =>
    ({
      schemaVersion: 1,
      projectId,
      runId: `${projectId}-run`,
      createdAt: 1,
      revision: 1,
      files: [],
      status,
    }) as any;
  /** A run with one attempt media file inside its directory. */
  const seed = (projectId: string, status = 'succeeded') => {
    store.write(run(projectId, status));
    const directory = path.dirname(
      store.runPath(projectId, `${projectId}-run`),
    );
    const media = path.join(directory, 'files', 'f', 'attempts', 'a', 'x.wav');
    fs.mkdirSync(path.dirname(media), { recursive: true });
    fs.writeFileSync(media, 'audio');
    return { directory, media };
  };
  const item = (id: string) => ({ id, name: id, type: 'generateOnly' }) as any;
  return { base, store, seed, item, run };
}

test('deleting a task reclaims its data while another task is running, unlike the global collector', async (t) => {
  const { store, seed, item } = setup(t);
  const gone = seed('deleted');
  const live = seed('live', 'running');
  store.prepareRetirement(['deleted']).commit();
  const collector = await runtime.cleanTaskStorage();
  assert.deepEqual(
    collector.errors,
    ['TASK_STORAGE_BUSY'],
    'the global collector gives up while any task runs',
  );
  assert.ok(fs.existsSync(gone.media));
  await runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  assert.equal(fs.existsSync(gone.directory), false);
  assert.ok(fs.existsSync(live.media), 'the running task is untouched');
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.type === 'info' && /reclaimed \d+ files/.test(entry.message),
    ),
    'what was reclaimed is logged',
  );
});

test('the reclaim holds no maintenance lock, so other tasks can keep writing', async (t) => {
  const { store, seed, item, run } = setup(t);
  seed('deleted');
  store.prepareRetirement(['deleted']).commit();
  const rm = fs.promises.rm;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let blocked = false;
  const mock = t.mock.method(fs.promises, 'rm', async (...args: any[]) => {
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return (rm as any)(...args);
  });
  const reclaim = runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  await sleep(50);
  assert.ok(blocked, 'the reclaim is mid-removal');
  assert.doesNotThrow(() => store.write(run('newcomer', 'queued')));
  release();
  await reclaim;
  mock.mock.restore();
  assert.ok(store.all().some((value: any) => value.projectId === 'newcomer'));
});

test('the global collector and the reclaim never run at the same time', async (t) => {
  const { store, seed, item } = setup(t);
  seed('deleted');
  seed('live', 'running');
  store.prepareRetirement(['deleted']).commit();
  let allCalls = 0;
  const all = store.all.bind(store);
  store.all = (...args: any[]) => {
    allCalls += 1;
    return all(...args);
  };
  const rm = fs.promises.rm;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let blocked = false;
  const mock = t.mock.method(fs.promises, 'rm', async (...args: any[]) => {
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return (rm as any)(...args);
  });
  const reclaim = runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  await sleep(50);
  assert.ok(blocked);
  const before = allCalls;
  const collector = runtime.cleanTaskStorage();
  await sleep(50);
  assert.equal(allCalls, before, 'the collector waits for the reclaim');
  release();
  await reclaim;
  await collector;
  mock.mock.restore();
  assert.ok(allCalls > before, 'and runs once the reclaim is done');
});

test('an unreadable draft identity stops the cleanup instead of risking referenced data', async (t) => {
  const { store, seed, item } = setup(t);
  const gone = seed('deleted');
  store.prepareRetirement(['deleted']).commit();
  const drafts = path.join(state.userData, 'proofread-drafts');
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, 'x.json'), '{"subtitles":[]}');
  fs.writeFileSync(path.join(drafts, 'x.json.key'), 'not-a-known-key');
  await runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  assert.ok(
    fs.existsSync(gone.media),
    'nothing is removed when references are unknown',
  );
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.type === 'warning' &&
        /TASK_DRAFT_IDENTITY_UNKNOWN/.test(entry.message),
    ),
    'the problem is logged as a warning',
  );
});

test('the registered reclaimer runs for started requests and settle waits for it', async () => {
  const seen: string[][] = [];
  let finished = false;
  setTaskDataReclaimer(async (request: any) => {
    seen.push(request.items.map((item: any) => item.id));
    await sleep(30);
    finished = true;
  });
  try {
    startTaskDataReclaim({ items: [{ id: 'a' }], proofreadFiles: [] });
    startTaskDataReclaim({ items: [], proofreadFiles: [] });
    assert.equal(finished, false);
    await settleTaskDataReclaim();
    assert.equal(finished, true);
    assert.deepEqual(seen, [['a']], 'empty requests are ignored');
  } finally {
    setTaskDataReclaimer(undefined);
  }
});
