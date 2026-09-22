import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-font-menu-e2e-'),
);
const video = path.join(output, 'menu.mp4');
const subtitle = path.join(output, 'menu.srt');
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
  '-pix_fmt',
  'yuv420p',
  video,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:02,000\nSmartSub font menu\n',
);
const checks = [],
  pageErrors = [],
  metrics = [];
let app, page;
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
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
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
  const installed = await page.evaluate(() =>
    window.ipc.invoke('subtitleMerge:listFonts'),
  );
  assert.equal(installed.success, true);
  const source = installed.data.find(
    (font) => font.available && font.sampleRuns?.length,
  );
  assert.ok(source, 'at least one actual system font sample is required');
  // UI scale fixture uses real sample faces; filesystem discovery is tested separately.
  const names = Array.from(
    { length: 1200 },
    (_, i) => `Font fixture ${String(i).padStart(4, '0')}`,
  );
  const options = names.map((name) => ({ ...source, name }));
  await app.evaluate(({ ipcMain }, options) => {
    globalThis.fontMenuMode = 'ok';
    globalThis.fontMenuPending = false;
    const channel = 'subtitleMerge:listFonts';
    const original = ipcMain._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing production font handler');
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => {
      const mode = globalThis.fontMenuMode;
      if (mode === 'error') throw new Error('Injected font listing failure');
      if (mode === 'delayed') {
        globalThis.fontMenuPending = true;
        await new Promise((resolve) => {
          globalThis.releaseFontMenu = resolve;
        });
        globalThis.fontMenuPending = false;
      }
      return { success: true, data: options };
    });
  }, options);
  const select = page.getByRole('combobox', { name: '字体', exact: true });
  const search = page.getByRole('combobox', { name: '搜索字体', exact: true });
  const list = page.getByTestId('font-list');
  const sampleFaces = () =>
    page.evaluate(
      () =>
        Array.from(document.fonts).filter((face) =>
          face.family.startsWith('SmartSub-font-'),
        ).length,
    );
  const assertBounded = async () => {
    const count = await page.getByRole('option').count();
    assert.ok(count > 0 && count <= 12, `bounded rendered options: ${count}`);
    assert.ok((await sampleFaces()) < 40, 'bounded sample FontFace resources');
  };
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      globalThis.fontLongTasks = [];
      globalThis.fontObserver = new PerformanceObserver((list) => {
        globalThis.fontLongTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      });
      globalThis.fontObserver.observe({ type: 'longtask', buffered: false });
    });
    const started = performance.now();
    await select.click();
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(
      page.locator(`[data-font-sample="${names[0]}"]`),
    ).toHaveAttribute('data-font-loaded', 'true');
    const openMs = performance.now() - started;
    await assertBounded();
    await search.press('End');
    await expect(
      page.locator(`[data-font-sample="${names.at(-1)}"]`),
    ).toHaveAttribute('data-font-loaded', 'true');
    await expect
      .poll(() =>
        search.evaluate(
          (el) =>
            document.getElementById(el.getAttribute('aria-activedescendant'))
              ?.textContent,
        ),
      )
      .toContain(names.at(-1));
    await assertBounded();
    await search.press('Home');
    await list.hover();
    await page.mouse.wheel(0, 640 * 50);
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(10000);
    await assertBounded();
    await search.fill('fOnT fixture 1199');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option')).toContainText(names.at(-1));
    await search.fill('no matching installed family');
    await expect(page.getByText('没有匹配的字体')).toBeVisible();
    await search.fill('Font fixture 11');
    await expect(page.locator('[data-font-sample]').first()).toHaveAttribute(
      'data-font-loaded',
      'true',
    );
    await assertBounded();
    const geometry = await page.evaluate(() => {
      const menu = document
        .querySelector('[data-radix-popper-content-wrapper]')
        .getBoundingClientRect();
      return {
        x: menu.x,
        y: menu.y,
        right: menu.right,
        bottom: menu.bottom,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(
      geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.right <= width + 1 &&
        geometry.bottom <= height + 1,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.overflow <= 1, 'no page-level horizontal overflow');
    await page.screenshot({ path: path.join(output, `menu-${width}.png`) });
    const longTasks = await page.evaluate(() => {
      globalThis.fontObserver.disconnect();
      return globalThis.fontLongTasks;
    });
    assert.ok(openMs < 3000, `opening large list: ${openMs}ms`);
    assert.ok(
      Math.max(0, ...longTasks) < 500,
      `large menu long tasks: ${longTasks}`,
    );
    metrics.push({ width, openMs, longTasks });
    await search.press('Escape');
    await expect(list).not.toBeVisible();
    await expect(select).toBeFocused();
    await expect.poll(sampleFaces).toBe(0);
  }
  checks.push(
    '1200-option virtualization, real wheel scroll, Home/End focus, search, empty results, viewport bounds and FontFace release',
  );
  await app.evaluate(() => {
    globalThis.fontMenuMode = 'error';
  });
  await select.click();
  const alert = page.getByRole('alert').filter({ hasText: '字体列表读取失败' });
  await expect(alert).toBeVisible();
  await search.press('End');
  await search.press('Enter');
  await expect(list).toBeVisible();
  await app.evaluate(() => {
    globalThis.fontMenuMode = 'delayed';
  });
  await alert.getByRole('button', { name: '重试预览' }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.fontMenuPending))
    .toBe(true);
  await expect(list).toHaveAttribute('aria-busy', 'true');
  await search.press('End');
  await search.press('Enter');
  await expect(list).toBeVisible();
  await app.evaluate(() => {
    globalThis.releaseFontMenu();
  });
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect(alert).not.toBeVisible();
  await search.press('End');
  await search.press('Enter');
  await expect(select).toHaveText(names.at(-1));
  await expect(list).not.toBeVisible();
  await expect.poll(sampleFaces).toBe(0);
  checks.push(
    'IPC failure remains visible, retry works, selection blocked during failure/loading, keyboard selection succeeds after completion',
  );
  assert.deepEqual(pageErrors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ output, checks, metrics, pageErrors }, null, 2),
  );
  console.log(JSON.stringify({ output, checks, metrics }));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error({ output, pageErrors });
  throw error;
} finally {
  if (app) await app.close();
}
