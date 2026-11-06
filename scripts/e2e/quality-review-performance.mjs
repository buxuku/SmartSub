import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-quality-perf-'),
);
const source = path.join(output, 'large.en.srt'),
  target = path.join(output, 'large.zh.srt');
const stamp = (s) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const srt = (fn) =>
  Array.from(
    { length: 10000 },
    (_, i) => `${i + 1}\n${stamp(i * 3)} --> ${stamp(i * 3 + 2)}\n${fn(i)}\n`,
  ).join('\n');
await fs.writeFile(
  source,
  srt((i) => `term${i % 500} works.`),
);
await fs.writeFile(
  target,
  srt(() => '正常工作。'),
);
let app, page;
const errors = [];
try {
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await waitForAppPage(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, target }) => {
      const g = await window.ipc.invoke('glossaries:create', {
        name: '500 terms',
      });
      for (let i = 0; i < 500; i++) {
        const saved = await window.ipc.invoke('glossaries:save-entry', {
          glossaryId: g.data.id,
          entry: { source: `term${i}`, target: `术语${i}` },
        });
        if (!saved.success) throw new Error(JSON.stringify(saved));
      }
      const task = await window.ipc.invoke('createProofreadTask', {
        name: '10000 subtitles',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
          },
        ],
      });
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, target },
  );
  const start = performance.now();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await expect(page.getByRole('tab', { name: /建议检查/ })).toContainText(
    '10000',
  );
  const loadAndCheckMs = performance.now() - start;
  assert.ok(
    loadAndCheckMs < 2000,
    `initial load and check ${loadAndCheckMs}ms`,
  );
  const recheckStart = performance.now();
  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(
    page.locator('[data-quality-tabs]').getByText('正在检查…', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-quality-tabs]').getByText('正在检查…', { exact: true }),
  ).toHaveCount(0);
  const checkMs = performance.now() - recheckStart;
  assert.ok(checkMs < 2000, `recheck ${checkMs}ms`);
  await page.getByRole('tab', { name: /建议检查/ }).click();
  const input = page.locator('#subtitle-tgt-0');
  await expect(input).toBeVisible();
  const samples = [];
  for (let i = 0; i < 16; i++) {
    samples.push(
      await input.evaluate(async (el, i) => {
        const start = performance.now();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        ).set;
        setter.call(el, `测试译文${i}`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      }, i),
    );
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  await expect(input).toHaveValue('测试译文15');
  assert.ok(p95 < 100, `input p95 ${p95}`);
  await page.screenshot({ path: path.join(output, '10000-review.png') });
  const report = {
    output,
    loadAndCheckMs,
    checkMs,
    inputP95: p95,
    inputMax: samples.at(-1),
    errors,
  };
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.equal(errors.length, 0);
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
  await app?.close();
}
