import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-completion-navigation-'),
);
const source = path.join(output, 'completion.srt');
const media = path.join(output, 'completion.mp4');
await fs.writeFile(
  source,
  '1\n00:00:00,000 --> 00:00:02,000\nCompletion navigation test.\n',
);
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=320x180:r=25:d=2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  media,
]);
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(output, 'profile')}`,
  ],
  env: {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const task = await page.evaluate(async (source) => {
    const result = await window.ipc.invoke('createProofreadTask', {
      name: 'Completion status regression',
      items: [{ sourceSubtitlePath: source, sourceLanguage: 'en' }],
    });
    if (!result.success) throw new Error(JSON.stringify(result));
    await window.next.router.push(`/zh/proofread/?workItem=${result.data.id}`);
    return result.data;
  }, source);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByRole('button', { name: '完成并返回', exact: true }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'completion.srt' }),
  ).toContainText('已完成');
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.ipc.invoke('getWorkItem', id)).status,
        task.id,
      ),
    )
    .toBe('done');
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/?$/);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const card = page
    .getByText('Completion status regression', { exact: true })
    .locator('..');
  await expect(card).toContainText('已完成');
  await page.reload();
  await expect(card).toContainText('已完成');
  checks.push(
    'Mark complete saves batch status; launchpad and reload show completed without a guard',
  );
  await page.screenshot({ path: path.join(output, 'launchpad-completed.png') });

  const route = `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(source)}`;
  await page.evaluate((route) => window.next.router.push(route), route);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const position = page.getByRole('spinbutton', {
    name: '垂直位置 (%)',
    exact: true,
  });
  await position.fill('45');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 90000,
  });
  const video = path.join(output, 'completion_subtitled.mp4');
  assert.ok((await fs.stat(video)).size > 0);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    video,
    '-f',
    'null',
    '-',
  ]);
  const draft = () =>
    page.evaluate(
      () =>
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('smartsub_compose_draft_v1:'))
          .map(([, value]) => JSON.parse(value))[0],
    );
  assert.equal((await draft()).dirty, false);
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/?$/);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.evaluate((route) => window.next.router.push(route), route);
  await expect(
    page.getByRole('button', { name: '高级设置', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(position).toHaveValue('45');
  await position.fill('55');
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page).toHaveURL(/subtitleMerge/);
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(position).toHaveValue('55');
  checks.push(
    'Real FFmpeg export saves settings; route change is unblocked, reopen retains settings, later edits remain guarded',
  );
  await page.screenshot({
    path: path.join(output, 'compose-edited-after-export.png'),
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(
    JSON.stringify({ output, checks, errors, failure: String(error) }),
  );
  throw error;
} finally {
  await app.close();
}
