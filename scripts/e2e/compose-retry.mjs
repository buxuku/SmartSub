import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-retry-e2e-'),
);
const video = path.join(output, 'video.mp4');
const subtitle = path.join(output, 'subtitle.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=25:d=2',
  '-c:v',
  'libx264',
  video,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:02,000\nRetry fixture\n',
);
let app, page;
const checks = [];
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await expect
    .poll(() =>
      app.evaluate(({ ipcMain }) =>
        ipcMain._invokeHandlers.has('subtitleMerge:saveStylePreset'),
      ),
    )
    .toBe(true);
  await app.evaluate(({ BrowserWindow, dialog, ipcMain, shell }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    globalThis.retryFaults = {};
    globalThis.retryCalls = [];
    globalThis.folderCalls = [];
    shell.showItemInFolder = (file) => globalThis.folderCalls.push(file);
    for (const name of [
      'saveStylePreset',
      'deleteStylePreset',
      'listStylePresets',
      'setPreferences',
      'selectOutputPath',
      'openOutputFolder',
      'cancelMerge',
      'getVideoInfo',
    ]) {
      const channel = `subtitleMerge:${name}`;
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error(`Missing production handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        globalThis.retryCalls.push({ name, payload: args[1] });
        const mode = globalThis.retryFaults[name];
        if (mode === 'before') throw new Error(`E2E ${name} unavailable`);
        if (mode === 'delayed')
          await new Promise((resolve) => {
            globalThis.releaseRetryRead = resolve;
          });
        const result = await original(...args);
        if (mode === 'after')
          throw new Error(`E2E ${name} response lost after persistence`);
        return result;
      });
    }
  });
  const fault = (name, mode) =>
    app.evaluate(
      (_electron, { name, mode }) => {
        globalThis.retryFaults[name] = mode;
      },
      { name, mode },
    );
  const invoke = (name, payload) =>
    page.evaluate(
      ({ name, payload }) =>
        window.ipc.invoke(`subtitleMerge:${name}`, payload),
      { name, payload },
    );
  const failures = page
    .getByRole('alert')
    .filter({ hasText: '合成设置或素材读取、保存失败。' });
  const retry = () =>
    failures.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await fault('getVideoInfo', 'before');
  await page.evaluate(
    ({ video, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(video)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { video, subtitle },
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await expect(failures).toBeVisible();
  await fault('getVideoInfo', 'delayed');
  const readCalls = await app.evaluate(
    () =>
      globalThis.retryCalls.filter((call) => call.name === 'getVideoInfo')
        .length,
  );
  await retry();
  const retryButton = failures.getByRole('button', {
    name: '重试',
    exact: true,
  });
  await expect(retryButton).toBeDisabled();
  await expect(failures).toBeVisible();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseRetryRead))
    .toBe('function');
  assert.equal(
    await app.evaluate(
      () =>
        globalThis.retryCalls.filter((call) => call.name === 'getVideoInfo')
          .length,
    ),
    readCalls + 1,
  );
  await app.evaluate(() => globalThis.releaseRetryRead());
  await expect(failures).toHaveCount(0);
  await fault('getVideoInfo', undefined);
  checks.push(
    'metadata read retry remains disabled with its error visible until the production IPC completes',
  );
  await page.getByRole('button', { name: '存为我的样式', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Retry persisted');
  await fault('saveStylePreset', 'after');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(failures).toBeVisible();
  const persisted = (await invoke('listStylePresets')).data;
  assert.equal(persisted.length, 1);
  const id = persisted[0].id;
  // Retrying the lost response must reuse the original durable identity.
  await fault('saveStylePreset', undefined);
  await retry();
  await expect(failures).toHaveCount(0);
  const card = page
    .getByRole('button')
    .filter({ has: page.locator('[title="Retry persisted"]') });
  await expect(card).toBeVisible();
  assert.equal((await invoke('listStylePresets')).data.length, 1);
  const saveCalls = await app.evaluate(() =>
    globalThis.retryCalls.filter((call) => call.name === 'saveStylePreset'),
  );
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0].payload.id, id);
  assert.deepEqual(saveCalls[0].payload, saveCalls[1].payload);
  checks.push(
    'production preset persisted before lost response; UI retry keeps the same id and a single saved preset',
  );

  await fault('deleteStylePreset', 'after');
  await card.hover();
  await card.getByRole('button', { name: '删除样式', exact: true }).click();
  await expect(failures).toBeVisible();
  assert.equal((await invoke('listStylePresets')).data.length, 0);
  await expect(card).toBeVisible();
  await fault('deleteStylePreset', undefined);
  await retry();
  await expect(failures).toHaveCount(0);
  await expect(card).toHaveCount(0);
  checks.push(
    'lost delete response keeps failure visible; idempotent retry reconciles the UI with the persisted deletion',
  );

  await fault('selectOutputPath', 'before');
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await expect(failures).toBeVisible();
  const exported = path.join(output, 'retry.mp4');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await fault('selectOutputPath', undefined);
  await retry();
  await expect(
    page.getByRole('textbox', { name: '选择输出路径', exact: true }),
  ).toHaveValue(exported);
  await expect(failures).toHaveCount(0);
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  assert.ok((await fs.stat(exported)).size > 0);
  await fault('openOutputFolder', 'before');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(failures).toBeVisible();
  await page.screenshot({ path: path.join(output, 'persistent-error.png') });
  await fault('openOutputFolder', undefined);
  await retry();
  await expect(failures).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.folderCalls), [
    exported,
  ]);
  checks.push(
    'output dialog retry selects the file, real FFmpeg export succeeds, folder retry reaches the intended native shell action',
  );

  await fault('setPreferences', 'before');
  await page.getByRole('button', { name: '封装软字幕', exact: true }).click();
  await expect(failures).toBeVisible();
  const before = await invoke('getPreferences');
  assert.notEqual(before.data.outputMode, 'softmux');
  await fault('setPreferences', undefined);
  await retry();
  await expect(failures).toHaveCount(0);
  assert.equal((await invoke('getPreferences')).data.outputMode, 'softmux');
  checks.push(
    'failed preference write stays visible and explicit retry persists the selected mode',
  );
  for (const size of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(...size),
      size,
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({ path: path.join(output, `layout-${size[0]}.png`) });
  }
  const longVideo = path.join(output, 'long.mp4');
  const longOutput = path.join(output, 'cancelled.mp4');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stream_loop',
    '899',
    '-i',
    video,
    '-c',
    'copy',
    longVideo,
  ]);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('E2E open dialog unavailable');
    };
  });
  await page.getByText('video.mp4', { exact: true }).click();
  await expect(failures).toBeVisible();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, longVideo);
  await retry();
  await expect(page.getByText('long.mp4', { exact: true })).toBeVisible();
  await expect(failures).toHaveCount(0);
  await page.getByRole('button', { name: '烧录硬字幕', exact: true }).click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, longOutput);
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect
    .poll(async () =>
      (await invoke('getQueue')).data.some(
        (job) => job.status === 'running' && job.videoPath === longVideo,
      ),
    )
    .toBe(true);
  const running = (await invoke('getQueue')).data.find(
    (job) => job.status === 'running' && job.videoPath === longVideo,
  );
  await fault('cancelMerge', 'before');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(failures).toBeVisible();
  assert.equal(
    (await invoke('getQueue')).data.find((job) => job.id === running.id).status,
    'running',
  );
  await fault('cancelMerge', undefined);
  await retry();
  await expect
    .poll(
      async () =>
        (await invoke('getQueue')).data.find((job) => job.id === running.id)
          .status,
    )
    .toBe('cancelled');
  await expect(failures).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '生成视频', exact: true }),
  ).toBeEnabled();
  await assert.rejects(fs.access(longOutput));
  assert.equal(
    (await fs.readdir(output)).some((name) =>
      name.startsWith('.smartsub-compose-'),
    ),
    false,
  );
  const cancellationCalls = await app.evaluate(() =>
    globalThis.retryCalls.filter((call) => call.name === 'cancelMerge'),
  );
  assert.deepEqual(
    cancellationCalls.map((call) => call.payload),
    [{ jobId: running.id }, { jobId: running.id }],
  );
  checks.push(
    'failed native video selection retries into the chosen long file; failed cancellation retry targets the original live FFmpeg job and cleans temporary output',
  );
  const calls = await app.evaluate(() => globalThis.retryCalls);
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ checks, calls }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  console.error({ output });
  if (page && !page.isClosed()) {
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(-3500),
    );
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
}
