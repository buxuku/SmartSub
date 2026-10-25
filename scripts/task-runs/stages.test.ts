import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getFileStages,
  getFilePercent,
  isProofreadReady,
  getFileRail,
} from '../../renderer/components/tasks/stageUtils';
import { derivePipelineWorkItemStatus } from '../../main/helpers/workItemMigration';
import { clearInactiveTaskStages } from '../../types/taskStages';
import { buildFileStagePlan } from '../../types/taskRun';

test('managed rail presents dubbing approval before final track construction', () => {
  const config = {
    taskType: 'generateOnly',
    dub: { providerId: 'tts' },
    gates: { dubbing: 'manual' },
  };
  const file = {
    filePath: '/clip.mp4',
    stageRuns: Object.fromEntries(
      buildFileStagePlan({ filePath: '/clip.mp4' } as any, config).map((id) => [
        id,
        { id, status: 'pending' },
      ]),
    ),
  };
  const keys = getFileRail(file, type as any, config).map((item) =>
    item.kind === 'stage' ? item.stage.key : item.gate.key,
  );
  assert.ok(keys.indexOf('dubbingGate') > keys.indexOf('dubbing'));
  assert.ok(keys.indexOf('dubbingGate') < keys.indexOf('dubbingTrack'));
});

const type = {
  slug: 'generate',
  taskType: 'generateOnly',
  accepts: 'media',
  needsModel: true,
  hasTranslate: false,
} as const;
const config = {
  taskType: 'generateOnly',
  aiSegmentation: false,
  aiCorrection: false,
  speakerDiarization: false,
};
const completed = {
  uuid: 'clip',
  filePath: '/video.mp4',
  extractAudio: 'done',
  extractSubtitle: 'done',
  exportSubtitle: 'done',
  proofreadDataReady: 'done',
};

test('cancelled optional fields cannot add ghost stages or disable proofreading (#564)', () => {
  const file = {
    ...completed,
    refineSubtitle: '',
    manuscriptMatch: '',
    speakerDiarization: '',
  };
  const stages = getFileStages(file, type, config);
  assert.deepEqual(
    stages.map((s) => s.key),
    ['extractAudio', 'extractSubtitle', 'exportSubtitle'],
  );
  assert.equal(getFilePercent(file, stages), 100);
  assert.equal(isProofreadReady(file, type, config), true);
  assert.equal(derivePipelineWorkItemStatus([file as any]), 'done');
});

test('reserved legacy export remains pending without counting empty optional stages', () => {
  const file = {
    ...completed,
    exportSubtitle: '',
    refineSubtitle: '',
    manuscriptMatch: '',
    speakerDiarization: '',
  };
  const stages = getFileStages(file, type, config);
  assert.equal(derivePipelineWorkItemStatus([file as any]), 'waiting');
  assert.equal(isProofreadReady(file, type, config), false);
  assert.ok(getFilePercent(file, stages) < 100);
  assert.equal(
    derivePipelineWorkItemStatus([{ ...file, exportSubtitle: 'done' } as any]),
    'done',
  );
  assert.equal(
    derivePipelineWorkItemStatus([
      { ...file, exportSubtitle: undefined } as any,
    ]),
    'done',
  );
});

test('explicitly disabled optional stages do not inherit an old successful state', () => {
  const stages = getFileStages(
    { ...completed, refineSubtitle: 'done', speakerDiarization: 'done' },
    type,
    config,
  );
  assert.deepEqual(
    stages.map((s) => s.key),
    ['extractAudio', 'extractSubtitle', 'exportSubtitle'],
  );
});

test('legacy records without configuration preserve real stage evidence but not empty fields', () => {
  const stages = getFileStages(
    { ...completed, refineSubtitle: 'done', manuscriptMatch: '' },
    type,
    undefined,
  );
  assert.deepEqual(
    stages.map((s) => s.key),
    ['extractAudio', 'extractSubtitle', 'refineSubtitle', 'exportSubtitle'],
  );
});

test('a running or failed summary participates in the project status', () => {
  assert.equal(
    derivePipelineWorkItemStatus([
      { ...completed, summarizeEpisode: 'loading' } as any,
    ]),
    'running',
  );
  assert.equal(
    derivePipelineWorkItemStatus([
      { ...completed, summarizeEpisode: 'error' } as any,
    ]),
    'error',
  );
});

test('completed files do not hide files which have not started', () => {
  assert.equal(
    derivePipelineWorkItemStatus([
      completed as any,
      { uuid: 'waiting', filePath: '/next.mp4' } as any,
    ]),
    'waiting',
  );
});

test('enabled stages remain pending until they have really completed', () => {
  const file = { ...completed, refineSubtitle: '' };
  const stages = getFileStages(file, type, { ...config, aiCorrection: true });
  assert.equal(getFilePercent(file, stages), 75);
  assert.equal(
    isProofreadReady(file, type, { ...config, aiCorrection: true }),
    false,
  );
});

test('reset patches clear inactive per-file stages across a merge boundary', () => {
  const old = {
    ...completed,
    providedSubtitlePath: '/provided.srt',
    refineSubtitle: 'done',
    manuscriptMatch: '',
  };
  const patch = { ...old };
  clearInactiveTaskStages(patch, { ...config, aiCorrection: true });
  const merged = { ...old, ...patch };
  assert.equal(merged.refineSubtitle, undefined);
  assert.equal(merged.manuscriptMatch, undefined);
});
