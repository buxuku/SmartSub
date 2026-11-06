import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

/**
 * Starting a task that transcribes video asks whether to use the subtitles a video already
 * carries: the real probe in the main process, the real pipeline behind the answer.
 *
 * - a fresh install prefers the embedded subtitles and has remembered nothing;
 * - no embedded subtitles: no dialog, the start goes on as before;
 * - the answer only applies to the task being started (and "cancel" starts nothing);
 * - "use" extracts the track without any speech recognition, "transcribe" ignores it;
 * - "remember" stores the default and stops asking, and More settings takes it back.
 *
 * Speech recognition is a local fixture service, so "was audio uploaded" is observable.
 */
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-embedded-prompt-e2e-'),
);
const captions = path.join(output, 'captions.srt');
await fs.writeFile(
  captions,
  '1\n00:00:00,000 --> 00:00:01,500\nEmbedded caption line.\n\n2\n00:00:01,500 --> 00:00:02,800\nSecond embedded line.\n\n',
);
const withSubtitles = path.join(output, 'with-subtitles.mp4');
const withoutSubtitles = path.join(output, 'without-subtitles.mp4');
const source = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=320x240:r=15:d=3',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=3',
];
const encode = [
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
];
execFileSync(ffmpeg, [
  ...source,
  '-i',
  captions,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:0',
  ...encode,
  '-c:s',
  'mov_text',
  '-metadata:s:s:0',
  'language=eng',
  withSubtitles,
]);
execFileSync(ffmpeg, [
  ...source,
  '-map',
  '0:v',
  '-map',
  '1:a',
  ...encode,
  withoutSubtitles,
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
        text: 'Spoken fixture line',
        language: 'en',
        duration: 3,
        segments: [{ start: 0, end: 2.5, text: 'Spoken fixture line' }],
        words: [
          { start: 0, end: 0.8, word: 'Spoken' },
          { start: 0.8, end: 1.6, word: 'fixture' },
          { start: 1.6, end: 2.5, word: 'line' },
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
page.setDefaultTimeout(30000);
// The development server (`yarn dev`) or the packaged protocol (`yarn build`) both work.
await page.waitForURL(/^(http:\/\/localhost:\d+|app:\/\/)/);
await app.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
  BrowserWindow.getAllWindows().forEach((win) =>
    win.webContents.closeDevTools(),
  );
  dialog.showMessageBoxSync = () => 0;
  // Observe the real handlers: submissions and probes still run for real.
  globalThis.dispatched = [];
  globalThis.probes = [];
  const submit = ipcMain._invokeHandlers.get('submitTask');
  ipcMain.removeHandler('submitTask');
  ipcMain.handle('submitTask', async (event, payload) => {
    const response = await submit(event, payload);
    if (response.success) globalThis.dispatched.push(payload);
    return response;
  });
  const probe = ipcMain._invokeHandlers.get('findEmbeddedSubtitles');
  ipcMain.removeHandler('findEmbeddedSubtitles');
  ipcMain.handle('findEmbeddedSubtitles', async (event, request) => {
    const result = await probe(event, request);
    globalThis.probes.push({ request, result });
    return result;
  });
});

// `new URL('app://./x').origin` is "null", so take the prefix by hand.
const origin = page.url().match(/^(app:\/\/\.|http:\/\/localhost:\d+)/)[1];
const draftKey = 'smartsub_task_wizard_draft_v1';
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
const embeddedDialog = page.getByRole('alertdialog', {
  name: '检测到视频内封了字幕',
});
const consentDialog = page.getByRole('alertdialog', {
  name: '上传音频到云端听写？',
});
const startButton = page.getByRole('button', { name: '开始', exact: true });
const dispatched = () => app.evaluate(() => globalThis.dispatched);
const probes = () => app.evaluate(() => globalThis.probes);
const settings = () => page.evaluate(() => window.ipc.invoke('getSettings'));
const userConfig = () =>
  page.evaluate(() => window.ipc.invoke('getUserConfig'));
// The window may be occluded while it runs; settle animations so screenshots are final.
const settle = () =>
  page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important}',
  });

async function openWizard(mediaFile) {
  const files = await page.evaluate(
    async (media) =>
      window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      }),
    mediaFile,
  );
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
    { key: draftKey, files, config },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(startButton).toBeEnabled();
}

// The task page of a media task holding `mediaFile`, with 更多设置 open on its 常用 page.
async function openMoreSettings(mediaFile) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, mediaFile);
  await page.goto(`${origin}/zh/tasks/generate/`);
  await page.getByRole('button', { name: '导入', exact: true }).first().click();
  await expect(page).toHaveURL(/project=/);
  await page.getByRole('button', { name: '更多设置' }).click();
  const sheet = page.getByRole('dialog');
  return {
    sheet,
    preferEmbedded: sheet.getByRole('switch', {
      name: '优先使用内封字幕',
    }),
    ask: sheet.getByRole('checkbox', { name: '开始前提示我选择' }),
  };
}

