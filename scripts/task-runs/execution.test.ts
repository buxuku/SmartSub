import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import { executeFileRun } from '../../main/helpers/taskRuns/execution';
function setup(t: any, config: any = {}, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-execution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createTaskRunService(createTaskRunStore(root));
  const { runId } = service.accept({
    projectId: 'p',
    requestId: 'r',
    config: { taskType: 'generateOnly', ...config },
    resolvedConfig: {},
    files: Array.from({ length: count }, (_, i) => ({
      uuid: String(i),
      filePath: '/video.mp4',
      fileName: 'video',
      fileExtension: '.mp4',
      directory: '/',
    })),
  });
  return { service, runId, projectId: 'p', fileId: '0' };
}
test('pause commits the active stage then yields the file slot; resume does not repeat it', async (t) => {
  const ctx = setup(t);
  const called: string[] = [];
  const execute = async ({ stage }: any) => {
    called.push(stage.id);
    if (stage.id === 'extractAudio')
      ctx.service.command({
        projectId: 'p',
        expectedRunId: ctx.runId,
        requestId: 'pause',
        command: 'pause',
      });
    return { outcome: 'executed' as const, artifacts: [] };
  };
  assert.equal(await executeFileRun({ ...ctx, execute }), 'paused');
  assert.deepEqual(called, ['prepareInput', 'extractAudio']);
  assert.equal(ctx.service.get('p')!.status, 'paused');
  ctx.service.command({
    projectId: 'p',
    expectedRunId: ctx.runId,
    requestId: 'resume',
    command: 'resume',
  });
  assert.equal(await executeFileRun({ ...ctx, execute }), 'completed');
  assert.equal(called.filter((s) => s === 'extractAudio').length, 1);
  assert.equal(ctx.service.get('p')!.status, 'succeeded');
});
test('one failed file does not prevent other queued files from completing; retry preserves successes', async (t) => {
  const ctx = setup(t, {}, 2);
  let failed = false;
  let successfulStages = 0;
  const execute = async ({ file, stage }: any) => {
    if (file.fileId === '0' && stage.id === 'extractAudio' && !failed) {
      failed = true;
      throw new Error('broken audio');
    }
    if (file.fileId === '1') successfulStages++;
    return { outcome: 'executed' as const, artifacts: [] };
  };
  assert.equal(await executeFileRun({ ...ctx, execute }), 'failed');
  assert.equal(ctx.service.get('p')!.status, 'queued');
  await executeFileRun({ ...ctx, fileId: '1', execute });
  assert.equal(ctx.service.get('p')!.status, 'failed');
  const before = successfulStages;
  ctx.service.command({
    projectId: 'p',
    expectedRunId: ctx.runId,
    requestId: 'retry',
    command: 'retry',
  });
  await executeFileRun({ ...ctx, execute });
  await executeFileRun({ ...ctx, fileId: '1', execute });
  assert.equal(successfulStages, before);
  assert.equal(ctx.service.get('p')!.status, 'succeeded');
});
test('manual review releases the worker but keeps the run locked and binds approval revision', async (t) => {
  const ctx = setup(t, { dub: {}, gates: { subtitle: 'manual' } });
  const execute = async ({ stage, file }: any) =>
    stage.id === 'subtitleReview'
      ? { reviewRevision: 'artifact-version', projection: file.projection }
      : { outcome: 'executed' as const, artifacts: [] };
  assert.equal(await executeFileRun({ ...ctx, execute }), 'waiting_review');
  assert.equal(ctx.service.get('p')!.status, 'waiting_review');
  assert.throws(
    () =>
      ctx.service.releaseReview({
        ...ctx,
        stageId: 'subtitleReview',
        revision: 'old',
        projection: {} as any,
      }),
    /TASK_REVIEW_CONFLICT/,
  );
  ctx.service.releaseReview({
    ...ctx,
    stageId: 'subtitleReview',
    revision: 'artifact-version',
    projection: ctx.service.get('p')!.files[0].projection,
  });
  assert.equal(await executeFileRun({ ...ctx, execute }), 'completed');
});
