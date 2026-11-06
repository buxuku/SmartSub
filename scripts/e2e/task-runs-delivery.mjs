import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron } from '@playwright/test';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-run-delivery-'));
const media = path.join(root, 'clip.mp4');
const subtitle = path.join(root, 'provided.srt');
const chinese = '你好，世界！这是一段较长的字幕，用于验证原文排版与视频合成。';
await fs.writeFile(
  subtitle,
  `1\n00:00:00,000 --> 00:00:01,000\n${chinese}\n\n`,
);
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=160x90:r=10:d=2',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=16000:cl=mono',
  '-t',
  '2',
  '-c:v',
  'mpeg4',
  '-c:a',
  'aac',
  media,
]);
const embedded = path.join(root, 'embedded.mkv');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  media,
  '-i',
  subtitle,
  '-map',
  '0:v',
  '-map',
  '0:a',
  '-map',
  '1:s',
  '-c',
  'copy',
  embedded,
]);
let requests = 0;
const server = http.createServer((_req, res) => {
  requests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: 'Translated delivery.' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push({ label, error: String(error) });
    console.error(`FAIL ${label}: ${error}`);
  }
}
try {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const invoke = (channel, payload) =>
    page.evaluate(
      ({ channel, payload }) => window.ipc.invoke(channel, payload),
      { channel, payload },
    );
  await invoke('setTranslationProviders', {
    expectedProviders: await invoke('getTranslationProviders'),
    providers: [
      {
        id: 'controlled',
        type: 'deeplx',
        name: 'Controlled',
        isAi: false,
        apiUrl: `http://127.0.0.1:${server.address().port}/translate`,
      },
    ],
  });
  const config = {
    ...(await invoke('getUserConfig')),
    taskType: 'generateAndTranslate',
    translateProvider: 'controlled',
    sourceLanguage: 'zh-CN',
    targetLanguage: 'en',
    translateContent: 'onlyTranslate',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    useEmbeddedSubtitles: true,
    subtitleLayout: 'original',
    subtitleOutputFormats: ['srt'],
    translateRetryTimes: '0',
    sourceSrtSaveOption: 'fileNameWithLang',
    targetSrtSaveOption: 'custom',
    customTargetSrtFileName:
      '${fileName}.${translateProvider}.${targetLanguage}',
    removeChinesePunctuation: false,
    compose: { subtitle: 'soft' },
    gates: { subtitle: 'manual' },
  };
  const file = {
    uuid: 'media',
    filePath: media,
    fileName: 'clip',
    fileExtension: '.mp4',
    providedSubtitlePath: subtitle,
    directory: root,
  };
  const waitRun = async (projectId, status) => {
    for (let i = 0; i < 800; i++) {
      const run = await invoke('taskRuns:get', { projectId });
      if (run?.status === 'failed') throw new Error(JSON.stringify(run));
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${projectId}: ${status}`);
  };
  const submit = async (projectId, requestId, files, formData, name) => {
    const receipt = await invoke('submitTask', {
      projectId,
      requestId,
      files,
      formData,
      name,
    });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    return receipt;
  };
  const save = async (run, text) => {
    const projection = run.files[0].projection;
    const data = JSON.parse(
      await fs.readFile(projection.proofreadDataFile, 'utf8'),
    );
    // These are the same output paths passed by the task page's ProofreadEditor.
    const saved = await invoke('saveProofreadDataAndRender', {
      proofreadDataFile: projection.proofreadDataFile,
      subtitles: [
        {
          id: data.cues[0].id,
          startEndTime: '00:00:00,000 --> 00:00:01,000',
          sourceContent: chinese,
          targetContent: text,
        },
      ],
      outputs: [
        { filePath: projection.tempSrtFile, contentType: 'source' },
        {
          filePath: projection.tempTranslatedSrtFile,
          contentType: 'onlyTranslate',
        },
        {
          filePath: projection.translatedSrtFile,
          contentType: 'onlyTranslate',
        },
      ],
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(
      projection.translatedSrtFile,
      projection.translatedSubtitleFiles[0],
    );
    assert.match(
      await fs.readFile(projection.translatedSrtFile, 'utf8'),
      new RegExp(text),
    );
  };
  await submit(
    'translated',
    'first',
    [file],
    config,
    '  Submitted recipe title  ',
  );
  const one = await waitRun('translated', 'waiting_review');
  await check('submitted task name survives managed acceptance', async () => {
    assert.equal(
      (await invoke('getWorkItem', 'translated')).name,
      'Submitted recipe title',
    );
  });
  await check('provider name is expanded in delivery filename', async () => {
    assert.equal(
      path.basename(one.files[0].projection.translatedSubtitleFiles[0]),
      'clip.Controlled.en.srt',
    );
  });
  const artifact = one.files[0].stages.exportSubtitle.artifacts.find((entry) =>
    /\.srt$/i.test(entry.path),
  );
  const originalArtifact = await fs.readFile(artifact.path, 'utf8');
  await check(
    'translated proofreading can save before releasing a review gate',
    () => save(one, 'Saved at review.'),
  );
  await check(
    'automatic artifacts remain unchanged and read-only',
    async () => {
      assert.equal(await fs.readFile(artifact.path, 'utf8'), originalArtifact);
      const denied = await invoke('saveSubtitleFile', {
        filePath: artifact.path,
        subtitles: [],
        contentType: 'source',
      });
      assert.match(denied.error, /TASK_ARTIFACT_READ_ONLY/);
    },
  );
  await invoke('pipeline:releaseGate', {
    projectId: 'translated',
    gate: 'subtitle',
    expectedRunId: one.runId,
    approvalRevisions: {
      media: one.files[0].stages.subtitleReview.approvalRevision,
    },
  });
  await waitRun('translated', 'succeeded');
  await submit(
    'translated',
    'second',
    [file],
    { ...config, gates: {} },
    'Do not rename an existing task',
  );
  const two = await waitRun('translated', 'succeeded');
  await check(
    'cached export is editable without mutating the previous delivery',
    async () => {
      assert.equal(two.files[0].stages.exportSubtitle.outcome, 'reused');
      assert.equal(requests, 1);
      const previous = await fs.readFile(
        one.files[0].projection.translatedSubtitleFiles[0],
        'utf8',
      );
      await save(two, 'Saved after reuse.');
      assert.equal(
        await fs.readFile(
          one.files[0].projection.translatedSubtitleFiles[0],
          'utf8',
        ),
        previous,
      );
      assert.equal(
        (await invoke('getWorkItem', 'translated')).name,
        'Submitted recipe title',
      );
    },
  );
  const sourceConfig = {
    ...config,
    taskType: 'generateOnly',
    translateProvider: '-1',
    subtitleLayout: 'two-line',
    subtitleLineWidth: 12,
    removeChinesePunctuation: true,
    subtitleOutputFormats: ['txt'],
    gates: {},
  };
  const sourceFile = {
    ...file,
    filePath: embedded,
    fileName: 'embedded',
    fileExtension: '.mkv',
    providedSubtitlePath: undefined,
  };
  const sourceRuns = [];
  for (const requestId of ['source-first', 'source-reused']) {
    await submit('source', requestId, [sourceFile], sourceConfig);
    const sourceRun = await waitRun('source', 'succeeded');
    sourceRuns.push(sourceRun);
    await check(
      `${requestId}: composition uses formatted, timed source even with TXT export`,
      async () => {
        const projection = sourceRun.files[0].projection;
        const composed = execFileSync(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            projection.finalVideoPath,
            '-map',
            '0:s:0',
            '-f',
            'srt',
            '-',
          ],
          { encoding: 'utf8' },
        );
        assert.doesNotMatch(composed, /[，！。]/u);
        const text = composed
          .replace(/\r\n/g, '\n')
          .trim()
          .split('\n')
          .slice(2)
          .join('\n');
        assert.ok(
          text.includes('\n'),
          'composed source must retain requested line breaks',
        );
        assert.equal(
          (await fs.readFile(projection.sourceSubtitleFiles[0], 'utf8')).trim(),
          text,
        );
        assert.equal(projection.srtFile, projection.sourceSubtitleFiles[0]);
        assert.match(
          await fs.readFile(
            sourceRun.files[0].stages.normalizeSubtitle.artifacts.find(
              (entry) => /\.srt$/i.test(entry.path),
            ).path,
            'utf8',
          ),
          /，/u,
          'canonical source must remain unformatted',
        );
      },
    );
  }
  assert.equal(sourceRuns[1].files[0].stages.exportSubtitle.outcome, 'reused');
  assert.equal(sourceRuns[1].files[0].stages.composeVideo.outcome, 'reused');
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ failures }, null, 2),
  );
  console.log(`Task run delivery evidence: ${root}`);
  assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
}
