import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
const require = createRequire(import.meta.url);
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-task-storage-')),
);
const profile = path.join(root, 'profile');
const data = path.join(root, 'data');
const temporary = path.join(root, 'scratch');
const media = path.join(root, 'voice.wav');
execFileSync(require('ffmpeg-static'), [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=16000',
  '-t',
  '2',
  '-ac',
  '1',
  media,
]);
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) {
    /* consume upload */
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      text: 'Hello world.',
      duration: 2,
      segments: [{ id: 0, start: 0, end: 1.8, text: 'Hello world.' }],
      words: [
        { start: 0, end: 0.8, word: 'Hello' },
        { start: 0.9, end: 1.8, word: 'world.' },
      ],
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page;
const invoke = (channel, payload) =>
  page.evaluate(({ channel, payload }) => window.ipc.invoke(channel, payload), {
    channel,
    payload,
  });
async function launch() {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  await expect
    .poll(
      async () => {
        for (const candidate of app.windows()) {
          try {
            if (await candidate.evaluate(() => Boolean(window.ipc?.invoke))) {
              page = candidate;
              return true;
            }
          } catch {}
        }
        return false;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  page.setDefaultTimeout(20000);
}
async function files(directory) {
  const result = [];
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      result.push(...(entry.isDirectory() ? await files(file) : [file]));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return result;
}
try {
  await launch();
  const skip = page.getByRole('button', { name: /跳过|Skip/, exact: true });
  await skip.waitFor();
  await skip.click();
  const providers = await invoke('getAsrProviders');
  await invoke('setAsrProviders', {
    expectedProviders: providers,
    providers: [
      {
        id: 'fixture',
        name: 'Fixture',
        type: 'openaiCompatible',
        apiKey: 'test',
        apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
        models: 'whisper-1',
      },
    ],
  });
  const formData = {
    ...(await invoke('getUserConfig')),
    taskType: 'generateOnly',
    transcriptionEngine: 'cloud',
    asrProviderId: 'fixture',
    model: 'whisper-1',
    sourceLanguage: 'en',
    translateProvider: '-1',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    subtitleOutputFormats: ['srt'],
    sourceSrtSaveOption: 'fileName',
  };
  const file = {
    uuid: 'voice',
    filePath: media,
    fileName: 'voice',
    fileExtension: '.wav',
    directory: root,
  };
  async function submit(projectId, requestId) {
    const result = await invoke('submitTask', {
      projectId,
      requestId,
      files: [file],
      formData,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    let run;
    await expect
      .poll(
        async () => {
          run = await invoke('taskRuns:get', { projectId });
          return ['succeeded', 'failed'].includes(run?.status);
        },
        { timeout: 30000 },
      )
      .toBe(true);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    return run;
  }
  const legacy = await submit('legacy', 'one');
  const oldAudio = legacy.files[0].projection.tempAudioFile;
  assert.ok(oldAudio.startsWith(profile));
  await invoke('setSettings', {
    storageRoot: data,
    useCustomTempDir: true,
    customTempDir: temporary,
  });
  const fresh = await submit('fresh', 'one');
  assert.ok(fresh.files[0].projection.tempAudioFile.startsWith(data));
  assert.equal(
    (await files(path.join(data, 'task-runs'))).filter((file) =>
      file.endsWith('.wav'),
    ).length,
    1,
  );
  await expect
    .poll(async () => (await files(path.join(temporary, 'task-runs'))).length)
    .toBe(0);
  const subtitleArtifacts = fresh.files[0].stages.extractSubtitle.artifacts;
  assert.equal(
    subtitleArtifacts.some((file) => file.path.endsWith('.wav')),
    false,
  );
  assert.ok(
    fresh.files[0].projection.wordTimelineFile.includes('extractSubtitle-'),
  );
  const preview = await invoke('taskStorage:previewMigration');
  assert.deepEqual(preview.blockers, []);
  assert.ok(preview.files > 0);
  await page.evaluate(async () => window.next.router.push('/zh/settings'));
  await page
    .getByRole('button', {
      name: /Move existing task data|\u8fc1\u79fb\u65e7\u4efb\u52a1\u6570\u636e/,
      exact: true,
    })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('button', {
      name: /Schedule migration|\u5b89\u6392\u8fc1\u79fb/,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await invoke('taskStorage:status')).migration?.phase)
    .toBe('scheduled');
  await app.close();
  app = undefined;
  await launch();
  assert.equal((await invoke('taskStorage:status')).migration.phase, 'done');
  const moved = await invoke('taskRuns:get', { projectId: 'legacy' });
  assert.ok(moved.files[0].projection.tempAudioFile.startsWith(data));
  await assert.rejects(fs.access(oldAudio));
  const proofread = moved.files[0].projection.proofreadDataFile;
  const rows = await invoke('readProofreadDataFile', {
    filePath: proofread,
    strict: true,
  });
  rows.subtitles[0].sourceContent = 'Saved after migration.';
  const saved = await invoke('saveProofreadDataAndRender', {
    proofreadDataFile: proofread,
    subtitles: rows.subtitles,
    outputs: [],
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  await page.evaluate(async () => window.next.router.push('/zh/settings'));
  await expect(
    page.getByRole('button', { name: '迁移旧任务数据', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: /Move existing task data|\u8fc1\u79fb\u65e7\u4efb\u52a1\u6570\u636e/,
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'task-storage-settings.png') });
  await invoke('deleteWorkItem', 'fresh');
  await expect
    .poll(async () => {
      const clean = await invoke('taskStorage:cleanup');
      assert.deepEqual(clean.errors, []);
      return (await files(path.join(data, 'task-runs'))).filter((file) =>
        file.endsWith('.wav'),
      ).length;
    })
    .toBe(1);
  await fs.access(media);
  console.log(
    JSON.stringify({
      passed: true,
      root,
      migratedAudio: moved.files[0].projection.tempAudioFile,
    }),
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
}
