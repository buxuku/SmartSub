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
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import {
  decideStageReuse,
  stageFingerprint,
} from '../../main/helpers/taskRuns/cache';
import { executeFileRun } from '../../main/helpers/taskRuns/execution';

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
  return {
    base,
    old,
    target,
    store,
    run,
    committed,
    config,
    opts,
    migration,
    select: (root: string) => {
      current = root;
    },
  };
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

for (const revisions of [
  [1, 2],
  [3, 2],
  [1, 2, 3],
  [3, 2, 1],
  [2, 2],
]) {
  test(`migration reconciles drafts across all roots (${revisions.join(', ')})`, async (t) => {
    const { base, old, target, store, select, migration } = await setup(t);
    const roots = [old, path.join(base, 'middle', 'task-runs'), target];
    const sources: string[] = [];
    for (const [index, revision] of revisions.entries()) {
      select(roots[index]);
      store.writeDraft('project', {
        revision,
        config: { model: `model-${revision}` },
        files: [],
      });
      sources.push(path.join(store.projectPath('project'), 'draft.json'));
    }
    select(target);
    const expected = store.readDraft('project');
    assert.deepEqual((await migration.preview()).blockers, []);
    await migration.execute();
    assert.equal(migration.journal()?.phase, 'done');
    assert.deepEqual(store.readDraft('project'), expected);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(store.projectPath('project'), 'draft.json'),
          'utf8',
        ),
      ),
      expected,
    );
    for (const source of sources.filter((source) => !source.startsWith(target)))
      assert.equal(
        fs.existsSync(source),
        false,
        'superseded source drafts are reclaimed',
      );
    assert.equal((await migration.preview()).files, 0);
  });
}

test('different drafts with the same revision block migration during preview', async (t) => {
  const { base, old, target, store, select, migration } = await setup(t);
  select(old);
  store.writeDraft('project', {
    revision: 2,
    config: { model: 'first' },
    files: [],
  });
  select(path.join(base, 'middle', 'task-runs'));
  store.writeDraft('project', {
    revision: 2,
    config: { model: 'second' },
    files: [],
  });
  select(target);
  assert.ok(
    (await migration.preview()).blockers.some((error) =>
      error.includes('TASK_STORAGE_CONFLICT'),
    ),
  );
});

test('reconciled drafts survive interrupted publication and retry superseded-source cleanup', async (t) => {
  const { base, old, target, store, select, opts, committed } = await setup(t);
  const sources: string[] = [];
  for (const [index, root] of [
    old,
    path.join(base, 'middle', 'task-runs'),
  ].entries()) {
    select(root);
    store.writeDraft('project', {
      revision: index + 1,
      config: { manuscriptPath: committed.patch.tempAudioFile },
      files: [],
    });
    sources.push(path.join(store.projectPath('project'), 'draft.json'));
  }
  select(target);
  const interrupted = createTaskRunMigration(store, {
    ...opts,
    checkpoint(phase) {
      if (phase === 'file-committed')
        throw new Error('interrupted publication');
    },
  });
  await assert.rejects(interrupted.execute(), /interrupted publication/);
  for (const source of sources) assert.ok(fs.existsSync(source));
  const unlink = fs.promises.unlink;
  const mock = t.mock.method(fs.promises, 'unlink', async (file) => {
    if (String(file) === sources[0]) throw new Error('locked superseded draft');
    return unlink(file);
  });
  const resumed = createTaskRunMigration(store, opts);
  await resumed.execute();
  assert.equal(resumed.journal()?.phase, 'cleanup');
  assert.equal(store.readDraft('project')!.revision, 2);
  assert.equal(
    store.readDraft('project')!.config.manuscriptPath,
    store.read('project', 'run')!.files[0].projection.tempAudioFile,
  );
  assert.ok(fs.existsSync(sources[0]));
  store.writeDraft('project', {
    revision: 3,
    config: { model: 'edited after migration' },
    files: [],
  });
  mock.mock.restore();
  await createTaskRunMigration(store, opts).execute();
  assert.equal(resumed.journal()?.phase, 'done');
  assert.equal(store.readDraft('project')!.revision, 3);
  for (const source of sources) assert.equal(fs.existsSync(source), false);
});

