import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-quality-e2e-'),
);
const source = path.join(output, 'review.en.srt'),
  target = path.join(output, 'review.zh.srt');
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:03,000\nAn API works.\n\n2\n00:00:04,000 --> 00:00:06,000\nHello.\n\n3\n00:00:07,000 --> 00:00:09,000\nDone.\n',
);
await fs.writeFile(
  target,
  '1\n00:00:01,000 --> 00:00:03,000\n一个服务正常工作。\n\n2\n00:00:04,000 --> 00:00:06,000\n[翻译失败: test]\n\n3\n00:00:07,000 --> 00:00:09,000\n完成。\n',
);
const errors = [];
const runMode = process.argv.includes('--development')
  ? 'development'
  : 'production';
let app, page;
try {
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: runMode },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await waitForAppPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const taskId = await page.evaluate(
    async ({ source, target }) => {
      const glossary = await window.ipc.invoke('glossaries:create', {
        name: 'Review terms',
      });
      await window.ipc.invoke('glossaries:save-entry', {
        glossaryId: glossary.data.id,
        entry: { source: 'API', target: '接口' },
      });
      const result = await window.ipc.invoke('createProofreadTask', {
        name: 'Quality review',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
          },
        ],
      });
      if (!result?.success) throw new Error(JSON.stringify(result));
      await window.next.router.push(
        `/zh/proofread/?workItem=${result.data.id}`,
      );
      return result.data.id;
    },
    { source, target },
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await expect(page.getByRole('tab', { name: /建议检查/ })).toContainText('2');
  await page.getByRole('tab', { name: /建议检查/ }).click();
  const detail = page.locator('[data-quality-detail]');
  await expect(detail).toContainText('未采用词库');
  await detail.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await page.getByLabel('处理状态', { exact: true }).selectOption('skipped');
  await expect(detail).toContainText('暂时跳过');
  await detail.getByRole('button', { name: '恢复待检查', exact: true }).click();
  await page.getByLabel('处理状态', { exact: true }).selectOption('pending');
  await detail.getByRole('button', { name: '确认无误', exact: true }).click();
  await expect(detail).toContainText('已确认');
  await page.screenshot({ path: path.join(output, 'confirmed-1440.png') });
  await page.getByRole('button', { name: '下一处', exact: true }).click();
  await expect(detail).toContainText('译文为空');
  const field = page.locator('#subtitle-tgt-1');
  await field.fill('你好。');
  await expect(field).toHaveValue('你好。');
  await expect(detail).toContainText('已修复');
  assert.equal(
    await field.evaluate((el) => el === document.activeElement),
    true,
    'typing keeps focus',
  );
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByText('字幕文件已保存', { exact: true }).first(),
  ).toBeVisible();
  assert.match(await fs.readFile(target, 'utf8'), /你好。/);
  const review = await page.evaluate(
    async ({ source, target }) =>
      window.ipc.invoke(
        'qualityReview:read',
        `smartsub_proofread_draft_v1:${JSON.stringify(['', source, target])}`,
      ),
    { source, target },
  );
  assert.equal(review.success, true);
  assert.equal(Object.values(review.data.decisions)[0].status, 'confirmed');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, 'fixed-1024.png') });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false);
  await page.reload();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await expect(page.locator('[data-quality-panel]')).toBeVisible();
  await expect(page.locator('#subtitle-tgt-1')).toHaveValue('你好。');
  // Real filesystem failure, retry, and abrupt renderer process recovery.
  const reviewDirectory = path.join(
    await app.evaluate(({ app }) => app.getPath('userData')),
    'quality-reviews',
  );
  await fs.rename(reviewDirectory, reviewDirectory + '.backup');
  await fs.writeFile(reviewDirectory, 'blocked');
  if (!(await page.getByLabel('处理状态', { exact: true }).isVisible()))
    await page.getByRole('button', { name: /问题列表/ }).click();
  await page.getByLabel('处理状态', { exact: true }).selectOption('processed');
  if (
    await page
      .getByRole('button', { name: '返回当前问题', exact: true })
      .isVisible()
  )
    await page
      .getByRole('button', { name: '返回当前问题', exact: true })
      .click();
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '保存失败' }),
  ).toBeVisible();
  await fs.unlink(reviewDirectory);
  await fs.rename(reviewDirectory + '.backup', reviewDirectory);
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByText('字幕文件已保存', { exact: true }).first(),
  ).toBeVisible();
  await page.locator('#subtitle-tgt-1').fill('恢复最新文本');
  const killed = app;
  app = undefined;
  killed.process().kill('SIGKILL');
  await new Promise((resolve) => killed.process().once('exit', resolve));
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: runMode },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await waitForAppPage(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  await page.evaluate(
    async (taskId) =>
      window.next.router.push(`/zh/proofread/?workItem=${taskId}`),
    taskId,
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  const recovery = page.getByRole('alertdialog');
  await expect(recovery).toBeVisible();
  await recovery.getByRole('button', { name: /恢复/ }).click();
  await expect(page.locator('#subtitle-tgt-1')).toHaveValue('恢复最新文本');
  await page.getByRole('button', { name: '完成并返回', exact: true }).click();
  await expect(page.locator('[data-quality-panel]')).toHaveCount(0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    JSON.stringify({
      output,
      taskId,
      checks: [
        'local checks',
        'glossary',
        'confirm',
        'pinned editing',
        'save',
        'reload',
        '1024 layout',
        'complete',
        'real write failure and retry',
        'SIGKILL draft recovery',
      ],
      errors,
    }),
  );
} catch (error) {
  if (page) {
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
  console.error(output);
  throw error;
} finally {
  // A relaunched app must not leave the suite waiting on a native quit prompt.
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 0;
    })
    .catch(() => {});
  await app?.close();
}
