import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import { executeFileRun } from '../../main/helpers/taskRuns/execution';
import { assertTaskRunResultEditable } from '../../main/helpers/taskRuns/access';
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

test('a file at review can save edits while other files are queued or running', async (t) => {
  const ctx = setup(t, { dub: {}, gates: { subtitle: 'manual' } }, 2);
  const execute = async ({ stage, file }: any) =>
    stage.id === 'subtitleReview'
      ? { reviewRevision: 'review-0', projection: file.projection }
      : { outcome: 'executed' as const, artifacts: [] };
  await executeFileRun({ ...ctx, execute });
  const edit = (fileId = '0') =>
    ctx.service.recordProofreadEdit({
      projectId: 'p',
      runId: ctx.runId,
      fileId,
      digest: 'saved-review',
      translationFailures: [],
    });
  assert.equal(ctx.service.get('p')!.status, 'queued');
  assert.doesNotThrow(() => edit());
  const other = ctx.service.beginStage('p', ctx.runId, '1', 'prepareInput');
  const run = ctx.service.get('p')!;
  assert.equal(run.status, 'running');
  assert.doesNotThrow(() => assertTaskRunResultEditable(run, run.files[0]));
  assert.doesNotThrow(() => edit());
  assert.throws(() => edit('1'), /TASK_RESULT_BUSY/);
  assert.throws(
    () => assertTaskRunResultEditable(run, run.files[1]),
    /TASK_RESULT_BUSY/,
  );
  assert.throws(() => assertTaskRunResultEditable(run), /TASK_RESULT_BUSY/);
  assert.throws(
    () =>
      ctx.service.saveDraft({
        projectId: 'p',
        expectedDraftRevision: 0,
        config: {},
        files: [],
      }),
    /TASK_CONFIG_BUSY/,
  );
  ctx.service.releaseReview({
    ...ctx,
    stageId: 'subtitleReview',
    revision: 'review-0',
    projection: ctx.service.get('p')!.files[0].projection,
  });
  assert.throws(() => edit(), /TASK_RESULT_BUSY/);
  ctx.service.finishStage(other, { outcome: 'executed', artifacts: [] });
  await executeFileRun({ ...ctx, execute });
  assert.equal(
    ctx.service.get('p')!.files[0].stages.dubbing.status,
    'succeeded',
  );
});

test('dubbing review completes before track construction so saved edits reach final audio', async (t) => {
  const ctx = setup(t, { dub: {}, compose: {}, gates: { dubbing: 'manual' } });
  const calls: string[] = [];
  let voice = 'automatic';
  const execute = async ({ stage, file }: any) => {
    calls.push(stage.id);
    if (stage.id === 'dubbingReview')
      return { reviewRevision: 'audio-cues', projection: file.projection };
    if (stage.id === 'dubbingTrack') assert.equal(voice, 'reviewed');
    return { outcome: 'executed' as const, artifacts: [] };
  };
  assert.equal(await executeFileRun({ ...ctx, execute }), 'waiting_review');
  assert.equal(calls.includes('dubbingTrack'), false);
  voice = 'reviewed';
  ctx.service.releaseReview({
    ...ctx,
    stageId: 'dubbingReview',
    revision: 'audio-cues',
    projection: ctx.service.get('p')!.files[0].projection,
  });
  assert.equal(await executeFileRun({ ...ctx, execute }), 'completed');
  assert.ok(calls.indexOf('dubbingReview') < calls.indexOf('dubbingTrack'));
  assert.ok(calls.indexOf('dubbingTrack') < calls.indexOf('composeVideo'));
});

test('saved proofreading repairs are authoritative for same-run retry and remain absent from new runs', async (t) => {
  const ctx = setup(t, { dub: {} });
  const execute = async ({ stage, file }: any) => {
    if (stage.id === 'translateSubtitle')
      return {
        outcome: 'degraded' as const,
        artifacts: [],
        projection: {
          ...file.projection,
          translationFailures: [{ subtitleId: '1' }],
        },
      };
    if (stage.id === 'dubbing' && file.projection.translationFailures?.length)
      throw new Error('TRANSLATION_INCOMPLETE');
    return { outcome: 'executed' as const, artifacts: [] };
  };
  // Simulate a saved failure snapshot before the failed downstream stage.
  const run = ctx.service.get('p')!;
  const prepare = ctx.service.beginStage('p', ctx.runId, '0', 'prepareInput');
  ctx.service.finishStage(prepare, {
    outcome: 'executed',
    artifacts: [],
    projection: {
      ...run.files[0].projection,
      translationFailures: [{ subtitleId: '1' }],
    },
  });
  assert.equal(await executeFileRun({ ...ctx, execute }), 'failed');
  ctx.service.recordProofreadEdit({
    projectId: 'p',
    runId: ctx.runId,
    fileId: '0',
    digest: 'saved-repair',
    translationFailures: [],
  });
  ctx.service.command({
    projectId: 'p',
    expectedRunId: ctx.runId,
    requestId: 'retry-edit',
    command: 'retry',
  });
  assert.equal(await executeFileRun({ ...ctx, execute }), 'completed');
  assert.deepEqual(
    ctx.service.get('p')!.files[0].projection.translationFailures,
    [],
  );
  const next = ctx.service.accept({
    projectId: 'p',
    requestId: 'next',
    config: run.config,
    resolvedConfig: {},
    files: run.files.map((file) => file.input),
  });
  assert.equal(
    (ctx.service.get('p', next.runId)!.files[0].projection as any)
      .manualProofreadRevision,
    undefined,
  );
});