async function finished(projectId) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.ipc.invoke('getTaskStatus', id),
          projectId,
        ),
      { timeout: 60000 },
    )
    .toBe('idle');
  const item = await page.evaluate(
    (id) => window.ipc.invoke('getWorkItem', id),
    projectId,
  );
  const file = item.pipelineFiles[0];
  assert.equal(file.extractSubtitle, 'done', JSON.stringify(file));
  return { file, text: await fs.readFile(file.srtFile, 'utf8') };
}

try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    (providers) => window.ipc.send('setAsrProviders', providers),
    [provider],
  );
  await expect
    .poll(() => page.evaluate(() => window.ipc.invoke('getAsrProviders')))
    .toEqual([provider]);

  // 0. A fresh install prefers the embedded subtitles and has remembered nothing: More
  // settings shows the switch on and the question on, and merely looking writes nothing.
  assert.equal((await userConfig()).useEmbeddedSubtitles, true);
  assert.equal((await settings()).embeddedSubtitlePrompt, undefined);
  const fresh = await openMoreSettings(withSubtitles);
  await expect(fresh.preferEmbedded).toBeChecked();
  await expect(fresh.ask).toBeEnabled();
  await expect(fresh.ask).toBeChecked();
  await settle();
  await page.screenshot({
    path: path.join(output, 'fresh-install-more-settings.png'),
  });
  await page.keyboard.press('Escape');
  await expect(fresh.sheet).toHaveCount(0);
  // Longer than the debounce of the defaults sync, so a stray write would have landed.
  await page.waitForTimeout(1000);
  assert.equal(
    (await userConfig()).useEmbeddedSubtitles,
    true,
    'looking at the options is not choosing',
  );
  assert.equal((await settings()).embeddedSubtitlePrompt, undefined);

  // 1. A video without embedded subtitles is probed, found empty and started as before.
  await openWizard(withoutSubtitles);
  await startButton.click();
  await expect(consentDialog).toBeVisible();
  await expect(embeddedDialog).toHaveCount(0);
  assert.equal((await probes()).length, 1);
  assert.equal((await probes())[0].result.status, 'none');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await dispatched()).length, 0);

  // 2. A video with them asks first; cancelling starts nothing and asks nothing more.
  await openWizard(withSubtitles);
  const clicked = Date.now();
  await startButton.click();
  await expect(embeddedDialog).toBeVisible();
  const clickToDialogMs = Date.now() - clicked;
  const found = (await probes())[1].result;
  assert.equal(found.status, 'found');
  assert.ok(
    found.elapsedMs < 1000,
    `the probe stays inside its budget (${found.elapsedMs} ms)`,
  );
  assert.match(found.hit.filePath, /with-subtitles\.mp4$/);
  assert.deepEqual(found.hit.tracks, [{ language: 'eng', codec: 'mov_text' }]);
  await expect(embeddedDialog).toContainText('with-subtitles.mp4');
  await expect(embeddedDialog).toContainText('MOV Text');
  await expect(embeddedDialog).toContainText('更多设置 › 常用');
  await expect(
    embeddedDialog.getByRole('checkbox', { name: '记住我的选择，不再提示' }),
    'nothing is remembered unless the user says so',
  ).not.toBeChecked();
  await settle();
  await page.screenshot({ path: path.join(output, 'embedded-prompt.png') });
  await embeddedDialog
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(embeddedDialog).toHaveCount(0);
  await expect(consentDialog).toHaveCount(0);
  assert.equal((await dispatched()).length, 0);
  await expect(startButton).toBeEnabled();

  // 3. "Use" is a promise for this task only, and the pipeline keeps it: no audio leaves.
  assert.equal(
    (await userConfig()).useEmbeddedSubtitles,
    true,
    'new tasks start by using embedded subtitles',
  );
  await startButton.click();
  await expect(embeddedDialog).toBeVisible();
  await embeddedDialog
    .getByRole('button', { name: '使用内封字幕', exact: true })
    .click();
  await expect(consentDialog).toBeVisible();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(async () => (await dispatched()).length).toBe(1);
  const used = (await dispatched())[0];
  assert.equal(used.formData.useEmbeddedSubtitles, true);
  const usedRun = await finished(used.projectId);
  assert.equal(usedRun.file.embeddedSubtitle, true);
  assert.match(usedRun.text, /Embedded caption line\./);
  assert.equal(uploads, 0, 'nothing was transcribed in the cloud');
  assert.notEqual((await settings()).embeddedSubtitlePrompt, false);

  // 4. "Transcribe instead" ignores the track for this task only and uses the engine.
  await openWizard(withSubtitles);
  await startButton.click();
  await expect(embeddedDialog).toBeVisible();
  await embeddedDialog
    .getByRole('button', { name: '改用语音识别', exact: true })
    .click();
  await expect(consentDialog).toBeVisible();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(async () => (await dispatched()).length).toBe(2);
  const transcribed = (await dispatched())[1];
  assert.equal(transcribed.formData.useEmbeddedSubtitles, false);
  const transcribedRun = await finished(transcribed.projectId);
  assert.notEqual(transcribedRun.file.embeddedSubtitle, true);
  assert.match(transcribedRun.text, /Spoken fixture line/);
  assert.equal(uploads, 1, 'the audio went to the transcription service');
  assert.equal(
    (await userConfig()).useEmbeddedSubtitles,
    true,
    'an answer that is not remembered leaves the defaults alone',
  );
  assert.notEqual((await settings()).embeddedSubtitlePrompt, false);

  // 4b. A task whose configuration is already pinned keeps its stored snapshot when it is
  // started again, so there is nothing left to choose and nothing is probed either.
  const pinnedFiles = await page.evaluate(
    async (media) =>
      window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      }),
    withSubtitles,
  );
  await page.evaluate(
    async ({ id, files, config }) => {
      const item = await window.ipc.invoke('getWorkItem', id);
      await window.ipc.invoke('saveWorkItem', {
        ...item,
        pipelineFiles: files,
        status: 'waiting',
        configSnapshot: { ...config, subtitleOutputFormats: ['srt'] },
      });
    },
    { id: used.projectId, files: pinnedFiles, config },
  );
  await page.goto(`${origin}/zh/tasks/generate/?project=${used.projectId}`);
  const beforePinned = (await probes()).length;
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await expect(consentDialog).toBeVisible();
  await expect(embeddedDialog).toHaveCount(0);
  assert.equal(
    (await probes()).length,
    beforePinned,
    'a pinned page does not probe',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await dispatched()).length, 2);

  // 5. "Remember" stores the choice as the default and stops asking, probing included.
  await openWizard(withSubtitles);
  await startButton.click();
  await expect(embeddedDialog).toBeVisible();
  const remember = embeddedDialog.getByRole('checkbox', {
    name: '记住我的选择，不再提示',
  });
  await expect(remember).not.toBeChecked();
  await embeddedDialog.getByText('记住我的选择，不再提示').click();
  await expect(remember).toBeChecked();
  await embeddedDialog
    .getByRole('button', { name: '改用语音识别', exact: true })
    .click();
  await expect(consentDialog).toBeVisible();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(async () => (await dispatched()).length).toBe(3);
  await finished((await dispatched())[2].projectId);
  assert.equal(uploads, 2);
  assert.equal((await settings()).embeddedSubtitlePrompt, false);
  assert.equal((await userConfig()).useEmbeddedSubtitles, false);
  const probed = (await probes()).length;
  await openWizard(withSubtitles);
  await startButton.click();
  await expect(consentDialog).toBeVisible();
  await expect(embeddedDialog).toHaveCount(0);
  assert.equal(
    (await probes()).length,
    probed,
    'a silenced prompt never probes',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await dispatched()).length, 3);

  // 6. More settings shows what was remembered and takes the question back.
  const { sheet, preferEmbedded, ask } = await openMoreSettings(withSubtitles);
  await expect(preferEmbedded).not.toBeChecked();
  await expect(ask).toBeDisabled();
  await settle();
  await page.screenshot({ path: path.join(output, 'more-settings.png') });
  await preferEmbedded.click();
  await expect(preferEmbedded).toBeChecked();
  await expect(ask).toBeEnabled();
  await expect(ask).not.toBeChecked();
  await sheet.getByText('开始前提示我选择').click();
  await expect(ask).toBeChecked();
  await expect
    .poll(async () => (await settings()).embeddedSubtitlePrompt)
    .toBe(true);

  console.log(
    JSON.stringify({
      evidence: output,
      // What the user waits between pressing Start and seeing the question.
      clickToDialogMs,
      probeMs: found.elapsedMs,
      checks: [
        'a fresh install prefers embedded subtitles, remembers nothing, and looking changes nothing',
        'a video without embedded subtitles starts without a question',
        'a video with them asks; cancelling starts nothing',
        'using them is applied to that task and no audio is uploaded',
        'transcribing instead is applied to that task and uses the engine',
        'a task whose configuration is pinned is not asked again',
        'remembering stores the default, stops asking and stops probing',
        'More settings turns the question back on',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('Embedded subtitle prompt evidence:', output);
  throw error;
} finally {
  await app.close().catch(() => {});
  server.close();
}
