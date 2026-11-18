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
  settings: any;
  logs: Array<{ message: string; type?: string }>;
} = {
  userData: '',
  store: undefined,
  workItems: [],
  settings: undefined,
  logs: [],
};

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
      get: (key: string) => (key === 'settings' ? state.settings : undefined),
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
  state.settings = undefined;
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

const { createProofreadDraftStore } = load(
  '../../main/helpers/proofreadDraftStore',
);
const draftKey = (...parts: string[]) =>
  `smartsub_proofread_draft_v1:${JSON.stringify(parts)}`;
const entryStores = () =>
  ['proofread-drafts', 'quality-reviews'].map((name) =>
    createProofreadDraftStore(path.join(state.userData, name)),
  );
/** A saved draft and a quality review for one document, as the editor writes them. */
const saveEntries = (key: string) =>
  entryStores().forEach((entries) => entries.write(key, '{"subtitles":[]}'));
/** Whether the draft and the review of a document still exist. */
const savedEntries = (key: string) =>
  entryStores().map((entries) => entries.list().includes(key));

test('saved drafts and reviews of a deleted task go with it instead of pinning its storage', async (t) => {
  const { base, store, seed, item } = setup(t);
  const gone = seed('deleted');
  const subtitle = path.join(gone.directory, 'files', 'f', 'out.srt');
  fs.writeFileSync(subtitle, '1\n');
  const userFile = path.join(base, 'movie.srt');
  fs.writeFileSync(userFile, '1\n');
  saveEntries(draftKey('', subtitle, ''));
  saveEntries(draftKey('', userFile, ''));
  store.prepareRetirement(['deleted']).commit();
  await runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  assert.equal(
    fs.existsSync(gone.directory),
    false,
    'its own drafts no longer keep its storage alive',
  );
  assert.deepEqual(savedEntries(draftKey('', subtitle, '')), [false, false]);
  assert.deepEqual(
    savedEntries(draftKey('', userFile, '')),
    [true, true],
    "the draft of the user's own file stays",
  );
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.type === 'info' &&
        /removed 2 saved proofread draft/.test(entry.message),
    ),
    'the removal is logged',
  );
});

test('a draft of a file another task still uses stays, and so does that storage', async (t) => {
  const { store, seed, item } = setup(t);
  const gone = seed('deleted');
  const subtitle = path.join(gone.directory, 'files', 'f', 'out.srt');
  fs.writeFileSync(subtitle, '1\n');
  state.workItems = [
    {
      id: 'other',
      type: 'proofread',
      proofreadEntries: [{ sourceSubtitlePath: subtitle }],
    },
  ];
  saveEntries(draftKey('', subtitle, ''));
  store.prepareRetirement(['deleted']).commit();
  await runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [],
  });
  assert.deepEqual(savedEntries(draftKey('', subtitle, '')), [true, true]);
  assert.ok(fs.existsSync(subtitle), 'the file the other task uses is kept');
  assert.ok(
    state.logs.some((entry) => /still referenced/.test(entry.message)),
    'the kept storage is reported',
  );
});

test('the drafts of a sidecar reclaimed with the task go, those of other sidecars stay', async (t) => {
  const { base, item } = setup(t);
  const sidecar = path.join(state.userData, 'proofread-data', 'gone.json');
  const other = path.join(state.userData, 'proofread-data', 'other.json');
  const userFile = path.join(base, 'movie.srt');
  state.workItems = [
    { id: 'other', type: 'proofread', historicalProofreadFiles: [other] },
  ];
  saveEntries(draftKey(sidecar, userFile, ''));
  saveEntries(draftKey(other, userFile, ''));
  await runtime.reclaimDeletedWorkItems({
    items: [item('deleted')],
    proofreadFiles: [sidecar],
  });
  assert.deepEqual(savedEntries(draftKey(sidecar, userFile, '')), [
    false,
    false,
  ]);
  assert.deepEqual(savedEntries(draftKey(other, userFile, '')), [true, true]);
});

const uuid = '3f2b8c1e-9a4d-4e7b-8c55-0d1f6a7b9c21';
const md5 = (digit: string) => digit.repeat(32);

