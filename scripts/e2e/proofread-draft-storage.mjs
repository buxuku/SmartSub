import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-draft-storage-e2e-'),
);
const profile = path.join(output, 'profile');
const directory = path.join(profile, 'proofread-drafts');
const held = `${directory}.held`;
const source = path.join(output, 'source.srt');
const key = `smartsub_proofread_draft_v1:${JSON.stringify(['', source, ''])}`;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
await fs.writeFile(
  source,
  '1\n00:00:00,000 --> 00:00:03,000\nOriginal subtitle.\n',
);
const app = await _electron.launch({
  args: [
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${profile}`,
  ],
  env: {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  },
});
const page = await app.firstWindow();
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const read = () =>
  page.evaluate((key) => window.ipc.proofreadDraft.read(key), key);
const enter = () =>
  page.getByRole('button', { name: '校对', exact: true }).click();
const input = page.locator('#subtitle-src-0');
const blockDisk = async () => {
  await fs.rename(directory, held);
  await fs.writeFile(directory, 'Not a directory');
};
const repairDisk = async () => {
  await fs.unlink(directory);
  await fs.rename(held, directory);
};
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(async (source) => {
    const task = await window.ipc.invoke('createProofreadTask', {
      name: 'Draft disk failures',
      items: [{ sourceSubtitlePath: source, sourceLanguage: 'en' }],
    });
    if (!task.success) throw new Error(JSON.stringify(task));
    await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
  }, source);
  await enter();
  await page.getByText('Original subtitle.', { exact: true }).click();
  await input.fill('First native draft');
  assert.equal(
    JSON.parse((await read()).raw).subtitles[0].sourceContent,
    'First native draft',
  );
  await blockDisk();
  await input.fill('Pending edit after disk failure');
  const warning = page.getByRole('alert').filter({ hasText: '草稿存储失败' });
  await expect(warning).toBeVisible();
  assert.equal((await read()).success, false);
  const snapshot = (await fs.readdir(held)).find((name) =>
    name.endsWith('.json'),
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(held, snapshot), 'utf8'))
      .subtitles[0].sourceContent,
    'First native draft',
  );
  await repairDisk();
  await input.fill('Recovered latest draft');
  await expect(warning).toHaveCount(0);
  const recovered = (await read()).raw;
  assert.equal(
    JSON.parse(recovered).subtitles[0].sourceContent,
    'Recovered latest draft',
  );

  await blockDisk();
  await page.reload();
  await waitForAppPage(page);
  await enter();
  const loadError = page
    .getByRole('alert')
    .filter({ hasText: '字幕数据加载失败' });
  await expect(loadError).toBeVisible();
  await expect(
    page.getByRole('button', { name: '保存字幕', exact: true }),
  ).toHaveCount(0);
  await repairDisk();
  await loadError
    .getByRole('button', { name: '重新加载', exact: true })
    .click();
  const recovery = page.getByRole('alertdialog');
  await expect(recovery).toBeVisible();
  await blockDisk();
  await recovery.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('alert')).toContainText('草稿存储失败');
  await repairDisk();
  await recovery.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByText('Recovered latest draft', { exact: true }).click();
  await expect(input).toHaveValue('Recovered latest draft');
  await input.fill('Saved final draft');
  await input.press(`${modifier}+s`);
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  assert.ok((await fs.readFile(source, 'utf8')).includes('Saved final draft'));
  assert.equal((await read()).raw, 'null');

  // Simulate a legacy Chromium removal that never reached disk.
  await page.evaluate(
    ({ key, recovered }) => localStorage.setItem(key, recovered),
    { key, recovered },
  );
  await page.reload();
  await waitForAppPage(page);
  await enter();
  await expect(
    page.getByText('Saved final draft', { exact: true }),
  ).toBeVisible();
  await expect(recovery).toHaveCount(0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'saved.png') });
  const result = {
    success: true,
    output,
    checks: [
      'Real filesystem write failure preserves previous snapshot and latest editor text',
      'Repair and next edit persist the latest draft',
      'Draft read failure blocks save and load retry offers recovery',
      'Failed discard keeps recovery dialog and visible error; repair restores latest draft',
      'Explicit save writes real SRT and native tombstone prevents stale legacy resurrection',
    ],
  };
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(JSON.stringify({ output, errors, failure: String(error) }));
  throw error;
} finally {
  await app.close();
}
