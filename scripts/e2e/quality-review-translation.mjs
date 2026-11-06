import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-quality-translation-'),
);
const source = path.join(output, 'review.en.srt'),
  target = path.join(output, 'review.zh.srt');
const time = '00:00:01,000 --> 00:00:03,000';
await fs.writeFile(source, `1\n${time}\nHello.\n`);
await fs.writeFile(target, `1\n${time}\n[翻译失败: test]\n`);
let hold = false,
  requests = 0;
const held = [];
const prompts = [];
let failOriginal = false;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(body.messages.some((m) => m.content.includes('Hello.')));
    const prompt = body.messages.map((m) => m.content).join('\n');
    prompts.push(prompt);
    if (prompt.includes('ORIGINAL_FIXTURE') && failOriginal)
      return response
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            error: { message: 'Original fixture unavailable' },
          }),
        );
    requests++;
    const send = () =>
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'quality-fixture',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: prompt.includes('ORIGINAL_FIXTURE')
                  ? 'Hello. Corrected original.'
                  : JSON.stringify({ 1: { src: 'Hello.', tr: '你好。' } }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    if (hold) held.push(send);
    else send();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page;
const errors = [];
try {
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await waitForAppPage(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, target, url }) => {
      window.ipc.send('setTranslationProviders', [
        {
          id: 'quality-fixture',
          name: 'Local fixture',
          type: 'openai',
          isAi: true,
          apiUrl: url,
          apiKey: 'test-only',
          modelName: 'fixture',
          prompt: '${content}',
          requestInterval: 0,
        },
      ]);
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Translation review',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
          },
        ],
      });
      await window.next.router.push(`/en/proofread/?workItem=${task.data.id}`);
    },
    { source, target, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  await page.getByRole('button', { name: 'Proofread', exact: true }).click();
  await page.getByRole('tab', { name: /Suggested checks/ }).click();
  const retry = page.getByRole('button', {
    name: 'Retranslate line',
    exact: true,
  });
  const field = page.locator('#subtitle-tgt-0'),
    review = page.locator('[data-ai-review]');
  await retry.click();
  await expect(review).toHaveAttribute('data-ai-review', 'ready');
  await expect(field).toHaveValue('[翻译失败: test]');
  await expect(review).toContainText('你好。');
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('你好。');
  // Revert the accepted edit, then change the source while the response is held.
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(field).toHaveValue('[翻译失败: test]');
  hold = true;
  await retry.click();
  await expect.poll(() => held.length).toBe(1);
  await field.fill('My manual translation.');
  held.shift()();
  await expect(
    page.locator('[data-quality-detail] [role="alert"]'),
  ).toBeVisible();
  await expect(field).toHaveValue('My manual translation.');
  await expect(review).toHaveCount(0);
  // A cancelled response cannot become a proposal either.
  await retry.click();
  await expect.poll(() => held.length).toBe(1);
  await page
    .locator('[data-quality-detail]')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  held.shift()();
  await expect(retry).toBeEnabled();
  await expect(review).toHaveCount(0);
  await expect(field).toHaveValue('My manual translation.');
  // A timing change removes the old anchor but must keep the current editor mounted.
  await page
    .locator('#subtitle-0')
    .getByRole('button', { name: /#1 ·/ })
    .click();
  const times = page.locator('#subtitle-0 input');
  await times.nth(1).fill('00:00:04,000');
  await times.nth(1).press('Enter');
  await expect(field).toHaveValue('My manual translation.');
  await field.fill('Continue after timing edit.');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Continue after timing edit.');
  hold = false;
  const original = page.locator('#subtitle-src-0');
  await original.fill('Hello. ' + 'Words to review. '.repeat(8));
  await expect(
    page.locator('[data-quality-tabs]').getByText('Checking…', { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Issue type', { exact: true }).selectOption('speed');
  await page
    .locator('[data-quality-detail]')
    .getByRole('button', { name: 'Original', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'AI editing settings', exact: true })
    .click();
  await page
    .getByLabel('Prompt applies to', { exact: true })
    .selectOption('sourceContent');
  await page.getByRole('combobox', { name: 'Operation', exact: true }).click();
  await page.getByRole('option', { name: 'AI shorten', exact: true }).click();
  const customPrompt = page.getByRole('textbox', {
    name: 'Optimization Prompt',
    exact: true,
  });
  await customPrompt.fill(
    'ORIGINAL_FIXTURE correct this original: {{sourceText}}',
  );
  await page.keyboard.press('Escape');
  failOriginal = true;
  await page
    .getByRole('button', { name: 'AI edit original', exact: true })
    .click();
  await expect(review).toHaveAttribute('data-ai-review', 'error');
  assert.ok(prompts.at(-1).includes('ORIGINAL_FIXTURE'));
  failOriginal = false;
  await review.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(review).toHaveAttribute('data-ai-review', 'ready');
  assert.ok(
    prompts.at(-1).includes('ORIGINAL_FIXTURE'),
    'retry keeps the original prompt',
  );
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(original).toHaveValue('Hello. Corrected original.');
  await expect(field).toHaveValue('Continue after timing edit.');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, 'english-1024.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    JSON.stringify({
      output,
      requests,
      checks: [
        'real local provider',
        'diff before acceptance',
        'stale edit rejection',
        'cancellation',
        'original custom settings and failed retry',
        'English 1024',
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
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
