import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunLocations } from '../../main/helpers/taskRuns/locations';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createStageArtifactStore } from '../../main/helpers/taskRuns/artifacts';
import {
  collectTaskRunGarbage,
  liveWorkspaces,
  reclaimRetiredProjects,
} from '../../main/helpers/taskRuns/cleanup';
import { resolveTaskRunsRoot } from '../../main/helpers/storagePaths';

function setup(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'task-storage-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const old = path.join(base, 'user', 'task-runs');
  let current = old;
  const locations = createTaskRunLocations(
    path.join(base, 'locations.json'),
    old,
    () => current,
  );
  const store = createTaskRunStore(old, fs, locations);
  const run = {
    schemaVersion: 1,
    projectId: 'project',
    runId: 'run',
    createdAt: 1,
    revision: 1,
    files: [],
    status: 'succeeded',
  } as any;
  return {
    base,
    old,
    locations,
    store,
    run,
    select: (root: string) => {
      current = root;
    },
  };
}

test('task data follows storageRoot, independently of custom temporary storage', () => {
  assert.equal(
    resolveTaskRunsRoot({ storageRoot: '/data' }, '/user').path,
    '/data/task-runs',
  );
  assert.equal(
    resolveTaskRunsRoot({ storageRoot: '  ' }, '/user').path,
    '/user/task-runs',
  );
});

test('changing roots preserves old runs and routes new runs to the new volume', (t) => {
  const { base, old, locations, store, run, select } = setup(t);
  store.write(run);
  const target = path.join(base, 'data', 'task-runs');
  select(target);
  store.write({ ...run, runId: 'next', createdAt: 2 });
  store.write({ ...run, revision: 2 });
  assert.ok(store.runPath('project', 'run').startsWith(old));
  assert.ok(store.runPath('project', 'next').startsWith(target));
  assert.equal(store.list('project').length, 2);
  const reopened = createTaskRunStore(
    target,
    fs,
    createTaskRunLocations(locations.indexPath, old, () => target),
  );
  assert.equal(reopened.read('project', 'run')?.revision, 2);
  reopened.prepareRetirement(['project']).commit();
  assert.equal(reopened.all().length, 0);
});

test('published proofread metadata points to durable files before workspace cleanup', async (t) => {
  const { base, store, run } = setup(t);
  store.write(run);
  const artifacts = createStageArtifactStore(store, {
    workspaceRoot: () => path.join(base, 'temp', 'task-runs'),
  });
  const token = {
    projectId: 'project',
    runId: 'run',
    fileId: 'file',
    stageId: 'prepareProofread',
    attemptId: 'attempt',
  } as const;
  const workspace = artifacts.workspace(token);
  const source = path.join(workspace, 'source.srt');
  const proofread = path.join(workspace, 'proofread.json');
  fs.writeFileSync(source, 'subtitle');
  fs.writeFileSync(
    proofread,
    JSON.stringify({ meta: { sourceFile: source }, cues: [{ source }] }),
  );
  const result = await artifacts.commit(token, workspace, 'f', {
    proofreadDataFile: proofread,
    srtFile: source,
  });
  fs.rmSync(workspace, { recursive: true });
  const data = JSON.parse(
    fs.readFileSync(result.patch.proofreadDataFile, 'utf8'),
  );
  assert.equal(data.meta.sourceFile, result.patch.srtFile);
  assert.equal(
    data.cues[0].source,
    source,
    'subtitle text must never be rewritten',
  );
  assert.ok(await artifacts.validate(result.artifacts));
});

test('garbage collection preserves referenced history and reclaims retired projects only after references disappear', async (t) => {
  const { store, run } = setup(t);
  store.write(run);
  const directory = path.dirname(store.runPath('project', 'run'));
  const audio = path.join(
    directory,
    'files',
    'f',
    'attempts',
    'extractAudio-a',
    'extracted-audio.wav',
  );
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(audio, 'audio');
  store.prepareRetirement(['project']).commit();
  await collectTaskRunGarbage(store, {
    references: [{ tempAudioFile: audio }],
  });
  assert.ok(fs.existsSync(audio));
  const report = await collectTaskRunGarbage(store, { references: [] });
  assert.ok(report.bytes > 0);
  assert.equal(fs.existsSync(directory), false);
});

