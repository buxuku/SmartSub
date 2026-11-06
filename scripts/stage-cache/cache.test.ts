import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import { createTaskRunService } from '../../main/helpers/taskRuns/service';
import { createStageArtifactStore } from '../../main/helpers/taskRuns/artifacts';
import {
  stageFingerprint,
  decideStageReuse,
} from '../../main/helpers/taskRuns/cache';
import { executeFileRun } from '../../main/helpers/taskRuns/execution';

test('all files are reevaluated; unchanged stages avoid calls and changed parameters invalidate descendants', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createTaskRunStore(root);
  const service = createTaskRunService(store);
  const artifacts = createStageArtifactStore(store);
  const counts: Record<string, number> = {};
  const files = [0, 1].map((i) => ({
    uuid: String(i),
    filePath: `/media${i}.mp4`,
    fileName: `media${i}`,
    fileExtension: '.mp4',
    directory: '/',
  }));
  const config = {
    taskType: 'generateAndTranslate',
    model: 'tiny',
    translateProvider: 'provider',
    aiCorrection: true,
    subtitleOutputFormat: 'srt',
  };
  const resolvedConfig = {
    settings: { vadThreshold: 0.5 },
    translationProviders: [
      { id: 'provider', model: 'llm', endpoint: 'https://example.test' },
    ],
  };
  const run = async (override: any = {}, digest = 'same') => {
    const accepted = service.accept({
      projectId: 'p',
      requestId: String(service.list('p').length),
      files,
      config: { ...config, ...override },
      resolvedConfig,
    });
    for (const file of files)
      await executeFileRun({
        service,
        projectId: 'p',
        runId: accepted.runId,
        fileId: file.uuid,
        execute: async (ctx) => {
          if (ctx.stage.id === 'prepareInput')
            return {
              outcome: 'executed',
              artifacts: [],
              projection: {
                ...ctx.file.projection,
                inputDigests: { media: digest },
              } as any,
              inputDigest: digest,
            };
          const previous = ctx.run.previousRunId
            ? service.get('p', ctx.run.previousRunId)
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
          const target = path.join(workspace, `${ctx.stage.id}.txt`);
          fs.writeFileSync(target, 'automatic');
          const fingerprint = stageFingerprint(ctx.run, ctx.file, ctx.stage.id);
          const result = await artifacts.commit(
            ctx.token,
            workspace,
            fingerprint,
            { [`${ctx.stage.id}Output`]: target },
          );
          return {
            outcome: 'executed',
            artifacts: result.artifacts,
            fingerprint,
            projection: { ...ctx.file.projection, ...result.patch },
          };
        },
      });
    assert.equal(service.get('p')!.status, 'succeeded');
    return service.get('p')!;
  };
  await run();
  const first = { ...counts };
  await run();
  assert.deepEqual(counts, first);
  await run({ subtitleOutputFormat: 'vtt' });
  assert.equal(counts.extractSubtitle, 2);
  assert.equal(counts.exportSubtitle, 4);
  await run({ aiCorrection: false, subtitleOutputFormat: 'vtt' });
  assert.equal(counts.extractSubtitle, 2);
  assert.equal(counts.normalizeSubtitle, 4);
  assert.equal(counts.translateSubtitle, 4);
  await run({}, 'replaced');
  assert.equal(counts.extractSubtitle, 4);
});

test('degraded results, force policy, missing files, changed stage versions and unrelated history never hit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createTaskRunStore(root);
  const service = createTaskRunService(store);
  const artifacts = createStageArtifactStore(store);
  const accepted = service.accept({
    projectId: 'p',
    requestId: 'r',
    config: { taskType: 'generateOnly' },
    resolvedConfig: {},
    files: [
      {
        uuid: 'f',
        filePath: '/m.mp4',
        fileName: 'm',
        fileExtension: '.mp4',
        directory: '/',
      },
    ],
  });
  const previous = service.get('p')!;
  const run = structuredClone(previous);
  run.runId = 'next';
  run.previousRunId = accepted.runId;
  const file = run.files[0];
  const old = previous.files[0].stages.extractAudio!;
  const stageId = 'extractAudio';
  old.status = 'succeeded';
  old.outcome = 'executed';
  old.fingerprint = stageFingerprint(run, file, stageId);
  const token = {
    projectId: 'p',
    runId: accepted.runId,
    fileId: 'f',
    stageId,
    attemptId: 'test',
  } as const;
  const workspace = artifacts.workspace(token);
  fs.writeFileSync(path.join(workspace, 'audio.wav'), 'wav');
  old.artifacts = (
    await artifacts.commit(token, workspace, old.fingerprint, {
      tempAudioFile: path.join(workspace, 'audio.wav'),
    })
  ).artifacts;
  const check = (extra = {}) =>
    decideStageReuse({ run, file, stageId, previous, artifacts, ...extra });
  assert.equal((await check()).reusable, true);
  assert.equal((await check({ force: true })).reason, 'FORCED');
  old.outcome = 'degraded';
  assert.equal((await check()).reason, 'DEGRADED_RESULT');
  old.outcome = 'executed';
  file.stages.extractAudio!.version++;
  assert.equal((await check()).reason, 'FINGERPRINT_CHANGED');
  file.stages.extractAudio!.version--;
  assert.equal(
    (await check({ previous: { ...previous, projectId: 'another' } })).reason,
    'NO_PREVIOUS_RUN',
  );
  fs.unlinkSync(old.artifacts[0].path);
  assert.equal((await check()).reason, 'ARTIFACT_INVALID');
});

