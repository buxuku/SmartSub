import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-run-review-e2e-'),
);
const media = path.join(root, 'clip.mp4');
const subtitle = path.join(root, 'provided.srt');
const wav = path.join(root, 'voice.wav');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:01,500\nOriginal review text.\n\n',
);
execFileSync(require('ffmpeg-static'), [
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
execFileSync(require('ffmpeg-static'), [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '0.6',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  wav,
]);
const audio = await fs.readFile(wav);
const requests = [];
let releaseSlow;
let slowRequestStarted = false;
const slowAudio = new Promise((resolve) => {
  releaseSlow = resolve;
});
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(payload);
  if (payload.input === 'Hold second file.') {
    slowRequestStarted = true;
    await slowAudio;
  }
  response.writeHead(200, { 'Content-Type': 'audio/wav' });
  response.end(audio);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  const skip = page.getByRole('button', { name: '跳过', exact: true });
  await skip.waitFor();
  await skip.click();
  const invoke = (channel, payload) =>
    page.evaluate(
      ({ channel, payload }) => window.ipc.invoke(channel, payload),
      { channel, payload },
    );
  const initial = await invoke('getUserConfig');
  const providers = await invoke('getTtsProviders');
  await invoke('setTtsProviders', {
    expectedProviders: providers,
    providers: [
      {
        id: 'local-fixture',
        name: 'Local TTS fixture',
        type: 'openaiCompatible',
        apiKey: 'fixture',
        apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'fixture',
        voices: 'alloy',
      },
    ],
  });
  const projectId = 'manual-review';
  const formData = {
    ...initial,
    taskType: 'generateOnly',
    sourceLanguage: 'en',
    translateProvider: '-1',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    subtitleOutputFormats: ['srt'],
    dub: {
      engine: { kind: 'cloud', providerId: 'local-fixture' },
      voice: 'alloy',
      globalSpeed: 1,
      language: 'en',
    },
    gates: { subtitle: 'manual', dubbing: 'manual' },
  };
  const receipt = await invoke('submitTask', {
    projectId,
    requestId: 'manual-review',
    formData,
    files: [
      {
        uuid: 'media',
        filePath: media,
        fileName: 'clip',
        fileExtension: '.mp4',
        directory: root,
        providedSubtitlePath: subtitle,
      },
    ],
  });
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  const get = () => invoke('taskRuns:get', { projectId });
  const wait = async (predicate) => {
    for (let n = 0; n < 600; n++) {
      const run = await get();
      if (predicate(run)) return run;
      if (run?.status === 'failed') throw new Error(JSON.stringify(run));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${JSON.stringify(await get())}`);
  };
  await wait(
    (run) => run?.files[0].stages.subtitleReview.status === 'waiting_review',
  );
  assert.equal(requests.length, 0);
  await page.evaluate(
    (id) => window.next.router.push(`/zh/tasks/generate/?project=${id}`),
    projectId,
  );
  await page.getByRole('button', { name: '校对', exact: true }).first().click();
  await page
    .getByText('Original review text.', { exact: true })
    .first()
    .click();
  await page.locator('textarea').first().fill('Saved before release.');
  await page.getByRole('button', { name: '放行并继续', exact: true }).click();
  const review = await wait(
    (run) => run?.files[0].stages.dubbingReview.status === 'waiting_review',
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, 'Saved before release.');
  assert.equal(review.files[0].stages.dubbingTrack.status, 'pending');
  assert.equal(review.files[0].projection.dubbedAudioPath, undefined);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const sessionPath = path.join(
    userData,
    'dubbing-sessions',
    review.files[0].projection.dubbingSessionId,
    'session.json',
  );
  const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  assert.ok(
    session.subtitlePath.startsWith(
      path.join(userData, 'task-runs') + path.sep,
    ),
    session.subtitlePath,
  );
  assert.ok(
    (await fs.readFile(session.subtitlePath, 'utf8')).includes(
      'Saved before release.',
    ),
  );
  const release = await invoke('pipeline:releaseGate', {
    projectId,
    gate: 'dubbing',
    fileUuids: ['media'],
    expectedRunId: review.runId,
    approvalRevisions: {
      media: review.files[0].stages.dubbingReview.approvalRevision,
    },
  });
  assert.equal(release.success, true, JSON.stringify(release));
  const done = await wait((run) => run?.status === 'succeeded');
  assert.ok(
    (await fs.stat(done.files[0].projection.dubbedAudioPath)).size > 44,
  );
  assert.equal(
    requests.length,
    1,
    'track construction must not synthesize speech again',
  );
  await page.screenshot({ path: path.join(root, 'review-completed.png') });

  // A review gate belongs to its file: another file's paid request must not
  // block saving the ready file, or unlock the task configuration.
  const slowMedia = path.join(root, 'slow.mp4');
  const slowSubtitle = path.join(root, 'slow.srt');
  await fs.copyFile(media, slowMedia);
  await fs.writeFile(
    slowSubtitle,
    '1\n00:00:00,000 --> 00:00:01,500\nHold second file.\n\n',
  );
  const mixedId = 'mixed-review';
  const mixedReceipt = await invoke('submitTask', {
    projectId: mixedId,
    requestId: mixedId,
    formData: { ...formData, maxConcurrentTasks: 2 },
    files: [
      {
        uuid: 'ready',
        filePath: media,
        fileName: 'clip',
        fileExtension: '.mp4',
        directory: root,
        providedSubtitlePath: subtitle,
      },
      {
        uuid: 'slow',
        filePath: slowMedia,
        fileName: 'slow',
        fileExtension: '.mp4',
        directory: root,
        providedSubtitlePath: slowSubtitle,
      },
    ],
  });
  assert.equal(mixedReceipt.success, true, JSON.stringify(mixedReceipt));
  const getMixed = () => invoke('taskRuns:get', { projectId: mixedId });
  await expect
    .poll(async () => (await getMixed())?.status, { timeout: 20000 })
    .toBe('waiting_review');
  const mixed = await getMixed();
  const slowRelease = await invoke('pipeline:releaseGate', {
    projectId: mixedId,
    gate: 'subtitle',
    fileUuids: ['slow'],
    expectedRunId: mixed.runId,
    approvalRevisions: {
      slow: mixed.files[1].stages.subtitleReview.approvalRevision,
    },
  });
  assert.equal(slowRelease.success, true, JSON.stringify(slowRelease));
  await expect
    .poll(async () => slowRequestStarted && (await getMixed())?.status, {
      timeout: 20000,
    })
    .toBe('running');
  const sidecar = mixed.files[0].projection.proofreadDataFile;
  const rows = await invoke('readProofreadDataFile', {
    filePath: sidecar,
    strict: true,
  });
  rows.subtitles[0].sourceContent = 'Saved while another file is running.';
  const saved = await invoke('saveProofreadDataAndRender', {
    proofreadDataFile: sidecar,
    subtitles: rows.subtitles,
    outputs: [],
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const updated = await getMixed();
  assert.equal(updated.status, 'running');
  assert.ok(updated.files[0].projection.manualProofreadRevision);
  assert.equal(updated.files[1].stages.dubbing.status, 'running');
  const busyWrite = await invoke('saveSubtitleFile', {
    filePath: updated.files[1].projection.tempSrtFile,
    subtitles: rows.subtitles,
  });
  assert.ok(
    busyWrite.error?.includes('TASK_RESULT_BUSY'),
    JSON.stringify(busyWrite),
  );
  const artifactWrite = await invoke('saveSubtitleFile', {
    filePath: updated.files[0].projection.providedSubtitlePath,
    subtitles: rows.subtitles,
  });
  assert.ok(
    artifactWrite.error?.includes('TASK_ARTIFACT_READ_ONLY'),
    JSON.stringify(artifactWrite),
  );
  await assert.rejects(
    () =>
      invoke('taskRuns:saveDraft', {
        projectId: mixedId,
        expectedDraftRevision: 0,
        config: formData,
        files: [],
      }),
    /TASK_CONFIG_BUSY/,
  );
  await invoke('taskRuns:command', {
    projectId: mixedId,
    expectedRunId: mixed.runId,
    requestId: 'cancel-mixed',
    command: 'cancel',
  });
  releaseSlow();
  await expect
    .poll(async () => (await getMixed())?.status, { timeout: 20000 })
    .toBe('cancelled');
  console.log(`Task run manual review acceptance passed. Evidence: ${root}`);
} finally {
  releaseSlow();
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
}
