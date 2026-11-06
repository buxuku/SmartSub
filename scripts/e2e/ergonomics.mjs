import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { appOrigin, waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-ergonomics-e2e-'),
);
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
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss();
});
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) =>
  errors.push({ url: page.url(), message: error.message }),
);
const report = [];
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const routes = [
    'home',
    'download',
    'tasks/generate-translate',
    'tasks/generate',
    'tasks/translate',
    'proofread',
    'subtitleMerge',
    'dubbing',
    'recent-tasks',
    'toolbox',
    ...[
      'subtitle-converter',
      'video-trimmer',
      'audio-extractor',
      'embedded-subtitles',
      'subtitle-sync',
      'bilingual-subtitles',
      'video-compressor',
      'video-to-gif',
    ].map((tool) => `toolbox/?tool=${tool}`),
    'engines',
    'translation',
    'glossary',
    'ttsServices',
    'settings',
  ];
  const origin = appOrigin(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => localStorage.setItem('theme', theme), theme);
    for (const [width, height] of [
      [1024, 700],
      [1440, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()
            .find((window) => /^(app:|http:)/.test(window.webContents.getURL()))
            .setContentSize(...size),
        [width, height],
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      for (const route of routes) {
        await page.goto(
          `${origin}/zh/${route}${route.includes('?') ? '' : '/'}`,
        );
        await expect(page.locator('main')).not.toBeEmpty();
        await expect(page.locator('html')).toHaveClass(new RegExp(theme));
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const layout = await page.evaluate(() => {
          const issues = [];
          for (const element of document.querySelectorAll(
            'main button, main input, main [role="combobox"], main [role="tab"], aside a',
          )) {
            const rect = element.getBoundingClientRect();
            if (
              !rect.width ||
              !rect.height ||
              getComputedStyle(element).visibility === 'hidden'
            )
              continue;
            let left = 0,
              right = innerWidth,
              top = 0,
              bottom = innerHeight;
            let scrollableX = false,
              scrollableY = false;
            for (
              let parent = element.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const bounds = parent.getBoundingClientRect();
              if (
                ['auto', 'scroll'].includes(style.overflowX) &&
                parent.scrollWidth > parent.clientWidth + 1
              )
                scrollableX = true;
              if (
                ['auto', 'scroll'].includes(style.overflowY) &&
                parent.scrollHeight > parent.clientHeight + 1
              )
                scrollableY = true;
              if (style.overflowX !== 'visible') {
                left = Math.max(left, bounds.left);
                right = Math.min(right, bounds.right);
              }
              if (style.overflowY !== 'visible') {
                top = Math.max(top, bounds.top);
                bottom = Math.min(bottom, bounds.bottom);
              }
            }
            if (
              (!scrollableX &&
                (rect.left < left - 2 || rect.right > right + 2)) ||
              (!scrollableY && (rect.top < top - 2 || rect.bottom > bottom + 2))
            ) {
              issues.push({
                tag: element.tagName,
                label:
                  element.getAttribute('aria-label') ||
                  element.textContent?.trim() ||
                  element.getAttribute('title'),
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                clip: { left, right, top, bottom },
                scrollableX,
                scrollableY,
              });
            }
          }
          return {
            documentOverflow: document.documentElement.scrollWidth > innerWidth,
            issues,
          };
        });
        const name = `${theme}-${width}-${route.replace(/[^a-z0-9-]/gi, '_')}`;
        await page.screenshot({
          path: path.join(output, `${name}.png`),
          animations: 'disabled',
        });
        report.push({ route, theme, width, height, ...layout });
        console.log(JSON.stringify(report.at(-1)));
      }
    }
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ report, errors }, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      views: report.length,
      errors,
      issues: report.filter(
        (item) => item.issues.length || item.documentOverflow,
      ),
    }),
  );
  assert.deepEqual(errors, []);
  assert.ok(
    report.every((item) => !item.documentOverflow && !item.issues.length),
  );
} finally {
  await app.close();
}
