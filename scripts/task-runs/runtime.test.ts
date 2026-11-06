import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import {
  beginTaskResultWrite,
  assertTaskResultsSaved,
} from '../../main/helpers/taskRuns/access';

test('review release and replacement runs cannot race an unfinished sidecar save', () => {
  const finish = beginTaskResultWrite('/edits/proofread.json');
  try {
    assert.throws(
      () => assertTaskResultsSaved(['/edits/proofread.json']),
      /TASK_RESULT_SAVE_IN_PROGRESS/,
    );
    assert.throws(
      () => beginTaskResultWrite('/edits/proofread.json'),
      /TASK_RESULT_SAVE_IN_PROGRESS/,
    );
    assert.doesNotThrow(() =>
      assertTaskResultsSaved(['/unrelated/proofread.json']),
    );
  } finally {
    finish();
  }
  assert.doesNotThrow(() => assertTaskResultsSaved(['/edits/proofread.json']));
});

const input = () => ({
  projectId: 'project',
  requestId: 'request',
  config: { taskType: 'generateOnly', model: 'tiny', aiCorrection: false },
  resolvedConfig: { settings: { vadThreshold: 0.5 }, translationProviders: [] },
  files: [
    {
      uuid: 'file',
      filePath: '/clip.mp4',
      fileName: 'clip',
      fileExtension: '.mp4',
      directory: '/',
    },
  ],
});
function harness(t: any, operations = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createTaskRunStore(root, operations);
  const changes: any[] = [];
  const service = createTaskRunService(store, {
    onChange: (value) => changes.push(value),
  });
  return { root, store, changes, service };
}

test('accepted configuration is an independent durable snapshot, including effective settings', (t) => {
  const { store, service } = harness(t);
  const payload = input();
  const result = service.accept(payload);
  payload.config.model = 'large';
  payload.resolvedConfig.settings.vadThreshold = 0.9;
  const loaded = store.read('project', result.runId)!;
  assert.equal(loaded.config.model, 'tiny');
  assert.equal(loaded.resolvedConfig.settings.vadThreshold, 0.5);
  assert.equal(loaded.files[0].input.filePath, '/clip.mp4');
  loaded.config.model = 'changed-by-reader';
  assert.equal(service.get('project', result.runId)!.config.model, 'tiny');
});

test('accepted task name is durable metadata and request replays preserve it', (t) => {
  const { store, service } = harness(t);
  const first = service.accept({ ...input(), name: '  Submitted title  ' });
  assert.equal(store.read('project', first.runId)!.name, 'Submitted title');
  service.accept({ ...input(), name: 'Changed replay title' });
  assert.equal(service.get('project')!.name, 'Submitted title');
});

test('replayed requests return the original run; conflicting replays cannot start work', (t) => {
  const { store, service } = harness(t);
  const first = service.accept(input());
  const other = createTaskRunService(store);
  const replay = other.accept(input());
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.duplicate, true);
  assert.equal(store.list('project').length, 1);
  assert.throws(
    () =>
      other.accept({
        ...input(),
        config: { ...input().config, model: 'large' },
      }),
    /TASK_REQUEST_CONFLICT/,
  );
});

test('failed durable acceptance publishes no run and no change event', (t) => {
  const { service, changes } = harness(t, {
    ...fs,
    renameSync() {
      throw new Error('ENOSPC');
    },
  });
  assert.throws(() => service.accept(input()), /ENOSPC/);
  assert.equal(service.get('project'), null);
  assert.equal(changes.length, 0);
});

test('a task owns at most one nonterminal run and cannot edit its draft while paused', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  assert.throws(
    () => service.accept({ ...input(), requestId: 'another' }),
    /TASK_RUN_BUSY/,
  );
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'pause',
    command: 'pause',
  });
  assert.equal(service.get('project')!.status, 'paused');
  assert.throws(
    () =>
      service.saveDraft({
        projectId: 'project',
        expectedDraftRevision: 0,
        config: {},
        files: [],
      }),
    /TASK_CONFIG_BUSY/,
  );
});

test('pause waits for the active stage and refuses the next stage until resumed', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  const attempt = service.beginStage('project', runId, 'file', 'prepareInput');
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'pause',
    command: 'pause',
  });
  assert.equal(service.get('project')!.status, 'pausing');
  service.finishStage(attempt, { outcome: 'executed', artifacts: [] });
  assert.equal(service.get('project')!.status, 'paused');
  assert.throws(
    () => service.beginStage('project', runId, 'file', 'extractAudio'),
    /TASK_RUN_PAUSED/,
  );
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'resume',
    command: 'resume',
  });
  assert.equal(service.get('project')!.status, 'queued');
  assert.ok(
    service.beginStage('project', runId, 'file', 'extractAudio').attemptId,
  );
});