for (const reuseOnTarget of [false, true]) {
  test(`migration preserves cache reuse across stage dependencies (newer run on target: ${reuseOnTarget})`, async (t) => {
    const { base, old, target, store, select, migration } = await setup(t);
    const service = createTaskRunService(store);
    const artifacts = createStageArtifactStore(store);
    const counts: Record<string, number> = {};
    let request = 0;
    async function execute(config: Record<string, any> = {}) {
      const accepted = service.accept({
        projectId: 'cached',
        requestId: String(++request),
        files: [
          {
            uuid: 'f',
            filePath: '/media.mp4',
            fileName: 'media',
            fileExtension: '.mp4',
            directory: '/',
          },
        ],
        config: {
          taskType: 'generateAndTranslate',
          model: 'tiny',
          translateProvider: 'provider',
          ...config,
        },
        resolvedConfig: {
          settings: {},
          translationProviders: [{ id: 'provider', model: 'llm' }],
        },
      });
      await executeFileRun({
        service,
        projectId: 'cached',
        runId: accepted.runId,
        fileId: 'f',
        execute: async (ctx) => {
          if (ctx.stage.id === 'prepareInput')
            return {
              outcome: 'executed',
              artifacts: [],
              inputDigest: 'same-media',
              projection: {
                ...ctx.file.projection,
                inputDigests: { media: 'same-media' },
              } as any,
            };
          const previous = ctx.run.previousRunId
            ? service.get('cached', ctx.run.previousRunId)
            : null;
          const decision = await decideStageReuse({
            run: ctx.run,
            file: ctx.file,
            stageId: ctx.stage.id,
            previous,
            artifacts,
          });
          if (decision.reusable)
            return {
              ...decision,
              outcome: 'reused',
              projection: { ...ctx.file.projection, ...decision.patch },
            };
          counts[ctx.stage.id] = (counts[ctx.stage.id] || 0) + 1;
          const workspace = artifacts.workspace(ctx.token);
          const output = path.join(workspace, `${ctx.stage.id}.txt`);
          fs.writeFileSync(output, 'automatic');
          const fingerprint = stageFingerprint(ctx.run, ctx.file, ctx.stage.id);
          const result = await artifacts.commit(
            ctx.token,
            workspace,
            fingerprint,
            { [`${ctx.stage.id}File`]: output },
          );
          return {
            outcome: 'executed',
            fingerprint,
            artifacts: result.artifacts,
            projection: { ...ctx.file.projection, ...result.patch },
          };
        },
      });
      const run = service.get('cached', accepted.runId)!;
      assert.equal(run.status, 'succeeded');
      return run;
    }
    select(old);
    await execute();
    const initialCounts = { ...counts };
    select(target);
    if (reuseOnTarget) {
      await execute();
      assert.deepEqual(
        counts,
        initialCounts,
        'cache is reusable before migration',
      );
    }
    await migration.execute();
    const moved = service.get('cached')!;
    for (const stage of Object.values(moved.files[0].stages))
      if (stage.artifacts.length)
        assert.ok(await artifacts.validate(stage.artifacts));
    await execute();
    assert.deepEqual(
      counts,
      initialCounts,
      'relocation must not re-execute recognition or translation',
    );
    // A second relocation must retain the same cache identity as the first one.
    const next = path.join(base, 'next', 'task-runs');
    select(next);
    const preview = await migration.preview();
    await migration.schedule(preview.id, next);
    await migration.execute();
    const reused = await execute();
    assert.deepEqual(counts, initialCounts);
    const changed = structuredClone(reused);
    changed.runId = 'changed';
    changed.previousRunId = reused.runId;
    changed.config.model = 'large';
    assert.equal(
      (
        await decideStageReuse({
          run: changed,
          file: changed.files[0],
          stageId: 'extractSubtitle',
          previous: reused,
          artifacts,
        })
      ).reason,
      'FINGERPRINT_CHANGED',
    );
    changed.config.model = 'tiny';
    fs.appendFileSync(
      reused.files[0].stages.extractSubtitle!.artifacts[0].path,
      'corrupt',
    );
    assert.equal(
      (
        await decideStageReuse({
          run: changed,
          file: changed.files[0],
          stageId: 'extractSubtitle',
          previous: reused,
          artifacts,
        })
      ).reason,
      'ARTIFACT_INVALID',
    );
  });
}
