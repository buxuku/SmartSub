/** Real pipeline + local HTTP fixtures. No user models, credentials or paid calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-activity-e2e-'),
);
const media = path.join(output, 'speech.wav');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=16000',
  '-t',
  '5',
  '-ac',
  '1',
  media,
]);
let releaseAsr;
const pending = [];
const translations = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const reply = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/v1/audio/transcriptions') {
      releaseAsr = () =>
        reply({
          text: 'Hello there. Nice day.',
          duration: 5,
          segments: [
            { start: 0, end: 1, text: 'Hello there.' },
            { start: 3, end: 4, text: 'Nice day.' },
          ],
        });
    } else if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = payload.messages.at(-1).content;
      const translating = prompt.trim().startsWith('{');
      let content = prompt.split('\n')[1];
      if (translating) {
        const input = JSON.parse(prompt);
        content = JSON.stringify(
          Object.fromEntries(
            Object.entries(input).map(([id, src]) => [
              id,
              { src, tr: src.includes('Hello') ? '你好。' : '天气不错。' },
            ]),
          ),
        );
      }
      (translating ? translations : pending).push(() =>
        reply({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content },
            },
          ],
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
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
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const projectId = 'activity-fixture';
  const accepted = await page.evaluate(
    async ({ apiUrl, media, projectId }) => {
      for (const [read, write, provider] of [
        [
          'getAsrProviders',
          'setAsrProviders',
          {
            id: 'asr-fixture',
            type: 'openaiCompatible',
            name: 'Local ASR fixture',
            apiUrl,
            apiKey: 'fixture',
            models: 'whisper-1',
          },
        ],
        [
          'getTranslationProviders',
          'setTranslationProviders',
          {
            id: 'ai-fixture',
            type: 'openai',
            name: 'Local AI fixture',
            apiUrl,
            apiKey: 'fixture',
            modelName: 'fixture',
            isAi: true,
            batchConcurrency: '2',
            batchSize: '1',
            requestInterval: '0',
            structuredOutput: 'disabled',
          },
        ],
      ]) {
        const expectedProviders = await window.ipc.invoke(read);
        await window.ipc.invoke(write, {
          expectedProviders,
          providers: [...expectedProviders, provider],
        });
      }
      const defaults = await window.ipc.invoke('getUserConfig');
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'any',
      });
      return window.ipc.invoke('submitTask', {
        requestId: 'activity-fixture-run',
        projectId,
        files,
        formData: {
          ...defaults,
          taskType: 'generateAndTranslate',
          transcriptionEngine: 'cloud',
          asrProviderId: 'asr-fixture',
          model: 'whisper-1',
          sourceLanguage: 'en',
          translateProvider: 'ai-fixture',
          targetLanguage: 'zh',
          aiSegmentation: true,
          aiCorrection: false,
          refineProvider: 'ai-fixture',
          preserveSpeechPauses: true,
          subtitleOutputFormat: 'srt',
          subtitleOutputFormats: ['srt'],
          sourceSrtSaveOption: 'fileName',
          useEmbeddedSubtitles: false,
          speakerDiarization: false,
          manuscriptPath: '',
          dub: undefined,
          compose: undefined,
        },
      });
    },
    { apiUrl, media, projectId },
  );
  assert.equal(accepted.success, true, JSON.stringify(accepted));
  const openTask = (locale = 'zh') =>
    page.evaluate(
      ({ projectId, locale }) =>
        window.next.router.push(
          `/${locale}/tasks/generate-translate/?project=${projectId}`,
        ),
      { projectId, locale },
    );
  const item = () =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), projectId);
  await openTask();
  await expect.poll(() => Boolean(releaseAsr)).toBe(true);
  await expect(page.getByTestId('task-activity')).toContainText(
    '等待服务或命令返回',
  );
  const rowHeight = async () =>
    (await page.getByTestId('task-activity').locator('..').boundingBox())
      .height;
  const listeningHeight = await rowHeight();
  releaseAsr();
  await expect.poll(() => pending.length).toBe(2);
  await expect(page.getByTestId('task-activity')).toContainText(
    '已处理 0/2 批',
  );
  await expect(page.getByTestId('task-activity')).toContainText('2 批处理中');
  assert.equal(
    await rowHeight(),
    listeningHeight,
    'ASR to refinement keeps row height',
  );
  const startedAt = (await item()).pipelineFiles[0].taskActivity.startedAt;
  await page.evaluate(() => window.next.router.push('/zh/recent-tasks/'));
  await openTask();
  await expect(page.getByTestId('task-activity')).toContainText(
    '已处理 0/2 批',
  );
  assert.equal(
    (await item()).pipelineFiles[0].taskActivity.startedAt,
    startedAt,
  );
  await page.getByRole('button', { name: '查看处理详情', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/第 1 批 ·/)).toBeVisible();
  assert.equal(
    await rowHeight(),
    listeningHeight,
    'popover does not expand the row',
  );
  await page.screenshot({
    animations: 'disabled',
    path: path.join(output, 'list-waiting.png'),
  });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await expect(page.getByTestId('task-activity')).toContainText('2 批处理中');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 720),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    animations: 'disabled',
    path: path.join(output, 'grid-1024.png'),
  });
  pending[1]();
  await expect(page.getByTestId('task-activity')).toContainText(
    '已处理 1/2 批',
  );
  await openTask('en');
  await page.reload();
  await expect(page.getByTestId('task-activity')).toContainText(
    'Processed 1/2 batches',
  );
  const gridHeight = await rowHeight();
  pending[0]();
  await expect
    .poll(async () => (await item()).pipelineFiles[0].refineSubtitle)
    .toBe('done');
  await expect.poll(() => translations.length).toBe(2);
  await expect(page.getByTestId('task-activity')).toContainText(
    'Received 0/2 batches',
  );
  assert.equal(
    await rowHeight(),
    gridHeight,
    'refinement to translation keeps grid height',
  );
  translations[1]();
  await expect(page.getByTestId('task-activity')).toContainText(
    'Received 1/2 batches',
  );
  await expect(page.getByTestId('task-activity')).toContainText(
    'Saved 0 batches',
  );
  await page.screenshot({
    animations: 'disabled',
    path: path.join(output, 'grid-translating.png'),
  });
  translations[0]();
  await expect
    .poll(async () => (await item()).pipelineFiles[0].translateSubtitle)
    .toBe('done');
  await expect(page.getByTestId('task-activity')).toContainText('Completed');
  assert.equal(await rowHeight(), gridHeight, 'completion keeps grid height');
  const final = (await item()).pipelineFiles[0];
  assert.equal(final.taskActivity.status, 'done');
  assert.equal(final.taskActivity.savedBatches, 2);
  assert.match(await fs.readFile(final.translatedSrtFile, 'utf8'), /你好/);
  assert.match(await fs.readFile(final.srtFile, 'utf8'), /Hello there/);
  // A new execution must not inherit the previous completed activity; cancellation
  // must close in-flight requests and remain closed after navigating back.
  const previousRun = final.taskActivity.run;
  releaseAsr = undefined;
  pending.length = 0;
  const retry = await page.evaluate(async (projectId) => {
    const task = await window.ipc.invoke('getWorkItem', projectId);
    return window.ipc.invoke('submitTask', {
      requestId: 'activity-fixture-retry',
      projectId,
      files: task.pipelineFiles,
      formData: task.configSnapshot,
    });
  }, projectId);
  assert.equal(retry.success, true, JSON.stringify(retry));
  await expect.poll(() => Boolean(releaseAsr)).toBe(true);
  releaseAsr();
  await expect.poll(() => pending.length).toBe(2);
  await expect(page.getByTestId('task-activity')).toContainText(
    'Processed 0/2 batches',
  );
  assert.ok((await item()).pipelineFiles[0].taskActivity.run > previousRun);
  await page.evaluate((id) => window.ipc.send('cancelTask', id), projectId);
  await expect
    .poll(async () => (await item()).pipelineFiles[0].taskActivity.status)
    .toBe('cancelled');
  await expect(page.getByTestId('task-activity')).toContainText('Cancelled');
  for (const respond of pending) respond();
  await page.reload();
  await expect(page.getByTestId('task-activity')).toContainText('Cancelled');
  assert.equal(
    (await item()).pipelineFiles[0].taskActivity.status,
    'cancelled',
  );
  assert.deepEqual(errors, []);
  console.log(`Task activity E2E passed. Evidence: ${output}`);
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    await fs.writeFile(
      path.join(output, 'failure.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  console.error(`Evidence: ${output}`);
  throw error;
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