test('events from old attempts and out of order progress are ignored', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  const first = service.beginStage('project', runId, 'file', 'prepareInput');
  assert.equal(service.progress({ ...first, sequence: 2, progress: 40 }), true);
  assert.equal(
    service.progress({ ...first, sequence: 1, progress: 10 }),
    false,
  );
  service.failStage(first, 'read failed');
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'retry',
    command: 'retry',
  });
  const second = service.beginStage('project', runId, 'file', 'prepareInput');
  assert.notEqual(first.attemptId, second.attemptId);
  assert.equal(
    service.progress({ ...first, sequence: 99, progress: 100 }),
    false,
  );
  assert.equal(
    service.finishStage(first, { outcome: 'executed', artifacts: [] }),
    false,
  );
  assert.equal(
    service.get('project')!.files[0].stages.prepareInput.progress,
    0,
  );
});

test('cancel waits for the worker and a late success cannot commit a cancelled result', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  const attempt = service.beginStage('project', runId, 'file', 'prepareInput');
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'cancel',
    command: 'cancel',
  });
  assert.equal(service.get('project')!.status, 'cancelling');
  assert.throws(
    () => service.accept({ ...input(), requestId: 'new-run' }),
    /TASK_RUN_BUSY/,
  );
  service.finishStage(attempt, { outcome: 'executed', artifacts: [] });
  assert.equal(service.get('project')!.status, 'cancelled');
  assert.equal(
    service.get('project')!.files[0].stages.prepareInput.status,
    'cancelled',
  );
  const next = service.accept({ ...input(), requestId: 'new-run' });
  assert.notEqual(next.runId, runId);
  assert.equal(
    service.finishStage(attempt, { outcome: 'executed', artifacts: [] }),
    false,
  );
  assert.equal(service.get('project')!.runId, next.runId);
});

test('draft revision rejects lost updates without overwriting history', (t) => {
  const { service } = harness(t);
  const first = service.saveDraft({
    projectId: 'project',
    expectedDraftRevision: 0,
    config: { model: 'tiny' },
    files: input().files,
  });
  assert.equal(first.revision, 1);
  assert.throws(
    () =>
      service.saveDraft({
        projectId: 'project',
        expectedDraftRevision: 0,
        config: { model: 'large' },
        files: input().files,
      }),
    /TASK_DRAFT_CONFLICT/,
  );
  assert.equal(service.getDraft('project')!.config.model, 'tiny');
});

test('editable settings are associated with the result they follow, not the next submitted run', (t) => {
  const { service } = harness(t);
  const first = service.accept(input());
  service.command({
    projectId: 'project',
    expectedRunId: first.runId,
    requestId: 'cancel',
    command: 'cancel',
  });
  const draft = service.saveDraft({
    projectId: 'project',
    expectedDraftRevision: 0,
    config: { ...input().config, model: 'large' },
    files: input().files,
  });
  assert.equal(draft.basedOnRunId, first.runId);
  assert.equal(service.get('project')!.config.model, 'tiny');
  const next = service.accept({
    ...input(),
    requestId: 'next',
    config: draft.config,
  });
  assert.notEqual(service.getDraft('project')!.basedOnRunId, next.runId);
});

test('restart interrupts active attempts while preserving paused and review runs', (t) => {
  const { store, service } = harness(t);
  const run = service.accept(input());
  service.beginStage('project', run.runId, 'file', 'prepareInput');
  const paused = service.accept({ ...input(), projectId: 'paused' });
  service.command({
    projectId: 'paused',
    expectedRunId: paused.runId,
    requestId: 'pause',
    command: 'pause',
  });
  const restarted = createTaskRunService(store);
  restarted.recover();
  assert.equal(restarted.get('project')!.status, 'interrupted');
  assert.equal(
    restarted.get('project')!.files[0].stages.prepareInput.status,
    'interrupted',
  );
  assert.equal(restarted.get('paused')!.status, 'paused');
});

