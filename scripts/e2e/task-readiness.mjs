import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-readiness-e2e-'),
);
const media = path.join(output, 'submission.mp4');
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
let uploads = 0;
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/transcriptions') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.on('end', () => {
    uploads++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        text: 'Local submission test',
        language: 'en',
        duration: 2,
        segments: [{ start: 0, end: 1.8, text: 'Local submission test' }],
        words: [
          { start: 0, end: 0.5, word: 'Local' },
          { start: 0.5, end: 1, word: 'submission' },
          { start: 1, end: 1.8, word: 'test' },
        ],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const app = await _electron.launch({
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
await app.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
  BrowserWindow.getAllWindows().forEach((win) =>
    win.webContents.closeDevTools(),
  );
  dialog.showMessageBoxSync = () => 0;
  // Observe the real handler, retaining persistence, queueing and processing.
  // Audio is sent only to the local fixture service, never an external provider.
  globalThis.dispatched = [];
  globalThis.attempts = [];
  const submit = ipcMain._invokeHandlers.get('submitTask');
  ipcMain.removeHandler('submitTask');
  ipcMain.handle('submitTask', async (event, payload) => {
    globalThis.attempts.push(payload);
    const response = await submit(event, payload);
    if (response.success) globalThis.dispatched.push(payload);
    if (response.success && globalThis.dropReplyOnce) {
      globalThis.dropReplyOnce = false;
      throw new Error('E2E reply lost after acceptance');
    }
    if (response.success && globalThis.holdReply)
      await new Promise((resolve) => {
        globalThis.releaseReply = resolve;
      });
    return response;
  });
});
const origin = new URL(page.url()).origin;
const key = 'smartsub_task_wizard_draft_v1';
const provider = {
  id: 'e2e-asr',
  name: 'E2E ASR',
  type: 'openaiCompatible',
  apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
  apiKey: 'test-only',
  models: ['whisper-1'],
};
const config = {
  transcriptionEngine: 'cloud',
  model: 'whisper-1',
  asrProviderId: provider.id,
  taskType: 'generateOnly',
  sourceLanguage: 'en',
  translateProvider: '-1',
  sourceSrtSaveOption: 'fileName',
  aiCorrection: false,
  aiSegmentation: false,
};
const count = () => app.evaluate(() => globalThis.dispatched.length);
async function waitForCompletion(id) {
  await expect
    .poll(
      () => page.evaluate((id) => window.ipc.invoke('getTaskStatus', id), id),
      { timeout: 60000 },
    )
    .toBe('idle');
  const item = await page.evaluate(
    (id) => window.ipc.invoke('getWorkItem', id),
    id,
  );
  assert.equal(
    item.pipelineFiles[0].extractSubtitle,
    'done',
    JSON.stringify(item.pipelineFiles[0]),
  );
  assert.match(
    await fs.readFile(item.pipelineFiles[0].srtFile, 'utf8'),
    /Local submission test/,
  );
}
async function setProviders(value) {
  await page.evaluate(
    (providers) => window.ipc.send('setAsrProviders', providers),
    value,
  );
  await expect
    .poll(() => page.evaluate(() => window.ipc.invoke('getAsrProviders')))
    .toEqual(value);
}
async function openWizard() {
  await page.evaluate(
    ({ key, files, config }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          files,
          goals: { translate: false, dub: false, video: false },
          config,
          savedAt: Date.now(),
        }),
      );
    },
    { key, files, config },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
}
let files;
let lockedDirectory;
try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  files = await page.evaluate(
    async (media) =>
      window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      }),
    media,
  );
  await setProviders([provider]);
  await openWizard();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '上传音频到云端听写？' }),
  ).toBeVisible();
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await count(), 0);
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  // Dependency removal while consent is open must be caught before dispatch.
  await expect(
    page.getByRole('alertdialog', { name: '上传音频到云端听写？' }),
  ).toBeVisible();
  await setProviders([]);
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect(
    page.getByText(
      '所选引擎或模型未就绪。请重新安装，或选择另一个已就绪的模型。',
      { exact: true },
    ),
  ).toBeVisible();
  assert.equal(await count(), 0);
  await setProviders([provider]);
  // Real config directory permission failure must retain the entire draft.
  lockedDirectory = path.join(output, 'profile');
  await fs.chmod(lockedDirectory, 0o500);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect(page.getByText(/EACCES/)).toBeVisible();
  assert.equal(await count(), 0);
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getWorkItems'))).length,
    0,
  );
  assert.ok(await page.evaluate((key) => localStorage.getItem(key), key));
  await expect(page).toHaveURL(/\/tasks\/new/);
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await app.evaluate(() => {
    globalThis.holdReply = true;
  });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(count).toBe(1);
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeDisabled();
  assert.ok(
    await page.evaluate((key) => localStorage.getItem(key), key),
    'draft stays until acknowledgement',
  );
  const attempts = await app.evaluate(() => globalThis.attempts);
  assert.equal(
    attempts[0].requestId,
    attempts[1].requestId,
    'failed persistence retries the same request',
  );
  const disk = JSON.parse(
    await fs.readFile(path.join(output, 'profile', 'config.json'), 'utf8'),
  );
  assert.equal(disk.workItems[0].configSnapshot.asrProviderId, provider.id);
  assert.equal(disk.workItems[0].pipelineFiles[0].filePath, media);
  await app.evaluate(() => {
    globalThis.holdReply = false;
    globalThis.releaseReply();
  });
  await expect(page).toHaveURL(/\/tasks\/generate\/?\?project=/);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    null,
  );
  assert.notEqual(
    (await page.evaluate(() => window.ipc.invoke('getSettings')))
      .cloudUploadConsent,
    true,
  );
  const task = await app.evaluate(() => globalThis.dispatched[0]);
  assert.equal(task.formData.asrProviderId, provider.id);
  assert.equal(task.files[0].filePath, media);
  await waitForCompletion(task.projectId);

  // A provider removed after render is caught by fresh start validation.
  await openWizard();
  await setProviders([]);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(
    page.getByText(
      '所选引擎或模型未就绪。请重新安装，或选择另一个已就绪的模型。',
      { exact: true },
    ),
  ).toBeVisible();
  assert.equal(await count(), 1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await setProviders([provider]);

  // Ordinary task start uses the same confirmation; preserving a snapshot makes
  // this independent of global defaults and other installed models.
  const workItem = await page.evaluate(
    (task) => window.ipc.invoke('getWorkItem', task.projectId),
    task,
  );
  assert.ok(workItem?.id);
  await page.evaluate(
    ({ item, config, files }) =>
      window.ipc.invoke('saveWorkItem', {
        ...item,
        pipelineFiles: files,
        status: 'waiting',
        configSnapshot: { ...config, useEmbeddedSubtitles: false },
      }),
    { item: workItem, config, files },
  );
  await page.goto(`${origin}/zh/tasks/generate/?project=${task.projectId}`);
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '上传音频到云端听写？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await count(), 1);
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await page
    .getByRole('button', { name: '上传并不再提醒', exact: true })
    .click();
  await expect.poll(count).toBe(2);
  await waitForCompletion(task.projectId);
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getSettings')))
      .cloudUploadConsent,
    true,
  );
  await page.evaluate(
    async ({ id }) => {
      await window.ipc.invoke('setSettings', {
        cloudUploadConsent: false,
        taskViewMode: 'list',
      });
      const item = await window.ipc.invoke('getWorkItem', id);
      await window.ipc.invoke('saveWorkItem', {
        ...item,
        status: 'error',
        pipelineFiles: item.pipelineFiles.map((file) => ({
          ...file,
          extractAudio: 'done',
          extractSubtitle: 'error',
          extractSubtitleError: 'E2E retry fixture',
        })),
      });
    },
    { id: task.projectId },
  );
  await page.reload();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '上传音频到云端听写？' }),
  ).toBeVisible();
  assert.equal(await count(), 2);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await setProviders([]);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    page.getByText(
      '所选引擎或模型未就绪。请重新安装，或选择另一个已就绪的模型。',
      { exact: true },
    ),
  ).toBeVisible();
  assert.equal(await count(), 2);
  await setProviders([provider]);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(count).toBe(3);
  await waitForCompletion(task.projectId);
  assert.equal(uploads, 3, 'one local ASR request per accepted run');
  await openWizard();
  await app.evaluate(() => {
    globalThis.dropReplyOnce = true;
  });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect(page.getByText(/E2E reply lost after acceptance/)).toBeVisible();
  await expect.poll(count).toBe(4);
  const uncertain = await app.evaluate(() => globalThis.dispatched[3]);
  assert.ok(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).submission.requestId,
      key,
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`project=${uncertain.projectId}`));
  await waitForCompletion(uncertain.projectId);
  const replay = await app.evaluate(() => globalThis.dispatched[4]);
  assert.equal(replay.requestId, uncertain.requestId);
  assert.equal(
    uploads,
    4,
    'lost reply and reload must not duplicate the pipeline',
  );
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getWorkItems'))).length,
    2,
  );
  await openWizard();
  await app.evaluate(() => {
    globalThis.holdReply = true;
  });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(count).toBe(6);
  const beforeEdit = await app.evaluate(() => globalThis.dispatched[5]);
  await page.getByRole('combobox', { name: '视频语言', exact: true }).click();
  await page.getByRole('option', { name: '自动识别', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).config.sourceLanguage,
        key,
      ),
    )
    .toBe('auto');
  await app.evaluate(() => {
    globalThis.holdReply = false;
    globalThis.releaseReply();
  });
  await expect(page).toHaveURL(new RegExp(`project=${beforeEdit.projectId}`));
  const newerDraft = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    key,
  );
  assert.equal(newerDraft.config.sourceLanguage, 'auto');
  assert.notEqual(newerDraft.id, beforeEdit.projectId);
  assert.equal(newerDraft.submission, undefined);
  await waitForCompletion(beforeEdit.projectId);
  await page.screenshot({ path: path.join(output, 'task-dispatched.png') });
  console.log(
    JSON.stringify({
      success: true,
      output,
      checks: [
        'wizard cloud confirmation/cancel/single dispatch',
        'fresh dependency validation',
        'dependency removal during consent',
        'real disk failure retains draft and rejects queueing',
        'durable file/config snapshot before acknowledgement',
        'delayed acknowledgement retains draft and disables duplicate start',
        'real pipeline and exported subtitles through local ASR fixture',
        'lost acceptance reply and reload replay without duplicate pipeline',
        'edits made during submission remain in a separate recoverable draft',
        'task-page confirmation',
        'remember consent',
        'failed item retry uses fresh validation and cloud consent',
        'no external uploads',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('Task readiness E2E evidence:', output);
  throw error;
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  await app.close();
  await new Promise((resolve) => server.close(resolve));
}