test('intermediate subtitles of a deleted task go with it unless a record or draft still uses them', async (t) => {
  const { base, item } = setup(t);
  const temp = path.join(state.userData, 'whisper-subtitles');
  fs.mkdirSync(temp, { recursive: true });
  const write = (file: string) => (fs.writeFileSync(file, '1\n'), file);
  const translated = write(path.join(temp, `${uuid}.srt`));
  const source = write(path.join(temp, `${md5('a')}-source.srt`));
  const sharedFinal = write(path.join(temp, `${md5('b')}-final.srt`));
  const draftedFinal = write(path.join(temp, `${md5('c')}-final.srt`));
  const published = write(path.join(base, 'movie.srt'));
  state.workItems = [
    {
      id: 'other',
      type: 'generateOnly',
      pipelineFiles: [{ tempFinalSubtitleFile: sharedFinal }],
    },
  ];
  saveEntries(draftKey('', draftedFinal, ''));
  await runtime.reclaimDeletedWorkItems({
    items: [
      {
        ...item('deleted'),
        pipelineFiles: [
          {
            tempTranslatedSrtFile: translated,
            tempSrtFile: source,
            tempFinalSubtitleFile: sharedFinal,
          },
          // a subtitle the user published is never an intermediate one
          { tempSrtFile: published },
          { tempFinalSubtitleFile: draftedFinal },
        ],
      },
    ],
    proofreadFiles: [],
  });
  assert.equal(fs.existsSync(translated), false, 'the pure translation goes');
  assert.equal(fs.existsSync(source), false, 'so does the cached export input');
  assert.ok(fs.existsSync(sharedFinal), 'another task still records it');
  assert.ok(fs.existsSync(draftedFinal), 'a saved draft still names it');
  assert.ok(fs.existsSync(published), "the user's subtitle is never touched");
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.type === 'info' &&
        /reclaimed 2 intermediate subtitle/.test(entry.message),
    ),
    'what was reclaimed is logged',
  );
  assert.ok(
    state.logs.some((entry) =>
      /kept 2 intermediate subtitle/.test(entry.message),
    ),
    'what was kept is logged',
  );
});

test('the temp directory in use and the default one are searched, a former one is not', async (t) => {
  const { base, item } = setup(t);
  const custom = path.join(base, 'custom-temp');
  const former = path.join(base, 'former-temp');
  const standard = path.join(state.userData, 'whisper-subtitles');
  state.settings = { useCustomTempDir: true, customTempDir: custom };
  const files = [custom, standard, former].map((directory, index) => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${md5(String(index))}-final.srt`);
    fs.writeFileSync(file, '1\n');
    return file;
  });
  await runtime.reclaimDeletedWorkItems({
    items: [
      {
        ...item('deleted'),
        pipelineFiles: files.map((file) => ({ tempFinalSubtitleFile: file })),
      },
    ],
    proofreadFiles: [],
  });
  assert.deepEqual(
    files.map((file) => fs.existsSync(file)),
    [false, false, true],
    'a directory the task no longer points at is left to the manual cache cleanup',
  );
});

test('a failure while collecting references keeps the intermediate subtitles', async (t) => {
  const { item } = setup(t);
  const temp = path.join(state.userData, 'whisper-subtitles');
  fs.mkdirSync(temp, { recursive: true });
  const file = path.join(temp, `${uuid}.srt`);
  fs.writeFileSync(file, '1\n');
  const drafts = path.join(state.userData, 'proofread-drafts');
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, 'x.json'), '{"subtitles":[]}');
  fs.writeFileSync(path.join(drafts, 'x.json.key'), 'not-a-known-key');
  await runtime.reclaimDeletedWorkItems({
    items: [
      { ...item('deleted'), pipelineFiles: [{ tempTranslatedSrtFile: file }] },
    ],
    proofreadFiles: [],
  });
  assert.ok(
    fs.existsSync(file),
    'nothing is removed when references are unknown',
  );
  assert.ok(
    state.logs.some((entry) => entry.type === 'warning'),
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
