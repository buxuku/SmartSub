import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-batch-save-e2e-'),
);
const source = path.join(evidence, 'batch.srt');
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:02,000\nBatch save test\n',
);
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(evidence, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
page.setDefaultTimeout(15000);
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.closeDevTools(),
  ),
);
const origin = new URL(page.url()).origin;
try {
  await page.goto(`${origin}/zh/proofread/?file=${encodeURIComponent(source)}`);
  await expect(
    page.getByRole('button', { name: '跳过', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  const task = await page.evaluate(async () =>
    (await window.ipc.invoke('getProofreadTasks')).data.find(
      (task) => task.name === 'batch',
    ),
  );
  assert.ok(task?.id);
  await page.evaluate(
    async (id) => window.ipc.invoke('deleteProofreadTask', { taskId: id }),
    task.id,
  );
  await page.getByRole('heading', { name: 'batch', exact: true }).click();
  await page.getByPlaceholder('输入任务名称').fill('Edited after deletion');
  await page.keyboard.press('Escape');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Proofread task no longer exists' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '保存失败' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page).toHaveURL(/proofread/);
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '保存失败' }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'failure-retained.png') });
  console.log(
    JSON.stringify({
      success: true,
      evidence,
      checks: [
        'real batch creation',
        'missing task update is failure',
        'auto-save failure remains visible',
        'failed save blocks navigation',
        'manual retry does not fake success',
      ],
    }),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(evidence, 'unexpected-failure.png'),
  });
  console.error('Batch save evidence:', evidence);
  throw error;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await app.close();
}
