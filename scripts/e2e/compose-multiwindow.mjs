import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-multiwindow-e2e-'),
);
const media = path.join(output, 'source.mp4');
const subtitle = path.join(output, 'source.srt');
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
  media,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:02,000\nShared composition\n',
);
const route = `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`;
const key = `smartsub_compose_draft_v1:${JSON.stringify([media, subtitle])}`;
const checks = [];
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
  const first = await app.firstWindow();
  await first.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await first.getByRole('button', { name: '跳过', exact: true }).click();
  await first.evaluate((route) => window.next.router.push(route), route);
  const position = (page) =>
    page.getByRole('spinbutton', { name: '垂直位置 (%)', exact: true });
  const save = (page) =>
    page.getByRole('button', { name: '保存合成工程', exact: true });
  await first.getByRole('button', { name: '高级设置', exact: true }).click();
  await position(first).fill('40');
  await save(first).click();
  await expect(
    first.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();

  const opened = app.waitForEvent('window');
  await app.evaluate(
    async ({ BrowserWindow }, { route, preload }) => {
      const owner = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('http://localhost'),
      );
      const window = new BrowserWindow({
        width: 1024,
        height: 700,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      globalThis.composePeer = window;
      window.setContentSize(1024, 700);
      await window.loadURL(new URL(route, owner.webContents.getURL()).href);
    },
    { route, preload: path.resolve('app/preload.js') },
  );
  const second = await opened;
  second.setDefaultTimeout(20000);
  const locked = second
    .getByRole('alert')
    .filter({ hasText: '此合成工程正在另一个窗口中编辑' });
  await expect(locked).toBeVisible();
  await expect(save(second)).toBeDisabled();
  await expect(
    second.getByRole('button', { name: '选择输出路径', exact: true }),
  ).toBeDisabled();
  assert.ok(
    await second.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await first
    .getByRole('button', { name: '保存合成工程', exact: true })
    .click();
  await position(first).fill('55');
  await save(first).click();
  await second.screenshot({ path: path.join(output, 'waiting-1024.png') });
  const before = await second.evaluate((key) => localStorage.getItem(key), key);
  await second.keyboard.press(
    process.platform === 'darwin' ? 'Meta+s' : 'Control+s',
  );
  assert.equal(
    await second.evaluate((key) => localStorage.getItem(key), key),
    before,
  );
  await first.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(locked).toHaveCount(0);
  await second.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(position(second)).toHaveValue('55');
  checks.push(
    'same draft blocks second window and keyboard save; navigation releases lock and loads latest saved state',
  );

  await position(second).fill('65');
  await first.evaluate((route) => window.next.router.push(route), route);
  await expect(
    first
      .getByRole('alert')
      .filter({ hasText: '此合成工程正在另一个窗口中编辑' }),
  ).toBeVisible();
  await app.evaluate(() =>
    globalThis.composePeer.webContents.forcefullyCrashRenderer(),
  );
  await first.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await first.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(position(first)).toHaveValue('65');
  await first.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(position(first)).toHaveValue('55');
  checks.push(
    'actual peer renderer crash releases lock, latest unsaved draft survives, undo restores latest saved baseline without stale memory',
  );
  await first.screenshot({ path: path.join(output, 'recovered.png') });
  await fs.writeFile(
    path.join(output, 'checks.json'),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  if (app)
    for (const [index, page] of (await app.windows()).entries())
      await page
        .screenshot({ path: path.join(output, `failure-${index}.png`) })
        .catch(() => {});
  console.error('Evidence:', output);
  throw error;
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
      )
      .catch(() => {});
    await app.close();
  }
}
