import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-wizard-e2e-'));
const media =
  process.env.SMARTSUB_E2E_VIDEO ||
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4';
await fs.access(media);
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
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.closeDevTools(),
  ),
);
const origin = new URL(page.url()).origin;
const key = 'smartsub_task_wizard_draft_v1';

try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const expected = await page.evaluate(
    async ({ key, media }) => {
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      });
      const config = await window.ipc.invoke('getUserConfig');
      const draft = {
        files,
        goals: { translate: true, dub: true, video: true },
        manualPairs: [],
        manualManuscriptPairs: [],
        config: {
          ...config,
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          scenarioPreset: 'custom',
          fasterWhisperBeamSize: 7,
        },
        pipeline: {
          dubbing: {
            engineKey: '',
            voice: '',
            globalSpeed: 1.25,
            language: 'en',
          },
          subtitle: 'soft',
          styleId: 'classic',
          quality: 'original',
          encoder: 'cpu',
          subtitleGate: false,
          dubbingGate: true,
          recipeName: 'Review recovery',
        },
        savedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(draft));
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({ engineKey: 'workbench-only', globalSpeed: 0.75 }),
      );
      return { config: { fasterWhisperBeamSize: 7 }, pipeline: draft.pipeline };
    },
    { key, media },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(
    page.getByText('demo.mp4', { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).pipeline,
        key,
      ),
    )
    .toEqual(expected.pipeline);
  await page.getByRole('button', { name: '专家参数', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const width of [1024, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().startsWith('devtools:'),
      );
      win.setSize(width, width === 1024 ? 700 : 900);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const inspector = page.getByTestId('task-inspector');
    await inspector.scrollIntoViewIfNeeded();
    const inspectorBounds = await inspector.boundingBox();
    assert.ok(inspectorBounds);
    const controls = inspector.locator('button,a');
    for (let index = 0; index < (await controls.count()); index++) {
      const control = controls.nth(index);
      const box = await control.boundingBox();
      assert.ok(
        box &&
          box.x >= inspectorBounds.x - 1 &&
          box.x + box.width <= inspectorBounds.x + inspectorBounds.width + 1,
        `${width}: inspector control is clipped`,
      );
      if (await control.isEnabled()) await control.click({ trial: true });
    }
    await page.screenshot({ path: path.join(output, `wizard-${width}.png`) });
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.width + 1,
      `Page overflows at ${width}: ${JSON.stringify(size)}`,
    );
  }
  await page.getByRole('link', { name: '引擎', exact: true }).click();
  await expect(page).toHaveURL(/\/zh\/engines\/?$/);
  await page.evaluate(() => window.next.router.push('/zh/tasks/new/'));
  await page.evaluate((draftKey) => {
    const original = Storage.prototype.setItem;
    window.restoreDraftStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === draftKey)
        throw new DOMException(
          'Test draft storage quota exceeded',
          'QuotaExceededError',
        );
      return original.call(this, key, value);
    };
  }, key);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '草稿未写入本地存储' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '引擎', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page).toHaveURL(/tasks\/new/);
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await page.evaluate(() => window.restoreDraftStorage());
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '草稿未写入本地存储' }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).pipeline,
        key,
      ),
    )
    .toEqual(expected.pipeline);
  assert.equal(
    await page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem(key)).config.fasterWhisperBeamSize,
      key,
    ),
    7,
  );
  await page.reload();
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('dubbingConfig')),
    ),
    { engineKey: 'workbench-only', globalSpeed: 0.75 },
    'wizard recovery and changes never overwrite workbench preferences',
  );
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .toBeNull();
  console.log(
    JSON.stringify({
      success: true,
      output,
      checks: [
        'explicit recovery',
        'complete pipeline configuration',
        'dubbing workbench preference isolation',
        'expert parameters accessible',
        '1024 and 1440 page bounds',
        'every inspector control is visible and hit-testable at both widths',
        'configuration detour',
        'storage quota failure banner and navigation guard',
        'retry after storage recovery',
        'reload and discard',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('Wizard E2E evidence:', output);
  throw error;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await app.close();
}