test('unknown newer manifest versions are rejected without being rewritten', (t) => {
  const { store, service } = harness(t);
  const { runId } = service.accept(input());
  const target = store.runPath('project', runId);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  data.schemaVersion = 999;
  fs.writeFileSync(target, JSON.stringify(data));
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(
    () => createTaskRunService(store).get('project'),
    /TASK_RUN_VERSION_UNSUPPORTED/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.doesNotThrow(() => createTaskRunService(store).recover());
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('proofread edits distinguish a stale run from read-only legacy results', (t) => {
  const { service } = harness(t);
  const old = service.importLegacyResult({
    projectId: 'project',
    config: input().config,
    files: input().files,
    createdAt: 1,
    status: 'succeeded',
  })!;
  const edit = {
    projectId: 'project',
    runId: old.runId,
    fileId: 'file',
    digest: 'edit',
    translationFailures: [],
  };
  assert.throws(
    () => service.recordProofreadEdit(edit),
    /TASK_HISTORY_READ_ONLY/,
  );
  service.accept(input());
  assert.throws(() => service.recordProofreadEdit(edit), /TASK_RUN_CONFLICT/);
  assert.equal(
    (service.get('project', old.runId)!.files[0].projection as any)
      .manualProofreadRevision,
    undefined,
  );
});

test('legacy results retain historical locations without becoming trusted artifacts', (t) => {
  const { service, changes } = harness(t);
  const legacy = service.importLegacyResult({
    projectId: 'project',
    config: input().config,
    files: [
      {
        ...input().files[0],
        extractSubtitle: 'done',
        proofreadDataFile: '/old/proofread.json',
        dubbingSessionId: 'old-session',
      },
    ],
    createdAt: 1,
    status: 'succeeded',
  })!;
  assert.equal(
    changes.length,
    0,
    'import alone must not replace the live legacy task',
  );
  assert.throws(
    () =>
      service.command({
        projectId: 'project',
        expectedRunId: legacy.runId,
        requestId: 'retry-legacy',
        command: 'retry',
      }),
    /TASK_HISTORY_READ_ONLY/,
  );
  assert.throws(
    () => service.beginStage('project', legacy.runId, 'file', 'prepareInput'),
    /TASK_HISTORY_READ_ONLY/,
  );
  const accepted = service.accept(input());
  assert.equal(service.get('project')!.previousRunId, legacy.runId);
  assert.notEqual(accepted.runId, legacy.runId);
  const history = service.get('project', legacy.runId)!;
  assert.equal(history.legacy?.configurationComplete, false);
  assert.equal(
    history.files[0].projection.proofreadDataFile,
    '/old/proofread.json',
  );
  assert.equal(history.files[0].projection.dubbingSessionId, 'old-session');
  assert.equal(history.files[0].stages.extractSubtitle.status, 'succeeded');
  assert.equal(history.files[0].stages.extractSubtitle.version, 0);
  assert.deepEqual(history.files[0].stages.extractSubtitle.artifacts, []);
});

test('retirement prevents startup resurrection and rollback keeps references recoverable', (t) => {
  const { store, service } = harness(t);
  const accepted = service.accept(input());
  const retirement = store.prepareRetirement(['project']);
  assert.deepEqual(store.all(), []);
  assert.ok(store.read('project', accepted.runId));
  retirement.rollback();
  assert.equal(store.all().length, 1);
  store.prepareRetirement(['project']).commit();
  store.reconcileRetirements(['project']);
  assert.equal(
    store.all().length,
    1,
    'a failed WorkItem deletion recovers on restart',
  );
  store.prepareRetirement(['project']).commit();
  store.reconcileRetirements([]);
  assert.deepEqual(
    store.all(),
    [],
    'a successful deletion stays retired on restart',
  );
});

test('late activity cannot update a newer attempt or overwrite its committed projection', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  const first = service.beginStage('project', runId, 'file', 'prepareInput');
  service.failStage(first, 'failed');
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'retry',
    command: 'retry',
  });
  const second = service.beginStage('project', runId, 'file', 'prepareInput');
  const activity = { phase: 'reading', startedAt: 1 } as any;
  assert.equal(service.activity(first, activity), false);
  assert.equal(service.activity(second, activity), true);
  service.finishStage(second, {
    outcome: 'executed',
    artifacts: [],
    projection: input().files[0],
  });
  assert.deepEqual(
    service.get('project')!.files[0].projection.taskActivity,
    activity,
  );
});

test('same-run retry waits for manual repair persistence', (t) => {
  const { service } = harness(t);
  const { runId } = service.accept(input());
  const attempt = service.beginStage('project', runId, 'file', 'prepareInput');
  service.checkpoint(attempt, {
    ...input().files[0],
    proofreadDataFile: '/edits/retry.json',
  });
  service.failStage(attempt, 'failed');
  const finish = beginTaskResultWrite('/edits/retry.json');
  const command = {
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'retry',
    command: 'retry' as const,
  };
  try {
    assert.throws(
      () => service.command(command),
      /TASK_RESULT_SAVE_IN_PROGRESS/,
    );
  } finally {
    finish();
  }
  assert.equal(service.command(command).status, 'queued');
});