test('workspaces use a short independent root and failed-stage cleanup retains checkpoint references', async (t) => {
  const { base, store, run } = setup(t);
  store.write(run);
  const { cleanupWorkspace, liveWorkspaces } = await import(
    '../../main/helpers/taskRuns/cleanup'
  );
  const artifacts = createStageArtifactStore(store, {
    workspaceRoot: () => path.join(base, 'scratch'),
  });
  const token = {
    projectId: 'project',
    runId: 'run',
    fileId: 'file',
    stageId: 'extractAudio',
    attemptId: 'attempt',
  } as const;
  const workspace = artifacts.workspace(token);
  assert.equal(
    path.relative(path.join(base, 'scratch'), workspace).split(path.sep).length,
    1,
  );
  const audio = path.join(workspace, 'audio.wav');
  fs.writeFileSync(audio, 'unfinished');
  liveWorkspaces.add(workspace);
  await cleanupWorkspace(workspace, []);
  assert.ok(fs.existsSync(audio));
  liveWorkspaces.delete(workspace);
  await cleanupWorkspace(workspace, [{ tempAudioFile: audio }]);
  assert.ok(fs.existsSync(audio));
  await cleanupWorkspace(workspace, []);
  assert.equal(fs.existsSync(workspace), false);
});

test('orphan committed bundles and old attempt audio are reclaimed, while JSON references protect old media', async (t) => {
  const { store, run } = setup(t);
  store.write(run);
  const directory = path.dirname(store.runPath('project', 'run'));
  const attempt = path.join(
    directory,
    'files',
    'f',
    'attempts',
    'extractAudio-a',
  );
  fs.mkdirSync(attempt, { recursive: true });
  const referenced = path.join(attempt, 'keep.wav');
  const unused = path.join(attempt, 'unused.wav');
  fs.writeFileSync(referenced, 'keep');
  fs.writeFileSync(unused, 'discard');
  fs.writeFileSync(
    path.join(attempt, 'proofread.json'),
    JSON.stringify({ meta: { tempAudioFile: referenced } }),
  );
  const orphan = path.join(
    directory,
    'files',
    'f',
    'artifacts',
    'extractAudio-orphan',
  );
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'orphan.wav'), 'unused committed output');
  fs.writeFileSync(
    path.join(orphan, 'state.json'),
    JSON.stringify({ tempAudioFile: path.join(orphan, 'orphan.wav') }),
  );
  const report = await collectTaskRunGarbage(store, { references: [] });
  assert.deepEqual(report.errors, []);
  assert.ok(fs.existsSync(referenced));
  assert.equal(fs.existsSync(unused), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(fs.existsSync(path.join(attempt, 'proofread.json')));
});

test('offline known data and unsupported retired manifests prevent garbage collection', async (t) => {
  const { store, run } = setup(t);
  store.write(run);
  store.prepareRetirement(['project']).commit();
  const manifest = store.runPath('project', 'run');
  fs.writeFileSync(manifest, JSON.stringify({ ...run, schemaVersion: 999 }));
  const report = await collectTaskRunGarbage(store, { references: [] });
  assert.ok(
    report.errors.some((error) =>
      error.includes('TASK_RUN_VERSION_UNSUPPORTED'),
    ),
  );
  assert.ok(fs.existsSync(manifest));
  fs.unlinkSync(manifest);
  assert.throws(() => store.read('project', 'run'), /TASK_STORAGE_UNAVAILABLE/);
});

test('retirement reclaims projects across multiple roots without stale location entries', async (t) => {
  const { base, store, run, select, locations } = setup(t);
  store.write(run);
  select(path.join(base, 'new'));
  store.write({ ...run, runId: 'second', createdAt: 2 });
  store.prepareRetirement(['project']).commit();
  assert.deepEqual(
    (await collectTaskRunGarbage(store, { references: [] })).errors,
    [],
  );
  assert.deepEqual(locations.entries(), []);
  assert.deepEqual(
    (await collectTaskRunGarbage(store, { references: [] })).errors,
    [],
  );
});

