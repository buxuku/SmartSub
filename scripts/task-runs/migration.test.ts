import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createTaskRunLocations } from '../../main/helpers/taskRuns/locations';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createStageArtifactStore } from '../../main/helpers/taskRuns/artifacts';
import { createTaskRunMigration } from '../../main/helpers/taskRuns/migration';

async function setup(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'task-migration-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const old = path.join(base, 'user', 'task-runs');
  const target = path.join(base, 'data', 'task-runs');
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
  store.write(run);
  const artifacts = createStageArtifactStore(store);
  const token = {
    projectId: 'project',
    runId: 'run',
    fileId: 'f',
    stageId: 'extractAudio',
    attemptId: 'a',
  } as const;
  const workspace = artifacts.workspace(token);
  const audio = path.join(workspace, 'audio.wav');
  fs.writeFileSync(audio, Buffer.alloc(1000, 5));
  const committed = await artifacts.commit(token, workspace, 'fingerprint', {
    tempAudioFile: audio,
  });
  run.files = [
    {
      fileId: 'f',
      input: {},
      projection: committed.patch,
      stages: { extractAudio: { artifacts: committed.artifacts } },
    },
  ];
  store.write(run);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      workItems: [{ pipelineFiles: [committed.patch] }],
      cues: [{ source: committed.patch.tempAudioFile }],
    }),
  );
  current = target;
  const opts = {
    journalPath: path.join(base, 'migration.json'),
    metadataFiles: async () => [config],
  };
  const migration = createTaskRunMigration(store, opts);
  const preview = await migration.preview();
  assert.deepEqual(preview.blockers, []);
  await migration.schedule(preview.id, target);
  return { base, old, target, store, run, committed, config, opts, migration };
}

test('migration verifies media, rebinds history and config, and refreshes state checksums', async (t) => {
  const { target, store, config, committed, migration } = await setup(t);
  await migration.execute();
  assert.equal(migration.journal()?.phase, 'done');
  const run = store.read('project', 'run')!;
  assert.ok(run.files[0].projection.tempAudioFile!.startsWith(target));
  assert.ok(
    await createStageArtifactStore(store).validate(
      run.files[0].stages.extractAudio!.artifacts,
    ),
  );
  assert.equal(fs.existsSync(committed.patch.tempAudioFile), false);
  const data = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(
    data.workItems[0].pipelineFiles[0].tempAudioFile,
    run.files[0].projection.tempAudioFile,
  );
  assert.equal(
    data.cues[0].source,
    committed.patch.tempAudioFile,
    'user text is not a path field',
  );
  await migration.execute();
  assert.equal(store.all().length, 1);
});

for (const boundary of ['committing', 'file-committed', 'cleanup']) {
  test(`restart recovers an interruption at ${boundary}`, async (t) => {
    const { store, opts, committed } = await setup(t);
    let interrupted = false;
    const failing = createTaskRunMigration(store, {
      ...opts,
      checkpoint(phase) {
        if (!interrupted && phase === boundary) {
          interrupted = true;
          throw new Error('simulated crash');
        }
      },
    });
    await assert.rejects(failing.execute(), /simulated crash/);
    assert.ok(fs.existsSync(committed.patch.tempAudioFile));
    const recovered = createTaskRunMigration(store, opts);
    await recovered.execute();
    const run = store.read('project', 'run')!;
    assert.ok(
      await createStageArtifactStore(store).validate(
        run.files[0].stages.extractAudio!.artifacts,
      ),
    );
    assert.equal(recovered.journal()?.phase, 'done');
  });
}

