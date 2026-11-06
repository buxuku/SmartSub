import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-inline-ai-e2e-'),
);
const source = path.join(output, 'review.ja.srt');
const target = path.join(output, 'review.fr.srt');
const srt = (lines) =>
  lines
    .map(
      (text, index) =>
        `${index + 1}\n00:00:0${index * 2},000 --> 00:00:0${index * 2 + 1},800\n${text}\n`,
    )
    .join('\n');
await fs.writeFile(
  source,
  srt(['First original.', 'Second original.', 'Third original.']),
);
await fs.writeFile(
  target,
  srt(['Premier texte.', 'Deuxieme texte.', 'Troisieme texte.']),
);
const requests = [];
let fail = false;
let hold = false;
const held = [];
let serial = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.find(
      (message) => message.role === 'user',
    ).content;
    requests.push(prompt);
    const send = () => {
      if (fail)
        return response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Fixture unavailable' } }));
      const marker = 'Subtitles to optimize:\n';
      const batch = prompt.includes(marker)
        ? JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length))
        : null;
      const content = batch
        ? JSON.stringify(
            Object.fromEntries(
              Object.keys(batch).map((id) => [
                id,
                prompt.includes('fewer characters')
                  ? `Short ${id}.`
                  : `Batch ${id} improved.`,
              ]),
            ),
          )
        : prompt.includes('fewer characters')
          ? 'Bref.'
          : `Texte ameliore ${++serial}.`;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    };
    if (hold) held.push(send);
    else send();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
const checks = [];
try {
  app = await _electron.launch({
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
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, target, url }) => {
      window.ipc.send('setTranslationProviders', [
        {
          id: 'inline-fixture',
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
        name: 'Inline AI review',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'ja',
            targetLanguage: 'fr',
          },
        ],
      });
      if (!task?.success) throw new Error(JSON.stringify(task));
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, target, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('First original.', { exact: true }).click();
  const toolbar = page.locator('[data-ai-toolbar]');
  const runAi = async (name) => {
    await toolbar.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await page
      .locator('[data-ai-actions]')
      .getByRole('button', { name, exact: true })
      .click();
  };
  const row = (index) => page.locator(`#subtitle-${index}`);
  const review = (index) => row(index).locator('[data-ai-review]');
  await runAi('AI 优化');
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(review(0).locator('del')).not.toHaveCount(0);
  await expect(review(0).locator('ins')).not.toHaveCount(0);
  assert.ok(requests[0].includes('Original text (ja)'));
  assert.ok(requests[0].includes('Output language: fr'));
  await review(0).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Texte ameliore 1.',
  );
  await expect(review(0)).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue('Premier texte.');
  await page.keyboard.press('Meta+Shift+z');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Texte ameliore 1.',
  );
  checks.push(
    'real provider HTTP, file languages, red/green inline diff, Enter accept and undo/redo',
  );
  await runAi('AI 缩短');
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  await expect(review(0).locator('[data-ai-diff="proposed"]')).toContainText(
    'Bref.',
  );
  await page.locator('#subtitle-tgt-0').focus();
  await page.keyboard.press('Enter');
  await expect(review(0)).toHaveCount(1);
  await review(0).focus();
  await page.keyboard.press('Escape');
  await expect(review(0)).toHaveCount(0);
  checks.push('shorten intent, input Enter remains editing, Esc ignore');
  hold = true;
  await runAi('AI 优化');
  await expect.poll(() => held.length).toBe(1);
  await page.locator('#subtitle-tgt-0').fill('Manual edit while waiting.');
  held.shift()();
  hold = false;
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  await expect(review(0).getByRole('alert')).toContainText('已过期');
  await expect(
    review(0).getByRole('button', { name: '采纳', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Manual edit while waiting.',
  );
  await review(0).getByRole('button', { name: '忽略', exact: true }).click();
  checks.push('concurrent edit cannot be overwritten by a stale result');
  await runAi('全文 AI 优化');
  await expect(page.locator('[data-ai-review="ready"]')).toHaveCount(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(output, `inline-ai-${width}.png`),
    });
  }
  await review(0).getByRole('button', { name: '采纳', exact: true }).click();
  await review(1).focus();
  await page.keyboard.press('Enter');
  await review(2).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-ai-review]')).toHaveCount(0);
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  const saved = await fs.readFile(target, 'utf8');
  assert.ok(
    saved.includes('Batch 1 improved.') &&
      saved.includes('Batch 2 improved.') &&
      saved.includes('Troisieme texte.'),
  );
  checks.push(
    'batch per-row accept/ignore and actual subtitle disk output, 1024/1440 layout',
  );
  await page.locator('#subtitle-src-0').click();
  fail = true;
  await runAi('AI 优化');
  await expect(review(0)).toHaveAttribute('data-ai-review', 'error');
  await expect(review(0).getByRole('alert')).toBeVisible();
  fail = false;
  await review(0).getByRole('button', { name: '重试', exact: true }).click();
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  await review(0).getByRole('button', { name: '忽略', exact: true }).click();
  hold = true;
  await runAi('AI 优化');
  await expect.poll(() => held.length).toBe(1);
  await toolbar.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('[data-ai-review]')).toHaveCount(0);
  held.shift()();
  hold = false;
  await runAi('AI 优化');
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  checks.push(
    'persistent service failure, retry, cancellation and fresh request',
  );
  await review(0).getByRole('button', { name: '忽略', exact: true }).click();
  await page.locator('#subtitle-tgt-0').fill('a'.repeat(37));
  await expect(row(0).locator('[data-subtitle-health]')).toHaveAttribute(
    'data-cps-warning',
    'true',
  );
  await expect(row(0).locator('[data-subtitle-health]')).toContainText(
    '20.6 CPS',
  );
  await page.locator('#subtitle-tgt-0').fill('a'.repeat(36));
  await expect(row(0).locator('[data-subtitle-health]')).toHaveAttribute(
    'data-cps-warning',
    'false',
  );
  await toolbar.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  await page
    .getByRole('button', { name: '高级设置（可选）', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: '全文处理时，每次发送', exact: true })
    .fill('1');
  await page.keyboard.press('Escape');
  hold = true;
  await runAi('全文 AI 优化');
  await expect.poll(() => held.length).toBe(1);
  held.shift()();
  await expect(review(0)).toHaveAttribute('data-ai-review', 'ready');
  await expect(review(1)).toHaveAttribute('data-ai-review', 'loading');
  await review(0).getByRole('button', { name: '采纳', exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  await toolbar.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('[data-ai-review]')).toHaveCount(0);
  held.shift()();
  hold = false;
  await runAi('全文 AI 缩短');
  await expect(page.locator('[data-ai-review="ready"]')).toHaveCount(3);
  await expect(review(0).locator('[data-ai-diff="proposed"]')).toContainText(
    'Short 1.',
  );
  checks.push(
    'live CPS threshold, editable batch size, streamed review before batch completion, partial cancellation and batch shortening',
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error(JSON.stringify({ output, checks }));
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-6500));
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
