import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-presets-e2e-'),
);
const media = path.join(output, 'pauses.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
  '-t',
  '3',
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
let requests = 0;
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/transcriptions')
    return response.writeHead(404).end();
  request.resume();
  request.on('end', () => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        text: 'First I agree',
        language: 'en',
        duration: 3,
        segments: [{ start: 0, end: 1.5, text: 'First I agree' }],
        words: [
          { start: 0, end: 0.2, word: 'First' },
          { start: 0.6, end: 0.8, word: 'I' },
          { start: 1.2, end: 1.5, word: 'agree' },
        ],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  const origin = new URL(page.url()).origin;
  const key = 'smartsub_task_wizard_draft_v1';
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const globalBefore = await page.evaluate(() =>
    window.ipc.invoke('getSettings'),
  );
  await page.evaluate(
    async ({ media, key }) => {
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      });
      const defaults = await window.ipc.invoke('getUserConfig');
      localStorage.setItem(
        key,
        JSON.stringify({
          files,
          goals: { translate: false, dub: false, video: false },
          config: {
            ...defaults,
            transcriptionEngine: 'builtin',
            model: 'base',
            translateProvider: '-1',
            sourceLanguage: 'en',
            useEmbeddedSubtitles: false,
          },
          savedAt: Date.now(),
        }),
      );
    },
    { media, key },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: /^(通用均衡|专家自定义)$/ }).click();
  await page.getByRole('button', { name: /^会议访谈 \/ 播客/ }).click();
  const draftConfig = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key)).config, key);
  await expect
    .poll(async () => (await draftConfig()).scenarioPreset)
    .toBe('interview');
  const selected = await draftConfig();
  assert.equal(selected.subtitleMaxDuration, 3);
  assert.equal(selected.subtitleMaxGap, 0.25);
  assert.equal(selected.preserveSpeechPauses, true);
  assert.equal(selected.vadThreshold, 0.35);
  assert.equal(selected.speakerDiarization, true);

  await page
    .getByRole('button', { name: '会议访谈 / 播客', exact: true })
    .click();
  await page.getByRole('button', { name: /^专家自定义/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const vad = page.getByRole('slider', { name: 'VAD 语音阈值', exact: true });
  await expect(vad).toHaveAttribute('aria-valuenow', '0.35');
  await vad.focus();
  await page.keyboard.press('ArrowRight');
  await expect(vad).toHaveAttribute('aria-valuenow', '0.36');
  await expect.poll(async () => (await draftConfig()).vadThreshold).toBe(0.36);
  const expert = await draftConfig();
  assert.equal(expert.subtitleOutcome, 'custom');
  assert.equal(expert.maxContext, 0);
  assert.equal(expert.reduceRepetition, true);
  assert.equal(expert.preserveSpeechPauses, true);
  for (const width of [1024, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          width,
          width === 1024 ? 700 : 900,
        ),
      width,
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await vad.scrollIntoViewIfNeeded();
    await expect(vad).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, `expert-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '专家参数', exact: true }).click();
  await expect(vad).toHaveAttribute('aria-valuenow', '0.36');
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getSettings')),
    globalBefore,
    'expert edits stay task-local',
  );

  // Keep the actual task values, switch only the ASR transport to a local fixture.
  const provider = {
    id: 'scenario-asr',
    name: 'Scenario ASR',
    type: 'openaiCompatible',
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'test-only',
    models: ['whisper-1'],
  };
  await page.evaluate(
    async ({ key, provider }) => {
      window.ipc.send('setAsrProviders', [provider]);
      const draft = JSON.parse(localStorage.getItem(key));
      draft.config = {
        ...draft.config,
        transcriptionEngine: 'cloud',
        asrProviderId: provider.id,
        model: 'whisper-1',
        sourceSrtSaveOption: 'fileName',
        aiCorrection: false,
        aiSegmentation: false,
        speakerDiarization: false,
      };
      localStorage.setItem(key, JSON.stringify(draft));
    },
    { key, provider },
  );
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(() => requests, { timeout: 60000 }).toBe(1);
  await expect
    .poll(
      async () => {
        const items = await page.evaluate(() =>
          window.ipc.invoke('getWorkItems'),
        );
        return items.find((item) => item.type === 'generateOnly')
          ?.pipelineFiles?.[0]?.exportSubtitle;
      },
      { timeout: 60000 },
    )
    .toBe('done');
  const items = await page.evaluate(() => window.ipc.invoke('getWorkItems'));
  const task = items.find((item) => item.pipelineFiles?.length);
  assert.ok(task?.pipelineFiles[0].srtFile);
  const srt = await fs.readFile(task.pipelineFiles[0].srtFile, 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:00,200\s+First/);
  assert.match(srt, /00:00:00,600 --> 00:00:00,800\s+I/);
  assert.match(srt, /00:00:01,200 --> 00:00:01,500\s+agree/);
  await page.screenshot({ path: path.join(output, 'completed.png') });
  console.log(
    JSON.stringify({
      output,
      requests,
      subtitle: task.pipelineFiles[0].srtFile,
      checks: [
        'preset application',
        'expert materialization',
        'keyboard VAD tuning',
        '1024/1440 layout',
        'refresh recovery',
        'global isolation',
        'real local ASR pipeline',
        'pause-preserving SRT',
      ],
    }),
  );
} catch (error) {
  console.error(`Scenario evidence: ${output}`);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
