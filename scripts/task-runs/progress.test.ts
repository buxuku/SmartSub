import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import type { TaskRun } from '../../types/taskRun';

function harness(t: any, count = 200) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-progress-'));
  const store = createTaskRunStore(root);
  const writes = t.mock.method(store, 'write');
  const progress: TaskRun[] = [];
  const changes: TaskRun[] = [];
  const service = createTaskRunService(store, {
    onProgress: (run) => progress.push(run),
    onChange: (run) => changes.push(run),
  });
  t.after(() => {
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = service.accept({
    projectId: 'project',
    requestId: 'request',
    config: { taskType: 'generateOnly' },
    resolvedConfig: {},
    files: Array.from({ length: count }, (_, index) => ({
      uuid: `file-${index}`,
      filePath: `/audio-${index}.wav`,
    })) as any,
  });
  const token = service.beginStage(
    'project',
    run.runId,
    'file-0',
    'prepareInput',
  );
  return { service, store, writes, progress, changes, token };
}

test('a large batch coalesces progress before cloning and publishing full snapshots', (t) => {
  const { service, progress, token } = harness(t);
  const clone = t.mock.method(globalThis, 'structuredClone');
  for (let sequence = 1; sequence <= 256; sequence++)
    service.progress({ ...token, sequence, progress: sequence / 3 });
  assert.ok(progress.length <= 1, 'a burst must not publish every chunk');
  assert.ok(
    clone.mock.calls.filter((call) => call.arguments[0]?.files?.length === 200)
      .length <= 1,
    'coalescing must happen before whole-run clones',
  );
  t.mock.timers.tick(200);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].files[0].stages.prepareInput.progress, 256 / 3);
  assert.equal(progress[0].files[0].stages.prepareInput.sequence, 256);
  progress[0].files[0].stages.prepareInput.progress = 0;
  assert.equal(
    service.get('project')!.files[0].stages.prepareInput.progress,
    256 / 3,
  );
});

test('coalesced progress retains updates from concurrent files and activity', (t) => {
  const { service, progress, token } = harness(t, 2);
  const second = service.beginStage(
    'project',
    token.runId,
    'file-1',
    'prepareInput',
  );
  service.progress({ ...token, sequence: 1, progress: 15 });
  service.progress({ ...second, sequence: 1, progress: 25 });
  service.activity(token, { phase: 'reading', processedSeconds: 3 } as any);
  t.mock.timers.tick(200);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].files[0].stages.prepareInput.progress, 15);
  assert.equal(progress[0].files[1].stages.prepareInput.progress, 25);
  assert.equal(
    progress[0].files[0].projection.taskActivity?.processedSeconds,
    3,
  );
});

test('stage commits supersede delayed progress and persist their final result immediately', (t) => {
  const { service, store, progress, changes, token } = harness(t, 1);
  service.progress({ ...token, sequence: 1, progress: 70 });
  service.finishStage(token, { outcome: 'executed', artifacts: [] });
  assert.equal(
    store.read('project', token.runId)!.files[0].stages.prepareInput.status,
    'succeeded',
  );
  const before = progress.length;
  t.mock.timers.tick(10_000);
  assert.equal(
    progress.length,
    before,
    'no stale progress after the committed result',
  );
  assert.equal(changes.at(-1)!.files[0].stages.prepareInput.progress, 100);
});

test('progress checkpoints avoid frequent synchronous writes and can be flushed on quit', (t) => {
  const { service, store, writes, token } = harness(t, 1);
  const initial = writes.mock.callCount();
  service.progress({ ...token, sequence: 1, progress: 35 });
  t.mock.timers.tick(1999);
  assert.equal(writes.mock.callCount(), initial);
  t.mock.timers.tick(1);
  assert.equal(writes.mock.callCount(), initial + 1);
  assert.equal(
    store.read('project', token.runId)!.files[0].stages.prepareInput.progress,
    35,
  );
  service.progress({ ...token, sequence: 2, progress: 55 });
  service.flushProgress();
  assert.equal(
    store.read('project', token.runId)!.files[0].stages.prepareInput.progress,
    55,
  );
  const flushed = writes.mock.callCount();
  t.mock.timers.tick(10_000);
  assert.equal(writes.mock.callCount(), flushed);
});
