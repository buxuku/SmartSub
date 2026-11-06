import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRunFiles } from '../../types/taskRun';
import {
  editableRunState,
  mergeDraftFiles,
  taskDraftInput,
} from '../../renderer/lib/taskRunDraft';

const run: any = {
  runId: 'current',
  revision: 1,
  config: { targetLanguage: 'zh' },
  files: [
    {
      fileId: 'f',
      input: {
        uuid: 'f',
        filePath: '/a.mp4',
        providedSubtitlePath: '/source.srt',
      },
      projection: {
        uuid: 'f',
        filePath: '/a.mp4',
        providedSubtitlePath: '/snapshot/source.srt',
        translatedSrtFile: '/result.srt',
      },
      stages: {},
    },
  ],
};

test('terminal settings restore only a matching draft while retaining the actual result', () => {
  const draft: any = {
    revision: 2,
    basedOnRunId: 'current',
    config: { targetLanguage: 'ja' },
    files: [taskDraftInput(run.files[0].projection, run)],
  };
  const state = editableRunState(run, draft);
  assert.equal(state.config.targetLanguage, 'ja');
  assert.equal(state.files[0].translatedSrtFile, '/result.srt');
  assert.equal(state.files[0].providedSubtitlePath, '/source.srt');
  assert.equal(run.config.targetLanguage, 'zh');
  assert.equal(
    editableRunState({ ...run, runId: 'next' }, draft).config.targetLanguage,
    'zh',
  );
});

test('background result updates preserve draft additions, removals and input choices', () => {
  const draft: any = [
    { uuid: 'f', filePath: '/a.mp4', manuscriptPath: '/new.txt' },
    { uuid: 'new', filePath: '/new.mp4' },
  ];
  const results: any = [
    {
      ...run.files[0].projection,
      manuscriptPath: '/old.txt',
      translatedSrtFile: '/repaired.srt',
    },
    { uuid: 'removed', filePath: '/removed.mp4' },
  ];
  const merged = mergeDraftFiles(draft, results);
  assert.deepEqual(
    merged.map((file) => file.uuid),
    ['f', 'new'],
  );
  assert.equal(merged[0].manuscriptPath, '/new.txt');
  assert.equal(merged[0].translatedSrtFile, '/repaired.srt');
  assert.equal(taskDraftInput(merged[0]).translatedSrtFile, undefined);
});

test('cancelled review tasks project an editable result without live review gates', () => {
  const waiting: any = {
    ...run,
    status: 'waiting_review',
    files: [
      {
        ...run.files[0],
        projection: { ...run.files[0].projection, subtitleGate: 'review' },
        stages: {
          subtitleReview: { id: 'subtitleReview', status: 'waiting_review' },
          dubbing: { id: 'dubbing', status: 'pending' },
        },
      },
    ],
  };
  assert.equal(projectRunFiles(waiting)[0].subtitleGate, 'review');
  const projected = projectRunFiles({ ...waiting, status: 'cancelled' })[0];
  assert.notEqual(projected.subtitleGate, 'review');
  assert.equal(projected.taskActivity?.status, 'cancelled');
  assert.equal(waiting.files[0].projection.subtitleGate, 'review');
});
