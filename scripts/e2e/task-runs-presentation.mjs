import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const workspace = process.cwd();
const require = createRequire(path.join(workspace, 'package.json'));
const { _electron } = require('@playwright/test');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-review-'));
const subtitle = path.join(root, 'source.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:02,000\nHello world.\n\n',
);
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      data: '你好，世界！这是一段较长的字幕，用于校对保存测试。',
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await _electron.launch({
    cwd: workspace,
    args: [workspace, `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  const invoke = (channel, payload) =>
    page.evaluate(
      ({ channel, payload }) => window.ipc.invoke(channel, payload),
      { channel, payload },
    );
  const oldProviders = await invoke('getTranslationProviders');
  const provider = {
    id: 'controlled',
    type: 'deeplx',
    name: 'Controlled',
    isAi: false,
    apiUrl: `http://127.0.0.1:${server.address().port}/translate`,
  };
  await invoke('setTranslationProviders', {
    expectedProviders: oldProviders,
    providers: [provider],
  });
  const initial = await invoke('getUserConfig');
  const file = {
    uuid: 'f',
    filePath: subtitle,
    fileName: 'source',
    fileExtension: '.srt',
    directory: root,
  };
  const config = {
    ...initial,
    taskType: 'translateOnly',
    translateProvider: 'controlled',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    translateContent: 'onlyTranslate',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    subtitleLayout: 'original',
    subtitleLineWidth: 36,
    subtitleOutputFormats: ['srt'],
    translateRetryTimes: '0',
    removeChinesePunctuation: false,
  };
  const run = async (requestId, changes) => {
    const receipt = await invoke('submitTask', {
      projectId: 'review',
      requestId,
      files: [file],
      formData: { ...config, ...changes },
    });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    for (let i = 0; i < 400; i++) {
      const current = await invoke('taskRuns:get', { projectId: 'review' });
      if (
        current?.runId === receipt.runId &&
        ['succeeded', 'failed'].includes(current.status)
      ) {
        assert.equal(current.status, 'succeeded', JSON.stringify(current));
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Run timed out');
  };
  const one = await run('one', {});
  const two = await run('two', {
    subtitleLayout: 'two-line',
    subtitleLineWidth: 12,
  });
  assert.notEqual(
    two.files[0].projection.translatedSubtitleFiles[0],
    one.files[0].projection.translatedSubtitleFiles[0],
    'deliveries must never overwrite previous outputs',
  );
  const secondSidecar = JSON.parse(
    await fs.readFile(two.files[0].projection.proofreadDataFile, 'utf8'),
  );
  const result = {
    root,
    firstRun: one.runId,
    layoutOnly: {
      requests,
      proofreadingOutcome: two.files[0].stages.prepareProofread.outcome,
      requestedLayout: two.config.subtitleLayout,
      sidecarLayout: secondSidecar.meta.subtitleLayout,
      requestedWidth: two.config.subtitleLineWidth,
      sidecarWidth: secondSidecar.meta.subtitleLineWidth,
    },
  };
  const three = await run('three', {
    translateContent: 'sourceAndTranslate',
    removeChinesePunctuation: true,
  });
  const projection = three.files[0].projection;
  result.presentationOnly = {
    requests,
    translationOutcome: three.files[0].stages.translateSubtitle.outcome,
  };
  const delivery = projection.translatedSubtitleFiles[0];
  const beforeSave = await fs.readFile(delivery, 'utf8');
  const data = JSON.parse(
    await fs.readFile(projection.proofreadDataFile, 'utf8'),
  );
  const time = (ms) => {
    const n = Math.round(ms);
    return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')},${String(n % 1000).padStart(3, '0')}`;
  };
  const rows = data.cues.map((cue) => ({
    id: cue.id,
    startEndTime: `${time(cue.startMs)} --> ${time(cue.endMs)}`,
    sourceContent: cue.source,
    targetContent: `${cue.target}改`,
  }));
  const saved = await invoke('saveProofreadDataAndRender', {
    proofreadDataFile: projection.proofreadDataFile,
    subtitles: rows,
    outputs: [
      {
        filePath: projection.tempTranslatedSrtFile,
        contentType: 'onlyTranslate',
      },
    ],
  });
  const afterSave = await fs.readFile(delivery, 'utf8');
  result.proofreadSave = {
    saved,
    punctuationBefore: /[，！。]/u.test(beforeSave),
    punctuationAfter: /[，！。]/u.test(afterSave),
    beforeSave,
    afterSave,
  };
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(`Task run presentation acceptance evidence: ${root}`);
  {
    assert.equal(result.layoutOnly.sidecarLayout, 'two-line');
    assert.equal(result.layoutOnly.sidecarWidth, 12);
    assert.equal(result.presentationOnly.requests, 1);
    assert.equal(result.presentationOnly.translationOutcome, 'reused');
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(result.proofreadSave.punctuationBefore, false);
    assert.equal(result.proofreadSave.punctuationAfter, false);
  }
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
}