test('partial recursive deletion cannot revive retired manifests, including after restart', async (t) => {
  const { old, store, run, locations } = setup(t);
  store.write(run);
  store.prepareRetirement(['project']).commit();
  const project = store.projectPath('project');
  const manifest = store.runPath('project', 'run');
  const marker = path.join(project, 'retired.json');
  const rm = fs.promises.rm;
  const mock = t.mock.method(fs.promises, 'rm', async (target, options) => {
    if (
      options?.recursive &&
      [project, path.dirname(manifest)].includes(String(target))
    ) {
      // Model rm removing the marker before encountering an inaccessible run.
      if (String(target) === project) await rm(marker, { force: true });
      throw Object.assign(new Error('EACCES: inaccessible run'), {
        code: 'EACCES',
      });
    }
    return rm(target, options);
  });
  const report = await collectTaskRunGarbage(store, { references: [] });
  assert.ok(report.errors.some((error) => error.includes('EACCES')));
  assert.ok(fs.existsSync(manifest));
  assert.deepEqual(store.all(), [], 'surviving manifests must stay retired');
  const reopened = createTaskRunStore(
    old,
    fs,
    createTaskRunLocations(locations.indexPath, old, () => old),
  );
  assert.deepEqual(
    reopened.all(),
    [],
    'restart must not resurrect the project',
  );
  mock.mock.restore();
  assert.deepEqual(
    (await collectTaskRunGarbage(reopened, { references: [] })).errors,
    [],
  );
  assert.equal(fs.existsSync(project), false);
  assert.deepEqual(reopened.locations!.entries(), []);
});

/** Writes a run plus one attempt media file; returns the run directory and that file. */
function seedRun(store: any, run: any, name = 'extracted-audio.wav') {
  store.write(run);
  const directory = path.dirname(store.runPath(run.projectId, run.runId));
  const media = path.join(
    directory,
    'files',
    'f',
    'attempts',
    'extractAudio-a',
    name,
  );
  fs.mkdirSync(path.dirname(media), { recursive: true });
  fs.writeFileSync(media, 'audio');
  return { directory, media };
}

test('deleting a task reclaims its retired data at once, even while another task is running', async (t) => {
  const { store, run, locations } = setup(t);
  seedRun(store, run);
  const live = seedRun(
    store,
    { ...run, projectId: 'other', runId: 'live', status: 'running' },
    'live.wav',
  );
  store.prepareRetirement(['project']).commit();
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: [],
  });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.retained, []);
  assert.ok(report.files > 0 && report.bytes > 0);
  assert.equal(fs.existsSync(store.projectPath('project')), false);
  assert.ok(fs.existsSync(live.media), 'a running task keeps its data');
  assert.equal(locations.entries().length, 1, 'only the live run stays pinned');
});

test('a retired task that another record still references is kept and reported', async (t) => {
  const { store, run } = setup(t);
  const { directory, media } = seedRun(store, run);
  store.prepareRetirement(['project']).commit();
  const project = store.projectPath('project');
  const kept = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: [{ tempAudioFile: media }],
  });
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.retained, [project]);
  assert.ok(fs.existsSync(media));
  assert.ok(fs.existsSync(path.join(project, 'retired.json')));
  // References may be supplied lazily; once nothing points here any more it is reclaimed.
  const later = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: async () => [],
  });
  assert.deepEqual(later.errors, []);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(project), false);
});

test('only retirement-marked directories of the deleted ids are reclaimed', async (t) => {
  const { store, run } = setup(t);
  const other = seedRun(store, { ...run, projectId: 'other', runId: 'o' });
  seedRun(store, run);
  store.prepareRetirement(['project']).commit();
  // "other" was never retired, so naming it must not delete anything.
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['other', 'unknown'],
    references: [],
  });
  assert.deepEqual(report, { files: 0, bytes: 0, errors: [], retained: [] });
  assert.ok(fs.existsSync(other.media));
  assert.ok(
    fs.existsSync(path.join(store.projectPath('project'), 'retired.json')),
  );
});

