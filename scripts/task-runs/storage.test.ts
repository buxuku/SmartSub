import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunLocations } from '../../main/helpers/taskRuns/locations';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createStageArtifactStore } from '../../main/helpers/taskRuns/artifacts';
import { collectTaskRunGarbage } from '../../main/helpers/taskRuns/cleanup';
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
