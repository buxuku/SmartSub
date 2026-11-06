import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-document-e2e-'),
);
const media = path.join(evidence, 'compose.mp4');
const subtitle = path.join(evidence, 'compose.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=25:d=3',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  media,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:03,000\nSmartSub draft\n',
);
const route = `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let app, page;
const checks = [];
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(evidence, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(20000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(
    (electron, longMedia) => {
      const { BrowserWindow, dialog } = electron;
      BrowserWindow.getAllWindows().forEach((window) =>
        window.webContents.closeDevTools(),
      );
      globalThis.nativeResponse = 1;
      globalThis.nativeConfirmations = [];
      dialog.showMessageBoxSync = (...args) => {
        globalThis.nativeConfirmations.push(args.at(-1).title);
        return globalThis.nativeResponse;
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [longMedia],
      });
    },
    path.join(evidence, 'long-compose.mp4'),
  );
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate((route) => window.next.router.push(route), route);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const y = () =>
    page.getByRole('spinbutton', { name: '垂直位置 (%)', exact: true });
  await y().fill('40');
  await page.getByRole('button', { name: '保存合成工程', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await y().fill('55');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(y()).toHaveValue('40');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(y()).toHaveValue('55');
  await page.getByRole('button', { name: '收起样式面板', exact: true }).focus();
  await page.keyboard.press(`${mod}+b`);
  await expect(page.getByTestId('compose-inspector')).not.toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.keyboard.press(`${mod}+b`);
  await expect(y()).toHaveValue('55');
  checks.push(
    'save baseline, button and keyboard undo/redo, Cmd+B inspector collapse',
  );
  await page.locator('video').evaluate((video) => {
    video.pause();
    video.currentTime = 0;
  });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.currentTime))
    .toBeGreaterThan(0.2);
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.paused))
    .toBe(true);
  await y().focus();
  await page.keyboard.press('Space');
  assert.equal(
    await page.locator('video').evaluate((video) => video.paused),
    true,
  );
  await y().fill('55');
  checks.push('space playback/pause with numeric-input isolation');

  for (const navigate of [
    () => page.getByRole('link', { name: '启动台', exact: true }).click(),
    () => page.evaluate(() => history.back()),
    async () => {
      await page.keyboard.press(`${mod}+k`);
      await page.getByRole('option', { name: '启动台', exact: true }).click();
    },
  ]) {
    await navigate();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await expect(y()).toHaveValue('55');
    await expect(page).toHaveURL(new RegExp('/zh/subtitleMerge/'));
  }
  const confirmations = await app.evaluate(
    () => globalThis.nativeConfirmations.length,
  );
  await page.evaluate(() => location.reload());
  await expect
    .poll(() => app.evaluate(() => globalThis.nativeConfirmations.length))
    .toBe(confirmations + 1);
  assert.equal(
    await page.evaluate(
      () => document.querySelector('#subtitle-position-y')?.value,
    ),
    '55',
  );
  await app.evaluate(({ app }) => app.quit());
  await expect
    .poll(() => app.evaluate(() => globalThis.nativeConfirmations.length))
    .toBe(confirmations + 2);
  await page.evaluate(async () =>
    window.ipc.invoke('setSettings', {
      ...(await window.ipc.invoke('getSettings')),
      closeAction: 'quit',
    }),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => !window.webContents.getURL().startsWith('devtools:'))
      .close(),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.nativeConfirmations.length))
    .toBe(confirmations + 3);
  checks.push(
    'sidebar/history/command palette guard, cancelled native reload and quit preserve edits',
  );

  await app.evaluate(() => {
    globalThis.nativeResponse = 0;
  });
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(y()).toHaveValue('55');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(y()).toHaveValue('40');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(y()).toHaveValue('55');
  checks.push(
    'real renderer reload restores complete draft and saved undo baseline',
  );

  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('smartsub_compose_draft_'))
        throw new DOMException('E2E storage full', 'QuotaExceededError');
      return window.originalSetItem.call(this, key, value);
    };
  });
  await y().fill('65');
  await expect(
    page.getByRole('alert').filter({ hasText: '草稿' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText(
    '草稿未能放弃',
  );
  await page.screenshot({ path: path.join(evidence, 'storage-failure.png') });
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalSetItem;
  });
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/zh\/home\/?$/);
  await page.evaluate((route) => window.next.router.push(route), route);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(y()).toHaveValue('65');
  checks.push(
    'injected storage failure blocks save/discard navigation; retry persists and clean remount restores',
  );

  for (const size of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find(
            (window) => !window.webContents.getURL().startsWith('devtools:'),
          )
          .setContentSize(...size),
      size,
    );
    await expect(page.getByTestId('compose-inspector')).toBeVisible();
    await expect
      .poll(() => page.locator('video').evaluate((video) => video.readyState))
      .toBeGreaterThan(1);
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      'no horizontal page overflow',
    );
    await page.screenshot({
      path: path.join(evidence, `compose-${size[0]}.png`),
    });
  }
  await y().fill('75');
  const otherRoute = `/zh/subtitleMerge/?video=${encodeURIComponent(media)}`;
  await page.evaluate((route) => {
    void window.next.router.push(route).catch(() => {});
  }, otherRoute);
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has('subtitle'));
  await page.evaluate((route) => window.next.router.push(route), route);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(y()).toHaveValue('65');
  checks.push(
    '1024x700/1440x900 screenshots, query-context remount, discard restores prior saved document',
  );
  const longMedia = path.join(evidence, 'long-compose.mp4');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stream_loop',
    '399',
    '-i',
    media,
    '-c',
    'copy',
    longMedia,
  ]);
  await page.getByTitle(media, { exact: true }).click();
  const longOutput = path.join(evidence, 'long-compose_subtitled.mp4');
  await expect(
    page.getByRole('textbox', { name: '选择输出路径', exact: true }),
  ).toHaveValue(longOutput);
  await page.getByRole('button', { name: '保存合成工程', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.ipc.invoke('subtitleMerge:getQueue')).data.some(
          (job) => job.status === 'running',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await page.evaluate((route) => window.next.router.push(route), route);
  await expect(
    page.getByRole('button', { name: '取消', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.ipc.invoke('subtitleMerge:getQueue')).data.some(
          (job) => job.status === 'cancelled',
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole('button', { name: '生成视频', exact: true }),
  ).toBeEnabled();
  await assert.rejects(fs.access(longOutput));
  checks.push(
    'real FFmpeg running-job navigation/reconnection, exact job cancellation and partial-output removal',
  );
  await fs.writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(evidence, 'failure.png') })
    .catch(() => {});
  console.error({ evidence });
  throw error;
} finally {
  await app
    ?.evaluate(() => {
      globalThis.nativeResponse = 0;
    })
    .catch(() => {});
  await app?.close();
}
