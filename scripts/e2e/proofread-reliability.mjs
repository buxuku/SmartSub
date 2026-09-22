import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-proofread-e2e-'),
);
const subtitleDirectory = path.join(output, 'subtitles');
await fs.mkdir(subtitleDirectory);
const source = path.join(subtitleDirectory, 'review.srt');
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:03,000\nReview original.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond subtitle.\n',
);
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(output, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.on('dialog', (dialog) => {
  // Electron owns beforeunload through will-prevent-unload; it does not expose
  // a browser dialog for Playwright's automatic dismiss to handle.
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow, dialog }) => {
  globalThis.nativeConfirmations = [];
  globalThis.nativeResponse = 1;
  dialog.showMessageBoxSync = (...args) => {
    globalThis.nativeConfirmations.push(args.at(-1).title);
    return globalThis.nativeResponse;
  };
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.closeDevTools(),
  );
});
page.setDefaultTimeout(12000);
const origin = new URL(page.url()).origin;
const route = `/zh/proofread/?file=${encodeURIComponent(source)}`;
const marker = 'Saved by SmartSub real Electron E2E.';

try {
  await page.goto(`${origin}/zh/home/`);
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(() => window.next.router.push('/zh/toolbox/'));
  await page.getByRole('link', { name: '校对', exact: true }).click();
  // Use the real Next router to preserve a previous history entry for popstate tests.
  await page.evaluate((url) => window.next.router.push(url), route);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await page.evaluate(
    (url) => window.next.router.push(`${url}&view=forward`),
    route,
  );
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(`${origin}${route}`);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('Review original.', { exact: true }).click();
  await page.locator('textarea').fill(marker);
  await expect(
    page.getByRole('status').filter({ hasText: '未保存的修改' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue(marker);
  assert.equal(
    await page.locator('nextjs-portal [data-nextjs-dialog]').count(),
    0,
  );

  const currentUrl = page.url();
  const historyBefore = await page.evaluate(() => history.length);
  assert.ok(
    await page.evaluate(() => history.state.smartsubGuardIndex >= 2),
    'multi-entry history fixture',
  );
  await page.evaluate(() => history.back());
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(page).toHaveURL(currentUrl);
  assert.equal(
    await page.evaluate(() => history.length),
    historyBefore,
    'Cancel back must not add history entries',
  );
  await expect(page.locator('textarea')).toHaveValue(marker);

  await page.evaluate(() => history.forward());
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(page).toHaveURL(currentUrl);
  assert.equal(await page.evaluate(() => history.length), historyBefore);
  await expect(page.locator('textarea')).toHaveValue(marker);

  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.evaluate(() => {
    window.historyEvidence = [];
    window.addEventListener('popstate', (event) =>
      window.historyEvidence.push({
        index: event.state?.smartsubGuardIndex,
        url: location.href,
      }),
    );
  });
  for (const directions of [[-1, -1], [-2]]) {
    await page.evaluate((deltas) => {
      for (const delta of deltas) history.go(delta);
    }, directions);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await expect(page).toHaveURL(currentUrl);
    assert.equal(
      await page.evaluate(() => history.length),
      historyBefore,
      'rapid history cancellation preserves entries',
    );
    await expect(page.locator('textarea')).toHaveValue(marker);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }

  await page.evaluate((url) => {
    void window.next.router.push(`${url}&other=task`).catch(() => {});
  }, route);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(page).toHaveURL(currentUrl);
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  );
  await page.getByRole('option', { name: '启动台', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue(marker);

  const nativeBefore = await app.evaluate(
    () => globalThis.nativeConfirmations.length,
  );
  await page.evaluate(() => location.reload());
  await expect
    .poll(() => app.evaluate(() => globalThis.nativeConfirmations.length))
    .toBe(nativeBefore + 1);
  assert.equal(
    await page.evaluate(() => document.querySelector('textarea')?.value),
    marker,
  );
  await app.evaluate(({ app }) => app.quit());
  await expect
    .poll(() => app.evaluate(() => globalThis.nativeConfirmations.length))
    .toBe(nativeBefore + 2);
  assert.equal(
    await page.evaluate(() => document.querySelector('textarea')?.value),
    marker,
  );
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
    .toBe(nativeBefore + 3);
  assert.equal(
    await page.evaluate(() => document.querySelector('textarea')?.value),
    marker,
  );

  // Simulate the user's response to the native Electron confirmation, while
  // exercising the real will-prevent-unload handler and durable localStorage.
  await app.evaluate(() => {
    globalThis.nativeResponse = 0;
  });
  await page.reload();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByText(marker, { exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue(marker);
  if (process.platform !== 'win32') await fs.chmod(subtitleDirectory, 0o500);
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  // Both the imported batch and subtitle have dirty guards. A successful batch
  // save must not hide a failed subtitle save or allow navigation.
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  if (process.platform !== 'win32') {
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(
      page
        .getByRole('alert', { includeHidden: true })
        .filter({ hasText: 'EACCES' }),
    ).toBeVisible();
    await expect(page).toHaveURL(currentUrl);
    assert.match(await fs.readFile(source, 'utf8'), /Review original\./);
    const batches = await page.evaluate(
      async () => (await window.ipc.invoke('getProofreadTasks')).data,
    );
    assert.ok(
      batches.length >= 2,
      'batch guard saved before subtitle guard failed',
    );
    await page.screenshot({
      path: path.join(output, 'multiple-guards-save-failure.png'),
    });
    await fs.chmod(subtitleDirectory, 0o700);
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/zh\/home\/?$/);
  assert.match(
    await fs.readFile(source, 'utf8'),
    /Saved by SmartSub real Electron E2E\./,
  );
  console.log(
    JSON.stringify({
      success: true,
      output,
      checks: [
        'sidebar cancel',
        'back/forward cancel preserves history',
        'rapid consecutive history and multi-entry back cancellation',
        'query navigation guard',
        'command palette guard',
        'native reload/quit/window-close cancel',
        'reload recovery',
        'multiple dirty guards with real write failure and retry',
        'real IPC save to disk',
        'clean navigation',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('E2E evidence:', output);
  console.error(
    'History evidence:',
    await page.evaluate(() => window.historyEvidence),
  );
  throw error;
} finally {
  if (process.platform !== 'win32') await fs.chmod(subtitleDirectory, 0o700);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await app.close();
}
