import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-context-glossary-e2e-'),
);
const profile = path.join(output, 'profile');
const source = path.join(output, 'terms.en.srt');
const target = path.join(output, 'terms.zh.srt');
const srt = (lines) =>
  lines
    .map(
      (text, index) =>
        `${index + 1}\n00:00:0${index * 2},000 --> 00:00:0${index * 2 + 1},800\n${text}\n`,
    )
    .join('\n');
await fs.writeFile(
  source,
  srt(['Alice meets Bob.', 'Alice calls Bob.', 'Alice and Bob.']),
);
await fs.writeFile(
  target,
  srt(['Alice 遇见 Bob。', 'Alice 呼叫 Bob。', 'Alice 和 Bob。']),
);
const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        id: 'fixture',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '术语测试译文。' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
let lockedDirectory;
let configPath;
const checks = [];
const glossaryDialog = () => page.getByRole('dialog');
const list = () => page.evaluate(() => window.ipc.invoke('glossaries:list'));
async function launch() {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
}
async function navigate(url) {
  const navigated = await page.evaluate(
    (url) =>
      window.next.router.push(url).catch((error) => {
        if (error.cancelled) return false;
        throw error;
      }),
    url,
  );
  if (!navigated) {
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
}
async function openEditor(id) {
  await navigate(`/zh/proofread/?workItem=${id}`);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('Alice meets Bob.', { exact: true }).click();
  await expect(page.locator('#subtitle-src-0')).toBeVisible();
}
async function selectTerm(field, term) {
  const input = page.locator(`#subtitle-${field}-0`);
  await input.focus();
  await input.press('Home');
  const value = await input.inputValue();
  const start = value.indexOf(term);
  assert.ok(start >= 0);
  for (let i = 0; i < start; i++) await input.press('ArrowRight');
  for (let i = 0; i < term.length; i++) await input.press('Shift+ArrowRight');
  await expect(page.locator('[data-glossary-bubble]')).toBeVisible();
  await page.locator('[data-glossary-bubble]').click();
  await expect(glossaryDialog()).toBeVisible();
}
async function fillTerm(targetText, sourceText) {
  if (sourceText)
    await glossaryDialog()
      .getByRole('textbox', { name: '原文', exact: true })
      .fill(sourceText);
  await glossaryDialog()
    .getByRole('textbox', { name: '目标译词 / 标准写法', exact: true })
    .fill(targetText);
}
async function closeSaved() {
  await glossaryDialog()
    .getByRole('button', { name: '保留字幕不变', exact: true })
    .click();
  await expect(glossaryDialog()).toHaveCount(0);
}
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const tasks = await page.evaluate(
    async ({ source, target, url }) => {
      window.ipc.send('setTranslationProviders', [
        {
          id: 'glossary-fixture',
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
      await window.ipc.invoke('getTranslationProviders');
      const ids = [];
      for (const name of ['Project A', 'Project B']) {
        const result = await window.ipc.invoke('createProofreadTask', {
          name,
          items: [
            {
              sourceSubtitlePath: source,
              targetSubtitlePath: target,
              sourceLanguage: 'en',
              targetLanguage: 'zh',
            },
          ],
        });
        if (!result.success) throw new Error(JSON.stringify(result));
        ids.push(result.data.id);
      }
      return ids;
    },
    { source, target, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  for (const directory of [profile, `${profile}-dev`]) {
    const candidate = path.join(directory, 'config.json');
    if (
      await fs.stat(candidate).then(
        () => true,
        () => false,
      )
    )
      configPath = candidate;
  }
  assert.ok(configPath);
  await openEditor(tasks[0]);
  await selectTerm('src', 'Alice');
  await fillTerm('艾丽丝');
  await expect(
    glossaryDialog().getByRole('combobox', { name: '生效范围', exact: true }),
  ).toContainText('仅当前项目生效');
  await glossaryDialog()
    .getByRole('button', { name: '保存术语', exact: true })
    .click();
  await expect(glossaryDialog().getByRole('status')).toContainText('3 处匹配');
  const first = (await list()).find((g) => g.projectId === tasks[0]);
  assert.equal(first.entries[0].target, '艾丽丝');
  const disk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(
    disk.glossaries.find((g) => g.id === first.id).entries[0].target,
    '艾丽丝',
  );
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith('http:'))
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
    await page.screenshot({ path: path.join(output, `glossary-${width}.png`) });
  }
  await glossaryDialog()
    .getByRole('button', { name: '批量更新', exact: true })
    .click();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    '艾丽丝 遇见 Bob。',
  );
  await expect(page.locator('#subtitle-src-0')).toHaveValue('Alice meets Bob.');
  await page.locator('#subtitle-tgt-0').focus();
  await page.keyboard.press('Meta+z');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue('Alice 遇见 Bob。');
  await page.keyboard.press('Meta+Shift+z');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    '艾丽丝 遇见 Bob。',
  );
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  assert.equal((await fs.readFile(target, 'utf8')).match(/艾丽丝/g).length, 3);
  assert.ok((await fs.readFile(source, 'utf8')).includes('Alice meets Bob.'));
  checks.push(
    'keyboard selection bubble, project persistence, replacement preview, translation-only bulk edit, single undo/redo, real disk output, 1024/1440 layout',
  );

  await selectTerm('src', 'Alice');
  await fillTerm('爱丽丝');
  await glossaryDialog()
    .getByRole('button', { name: '保存术语', exact: true })
    .click();
  await expect(glossaryDialog().getByRole('alert')).toContainText('艾丽丝');
  assert.equal(
    (await list()).find((g) => g.id === first.id).entries[0].target,
    '艾丽丝',
  );
  await glossaryDialog()
    .getByRole('button', { name: '覆盖已有译词', exact: true })
    .click();
  await expect(glossaryDialog().getByRole('heading')).toHaveText(
    '更新匹配字幕',
  );
  await closeSaved();
  assert.equal(
    (await list()).find((g) => g.id === first.id).entries[0].target,
    '爱丽丝',
  );
  checks.push(
    'conflict preserves existing term until explicit overwrite confirmation',
  );

  await selectTerm('tgt', 'Bob');
  await fillTerm('鲍勃', 'Bob');
  await glossaryDialog()
    .getByRole('combobox', { name: '生效范围', exact: true })
    .click();
  await page.getByRole('option', { name: '全局生效', exact: true }).click();
  if (process.platform !== 'win32') {
    lockedDirectory = path.dirname(configPath);
    await fs.chmod(lockedDirectory, 0o500);
    await glossaryDialog()
      .getByRole('button', { name: '保存术语', exact: true })
      .click();
    await expect(glossaryDialog().getByRole('alert')).toContainText('EACCES');
    assert.equal(
      (await list()).some((g) => !g.projectId),
      false,
    );
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
  }
  await glossaryDialog()
    .getByRole('button', { name: '保存术语', exact: true })
    .click();
  await expect(glossaryDialog().getByRole('status')).toContainText('3 处匹配');
  await closeSaved();
  assert.equal(
    (await list()).find((g) => !g.projectId).entries[0].target,
    '鲍勃',
  );
  checks.push(
    'target-column selection, global scope, persistent disk failure, rollback and retry',
  );

  await selectTerm('src', 'Alice');
  await fillTerm('Discard me');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(
    glossaryDialog().getByRole('textbox', {
      name: '目标译词 / 标准写法',
      exact: true,
    }),
  ).toHaveValue('Discard me');
  await glossaryDialog()
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.getByRole('button', { name: '放弃术语', exact: true }).click();
  await expect(glossaryDialog()).toHaveCount(0);
  checks.push('unfinished term dismissal confirmation retains entered text');

  const toolbar = page.locator('[data-ai-toolbar]');
  await toolbar.getByRole('button', { name: 'AI 优化', exact: true }).click();
  await expect(page.locator('[data-ai-review="ready"]')).toHaveCount(1);
  assert.ok(JSON.stringify(requests.at(-1)).includes('爱丽丝'));
  assert.ok(JSON.stringify(requests.at(-1)).includes('鲍勃'));
  await page
    .locator('[data-ai-review]')
    .getByRole('button', { name: '忽略', exact: true })
    .click();
  await openEditor(tasks[1]);
  await toolbar.getByRole('button', { name: 'AI 优化', exact: true }).click();
  await expect(page.locator('[data-ai-review="ready"]')).toHaveCount(1);
  assert.equal(JSON.stringify(requests.at(-1)).includes('爱丽丝'), false);
  assert.ok(JSON.stringify(requests.at(-1)).includes('鲍勃'));
  await page
    .locator('[data-ai-review]')
    .getByRole('button', { name: '忽略', exact: true })
    .click();
  checks.push(
    'actual AI HTTP requests contain owning-project and global terms, exclude another project',
  );
  await app.close();
  app = undefined;
  await launch();
  assert.equal((await list()).length, 2);
  await openEditor(tasks[0]);
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    '艾丽丝 遇见 Bob。',
  );
  checks.push(
    'application restart preserves glossary scope and saved subtitles',
  );
  await page.getByRole('button', { name: '完成并返回', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Project A', exact: true }),
  ).toBeVisible();
  const transcriptDirectory = path.join(output, 'transcript-only');
  await fs.mkdir(transcriptDirectory);
  const transcript = path.join(transcriptDirectory, 'transcript.srt');
  await fs.writeFile(transcript, srt(['Clara speaks.', 'Clara responds.']));
  await navigate(`/zh/proofread/?file=${encodeURIComponent(transcript)}`);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('Clara speaks.', { exact: true }).click();
  await selectTerm('src', 'Clara');
  await fillTerm('Klara');
  await glossaryDialog()
    .getByRole('button', { name: '保存术语', exact: true })
    .click();
  await expect(glossaryDialog().getByRole('status')).toContainText('2 处匹配');
  const transcriptGlossary = (await list()).find((g) =>
    g.entries.some((entry) => entry.source === 'Clara'),
  );
  assert.ok(transcriptGlossary.projectId);
  assert.equal(
    (
      await page.evaluate(
        (id) => window.ipc.invoke('getProofreadTaskById', { id }),
        transcriptGlossary.projectId,
      )
    ).success,
    true,
  );
  await glossaryDialog()
    .getByRole('button', { name: '批量更新', exact: true })
    .click();
  await expect(page.locator('#subtitle-src-0')).toHaveValue('Klara speaks.');
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect
    .poll(async () =>
      (await fs.readFile(transcript, 'utf8')).includes('Klara speaks.'),
    )
    .toBe(true);
  checks.push(
    'unsaved batch automatically gets a durable project; transcript bulk replacement updates source and disk',
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
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