test('stage workspaces are reclaimed per owning project; live ones are skipped', async (t) => {
  const { base, store, locations } = setup(t);
  const scratch = path.join(base, 'scratch');
  locations.rememberWorkspaceRoot(scratch);
  const artifacts = createStageArtifactStore(store, {
    workspaceRoot: () => scratch,
  });
  const token = (projectId: string, attemptId: string) =>
    ({
      projectId,
      runId: 'run',
      fileId: 'file',
      stageId: 'translate',
      attemptId,
    }) as const;
  const mine = artifacts.workspace(token('project', 'a'));
  const running = artifacts.workspace(token('project', 'b'));
  const theirs = artifacts.workspace(token('other', 'a'));
  for (const directory of [mine, running, theirs])
    fs.writeFileSync(path.join(directory, 'temp.srt'), 'subtitle');
  liveWorkspaces.add(running);
  t.after(() => liveWorkspaces.delete(running));
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: [],
  });
  assert.deepEqual(report.errors, []);
  assert.equal(fs.existsSync(mine), false);
  assert.ok(fs.existsSync(running), 'a live attempt keeps its workspace');
  assert.ok(fs.existsSync(theirs), 'other projects keep theirs');
});

test('unsupported manifests keep a retired task for the global collector', async (t) => {
  const { store, run } = setup(t);
  seedRun(store, run);
  store.prepareRetirement(['project']).commit();
  const manifest = store.runPath('project', 'run');
  fs.writeFileSync(manifest, JSON.stringify({ ...run, schemaVersion: 999 }));
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: [],
  });
  assert.ok(
    report.errors.some((error) =>
      error.includes('TASK_RUN_VERSION_UNSUPPORTED'),
    ),
  );
  assert.ok(fs.existsSync(manifest));
  assert.ok(
    fs.existsSync(path.join(store.projectPath('project'), 'retired.json')),
  );
});

test('a task created again under the same id while reclaiming is not wiped', async (t) => {
  const { store, run } = setup(t);
  seedRun(store, { ...run, runId: 'first' });
  seedRun(store, { ...run, runId: 'second' });
  store.prepareRetirement(['project']).commit();
  const rm = fs.promises.rm;
  let revived = false;
  const mock = t.mock.method(
    fs.promises,
    'rm',
    async (target: any, options: any) => {
      await rm(target, options);
      if (revived) return;
      revived = true;
      // The same project id is submitted again right after the first removal.
      store.write({ ...run, runId: 'again', createdAt: 3 });
    },
  );
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['project'],
    references: [],
  });
  mock.mock.restore();
  assert.deepEqual(report.errors, []);
  const project = store.projectPath('project');
  assert.equal(fs.existsSync(path.join(project, 'retired.json')), false);
  assert.ok(
    fs.existsSync(path.join(project, 'again', 'manifest.json')),
    'the new run must survive',
  );
  assert.ok(store.all().some((value) => value.runId === 'again'));
  assert.equal(
    ['first', 'second'].filter((id) => fs.existsSync(path.join(project, id)))
      .length,
    1,
    'removal stops as soon as the project is live again',
  );
});

test('a task with only a saved draft is retired and reclaimed with it', async (t) => {
  const { store } = setup(t);
  const draft = (revision: number) =>
    ({ revision, config: {}, files: [] }) as any;
  store.writeDraft('draft-only', draft(1));
  const project = store.projectPath('draft-only');
  store.prepareRetirement(['draft-only']).commit();
  assert.ok(fs.existsSync(path.join(project, 'retired.json')));
  const report = await reclaimRetiredProjects(store, {
    projectIds: ['draft-only'],
    references: [],
  });
  assert.deepEqual(report.errors, []);
  assert.equal(fs.existsSync(project), false);
  // Saving a draft under a retired id starts a live project again.
  store.writeDraft('draft-only', draft(1));
  store.prepareRetirement(['draft-only']).commit();
  store.writeDraft('draft-only', draft(2));
  assert.equal(fs.existsSync(path.join(project, 'retired.json')), false);
  assert.equal(store.readDraft('draft-only')?.revision, 2);
});

test('retirement still refuses a project whose pinned data is offline', (t) => {
  const { store, run } = setup(t);
  seedRun(store, run);
  fs.unlinkSync(store.runPath('project', 'run'));
  assert.throws(
    () => store.prepareRetirement(['project']),
    /TASK_STORAGE_UNAVAILABLE/,
  );
});