test('recognition hints and every task VAD parameter participate in the ASR fingerprint', async (t) => {
  const { TASK_VAD_SPECS } = await import('../../types/subtitleOutcome');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createTaskRunService(createTaskRunStore(root));
  service.accept({
    projectId: 'p',
    requestId: 'r',
    config: {
      taskType: 'generateOnly',
      transcriptionEngine: 'builtin',
      model: 'tiny',
      prompt: 'one',
    },
    resolvedConfig: { settings: { vadThreshold: 0.5 } },
    files: [
      {
        uuid: 'f',
        filePath: '/v.mp4',
        directory: '/',
        fileName: 'v',
        fileExtension: '.mp4',
      },
    ],
  });
  const run = service.get('p')!;
  const baseline = stageFingerprint(run, run.files[0], 'extractSubtitle');
  for (const [key, value] of [
    ['prompt', 'two'],
    ...TASK_VAD_SPECS.map((spec) => [
      spec.key,
      spec.min + (spec.max - spec.min) / 2,
    ]),
  ]) {
    const changed = structuredClone(run);
    changed.config[key as string] = value;
    assert.notEqual(
      stageFingerprint(changed, changed.files[0], 'extractSubtitle'),
      baseline,
      String(key),
    );
  }
});

test('translation presentation does not change paid-stage fingerprints; refine uses glossary selection and target language', () => {
  const run: any = {
    config: {
      taskType: 'generateAndTranslate',
      translateProvider: 'p',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      translateContent: 'onlyTranslate',
      glossaryIds: ['a'],
    },
    resolvedConfig: { settings: {}, glossaries: [{ id: 'a' }, { id: 'b' }] },
  };
  const file: any = {
    projection: {},
    stages: {
      translateSubtitle: { version: 1, dependencies: [] },
      refineSubtitle: { version: 1, dependencies: [] },
    },
  };
  const translation = stageFingerprint(run, file, 'translateSubtitle');
  for (const change of [
    { translateContent: 'sourceAndTranslate' },
    { removeChinesePunctuation: true },
    { subtitleLayout: 'two-line', subtitleLineWidth: 12 },
  ])
    assert.equal(
      stageFingerprint(
        { ...run, config: { ...run.config, ...change } },
        file,
        'translateSubtitle',
      ),
      translation,
    );
  const refine = stageFingerprint(run, file, 'refineSubtitle');
  for (const change of [
    { glossaryIds: ['b'] },
    { targetLanguage: 'ja' },
    { preserveSpeechPauses: true },
  ])
    assert.notEqual(
      stageFingerprint(
        { ...run, config: { ...run.config, ...change } },
        file,
        'refineSubtitle',
      ),
      refine,
    );
});

test('source export filename tracks provider name without invalidating recognition', () => {
  const run: any = {
    config: {
      taskType: 'generateOnly',
      translateProvider: 'p',
      customSourceSrtFileName: '${fileName}.${translateProvider}',
    },
    resolvedConfig: { translationProviders: [{ id: 'p', name: 'Original' }] },
  };
  const file: any = {
    projection: {},
    stages: {
      extractSubtitle: { version: 1, dependencies: [] },
      exportSubtitle: { version: 2, dependencies: [] },
    },
  };
  const recognition = stageFingerprint(run, file, 'extractSubtitle');
  const delivery = stageFingerprint(run, file, 'exportSubtitle');
  run.resolvedConfig.translationProviders[0].name = 'Renamed';
  assert.equal(stageFingerprint(run, file, 'extractSubtitle'), recognition);
  assert.notEqual(stageFingerprint(run, file, 'exportSubtitle'), delivery);
});
