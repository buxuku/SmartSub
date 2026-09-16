import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-gates-e2e-'));
const profile = path.join(output, 'profile');
const media = path.join(output, 'gate.mp4');
const subtitle = path.join(output, 'gate.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
  '-t',
  '2',
  '-vf',
  'scale=320:-2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  media,
]);
const source = '1\n00:00:00,100 --> 00:00:01,800\nPipeline gate test\n';
await fs.writeFile(subtitle, source);
const wav = path.join(output, 'voice.wav');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '1',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  wav,
]);
const audio = await fs.readFile(wav);
const speechRequests = [];
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/speech') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    speechRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(audio);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const tts = {
  id: 'test-tts',
  name: 'Local TTS fixture',
  type: 'openaiCompatible',
  apiKey: 'test-only',
  apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
  model: 'test-voice',
  voices: 'alloy',
};
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${profile}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow, dialog }) => {
  BrowserWindow.getAllWindows().forEach((win) =>
    win.webContents.closeDevTools(),
  );
  dialog.showMessageBoxSync = () => 0;
});
const origin = new URL(page.url()).origin;
const key = 'smartsub_task_wizard_draft_v1';
let locked = false;
async function item(id) {
  return page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
}
async function start(manual, dub = false) {
  const files = await page.evaluate(
    async (paths) =>
      window.ipc.invoke('getDroppedFiles', { files: paths, taskType: 'any' }),
    [media, subtitle],
  );
  assert.equal(files.length, 2);
  await page.evaluate(
    ({ key, files, manual, dub }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          files,
          goals: { translate: false, dub, video: true },
          config: {
            taskType: 'generateOnly',
            translateProvider: '-1',
            aiCorrection: false,
            aiSegmentation: false,
          },
          manualPairs: [
            [
              files.find((file) => file.filePath.endsWith('.mp4')).filePath,
              files.find((file) => file.filePath.endsWith('.srt')).filePath,
            ],
          ],
          pipeline: {
            dubbing: dub
              ? {
                  engineKey: 'cloud:test-tts',
                  voice: 'alloy',
                  language: 'en',
                  globalSpeed: 1,
                }
              : {},
            subtitle: 'hard',
            styleId: 'classic',
            quality: 'original',
            encoder: 'cpu',
            subtitleGate: manual,
            dubbingGate: manual && dub,
            recipeName: null,
          },
          savedAt: Date.now(),
        }),
      ),
    { key, files, manual, dub },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  if (dub && manual) {
    await expect(
      page.getByRole('button', { name: '开始', exact: true }),
    ).toBeEnabled();
    await setTts([]);
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(
      page.getByText('所选配音引擎不存在或配置不完整。', { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/tasks\/new/);
    assert.equal(speechRequests.length, 0);
    await setTts([tts]);
  }
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/project=/);
  return new URL(page.url()).searchParams.get('project');
}
async function setTts(providers) {
  await page.evaluate(
    (providers) => window.ipc.send('setTtsProviders', providers),
    providers,
  );
  await expect
    .poll(() => page.evaluate(() => window.ipc.invoke('getTtsProviders')))
    .toEqual(providers);
}
async function finished(id) {
  await expect
    .poll(async () => (await item(id))?.pipelineFiles[0].composeVideo, {
      timeout: 60000,
    })
    .toBe('done');
  const file = (await item(id)).pipelineFiles[0];
  assert.ok((await fs.stat(file.finalVideoPath)).size > 1000);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file.finalVideoPath,
    '-t',
    '1',
    '-f',
    'null',
    '-',
  ]);
  return file;
}
try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const manual = await start(true);
  await expect
    .poll(async () => (await item(manual))?.pipelineFiles[0].subtitleGate)
    .toBe('review');
  await expect(
    page.getByRole('button', { name: '放行', exact: true }),
  ).toBeVisible();
  assert.equal((await item(manual)).pipelineFiles[0].finalVideoPath, undefined);
  assert.equal((await item(manual)).status, 'review');
  await fs.chmod(profile, 0o500);
  locked = true;
  await page.getByRole('button', { name: '放行', exact: true }).click();
  await expect(
    page.getByText('TASK_GATE_SUBMISSION_FAILED', { exact: true }),
  ).toBeVisible();
  assert.equal((await item(manual)).pipelineFiles[0].subtitleGate, 'review');
  assert.equal((await item(manual)).pipelineFiles[0].finalVideoPath, undefined);
  await page.screenshot({
    path: path.join(output, 'release-failure-retains-review.png'),
  });
  await fs.chmod(profile, 0o700);
  locked = false;
  await page.getByRole('button', { name: '放行', exact: true }).click();
  const manualFile = await finished(manual);
  assert.equal(manualFile.subtitleGate, 'passed');
  const automatic = await start(false);
  const autoFile = await finished(automatic);
  assert.notEqual(autoFile.subtitleGate, 'review');
  assert.notEqual(autoFile.finalVideoPath, manualFile.finalVideoPath);
  await setTts([tts]);
  const manualDub = await start(true, true);
  await expect
    .poll(async () => (await item(manualDub))?.pipelineFiles[0].subtitleGate)
    .toBe('review');
  assert.equal(speechRequests.length, 0);
  await page.getByRole('button', { name: '放行', exact: true }).click();
  await expect
    .poll(async () => (await item(manualDub))?.pipelineFiles[0].dubbingGate, {
      timeout: 60000,
    })
    .toBe('review');
  assert.equal(speechRequests.length, 1);
  assert.equal(
    (await item(manualDub)).pipelineFiles[0].finalVideoPath,
    undefined,
  );
  await page.getByRole('button', { name: '放行', exact: true }).click();
  const manualDubFile = await finished(manualDub);
  assert.equal(manualDubFile.dubbingGate, 'passed');
  assert.equal(
    speechRequests.length,
    1,
    'dubbing gate release reuses completed speech',
  );
  const autoDub = await start(false, true);
  await finished(autoDub);
  assert.equal(speechRequests.length, 2);
  assert.ok(
    speechRequests.every(
      (request) =>
        request.voice === 'alloy' &&
        request.input.includes('Pipeline gate test'),
    ),
  );
  assert.equal(await fs.readFile(subtitle, 'utf8'), source);
  await page.screenshot({ path: path.join(output, 'automatic-complete.png') });
  console.log(
    JSON.stringify({
      success: true,
      output,
      checks: [
        'manual gate stops before compose',
        'disk failure preserves review and permits retry',
        'release resumes real hard-subtitle FFmpeg compose',
        'automatic flow finishes without gate',
        'fresh TTS dependency removal blocks start',
        'subtitle and dubbing manual gates run and resume in sequence',
        'automatic dubbing and compose through local speech fixture',
        'distinct nonempty decodable outputs',
        'source subtitle unchanged',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('Pipeline gate E2E evidence:', output);
  throw error;
} finally {
  if (locked) await fs.chmod(profile, 0o700);
  await app.close();
  await new Promise((resolve) => server.close(resolve));
}