test('copy failure retains the authoritative source and can be explicitly retried', async (t) => {
  const { store, target, migration, committed } = await setup(t);
  const copy = fs.promises.copyFile;
  const mock = t.mock.method(
    fs.promises,
    'copyFile',
    async (...args: Parameters<typeof copy>) => {
      if (String(args[1]).includes('.task-migration'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return copy(...args);
    },
  );
  await assert.rejects(migration.execute(), /disk full/);
  assert.equal(migration.journal()?.phase, 'failed');
  assert.ok(fs.existsSync(committed.patch.tempAudioFile));
  assert.equal(
    store.read('project', 'run')!.files[0].projection.tempAudioFile,
    committed.patch.tempAudioFile,
  );
  mock.mock.restore();
  const preview = await migration.preview();
  await migration.schedule(preview.id, target);
  await migration.execute();
  assert.equal(migration.journal()?.phase, 'done');
});

test('draft identities move with their document paths while draft text remains unchanged', async (t) => {
  const { base, store, opts, committed } = await setup(t);
  const root = path.join(base, 'proofread-drafts');
  fs.mkdirSync(root);
  const key =
    'smartsub_proofread_draft_v1:' +
    JSON.stringify([committed.patch.tempAudioFile, '', '']);
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const file = path.join(root, hash(key) + '.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      subtitles: [{ source: committed.patch.tempAudioFile }],
      speakers: [],
    }),
  );
  fs.writeFileSync(file + '.key', key);
  const migration = createTaskRunMigration(store, {
    ...opts,
    metadataFiles: async () => [file, file + '.key'],
  });
  await migration.execute();
  const nextKey =
    'smartsub_proofread_draft_v1:' +
    JSON.stringify([
      store.read('project', 'run')!.files[0].projection.tempAudioFile,
      '',
      '',
    ]);
  const nextFile = path.join(root, hash(nextKey) + '.json');
  assert.equal(fs.existsSync(file), false);
  assert.equal(
    JSON.parse(fs.readFileSync(nextFile, 'utf8')).subtitles[0].source,
    committed.patch.tempAudioFile,
  );
  assert.equal(fs.readFileSync(nextFile + '.key', 'utf8'), nextKey);
});

test('source cleanup failure preserves the committed result and retries after editable data changes', async (t) => {
  const { config, migration, committed, store } = await setup(t);
  const unlink = fs.promises.unlink;
  const mock = t.mock.method(fs.promises, 'unlink', async (file) => {
    if (String(file) === committed.patch.tempAudioFile)
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return unlink(file);
  });
  await migration.execute();
  assert.equal(migration.journal()?.phase, 'cleanup');
  assert.ok(fs.existsSync(committed.patch.tempAudioFile));
  const migrated = store.read('project', 'run')!.files[0].projection
    .tempAudioFile!;
  assert.ok(fs.existsSync(migrated));
  const data = JSON.parse(fs.readFileSync(config, 'utf8'));
  fs.writeFileSync(
    config,
    JSON.stringify({ ...data, newlySavedSetting: true }),
  );
  mock.mock.restore();
  await migration.execute();
  assert.equal(migration.journal()?.phase, 'done');
  assert.equal(fs.existsSync(committed.patch.tempAudioFile), false);
  assert.equal(
    JSON.parse(fs.readFileSync(config, 'utf8')).newlySavedSetting,
    true,
  );
});

test('corrupted copies never replace the source and cancellation removes failed staging', async (t) => {
  const { target, migration, committed } = await setup(t);
  const copy = fs.promises.copyFile;
  const mock = t.mock.method(
    fs.promises,
    'copyFile',
    async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (String(args[0]).endsWith('.wav'))
        await fs.promises.appendFile(args[1], 'corrupt');
    },
  );
  await assert.rejects(migration.execute(), /TASK_MIGRATION_VERIFY_FAILED/);
  assert.equal(migration.journal()?.phase, 'failed');
  const id = migration.journal()!.id;
  assert.ok(fs.existsSync(committed.patch.tempAudioFile));
  mock.mock.restore();
  await migration.cancel();
  assert.equal(fs.existsSync(path.join(target, '.task-migration', id)), false);
  assert.equal(migration.journal(), null);
});

test('relocated managed inputs retain valid identities for paused continuation after recovery', async (t) => {
  const { store, run, committed, opts } = await setup(t);
  const { hashFile, assertInputIdentity } = await import(
    '../../main/helpers/taskRuns/artifacts'
  );
  run.status = 'paused';
  run.files[0].input = { filePath: committed.patch.tempAudioFile };
  run.files[0].inputIdentity = (
    await hashFile(committed.patch.tempAudioFile)
  ).identity;
  store.write(run);
  const failing = createTaskRunMigration(store, {
    ...opts,
    checkpoint(phase) {
      if (phase === 'rebinding')
        throw new Error('crash during identity rebinding');
    },
  });
  await assert.rejects(failing.execute(), /identity rebinding/);
  const recovered = createTaskRunMigration(store, opts);
  await recovered.execute();
  const moved = store.read('project', 'run')!;
  assert.equal(moved.status, 'paused');
  await assertInputIdentity(
    moved.files[0].input.filePath,
    moved.files[0].inputIdentity!,
  );
});
