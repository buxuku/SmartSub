import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-launchpad-e2e-'),
);
const media =
  process.env.SMARTSUB_E2E_VIDEO ||
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4';
await fs.access(media);
let requests = 0;
let fail = false;
const server = http.createServer((_request, response) => {
  requests++;
  if (fail) response.writeHead(503).end('test download failure');
  // The held connection exercises real downloader cancellation, not an IPC stub.
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;
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
const key = 'smartsub_task_wizard_draft_v1';
const checks = [];
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow, dialog }) => {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.closeDevTools();
  dialog.showMessageBoxSync = () => 0;
});
const origin = new URL(page.url()).origin;
async function readDraft() {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
}
async function nativeDrop(target, files = [media]) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box);
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data: { items: [], files, dragOperationsMask: 1 },
      });
    }
  } finally {
    await cdp.detach();
  }
}
async function pendingDownloads() {
  return page.evaluate(
    async () =>
      (await window.ipc.invoke('getSystemInfo', null)).downloadingModels,
  );
}
try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const recipe = {
    id: 'install-recipe',
    name: 'Installer complete recipe',
    accepts: 'media',
    goals: { translate: true, dub: true, video: true },
    config: {
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      scenarioPreset: 'custom',
      fasterWhisperBeamSize: 7,
      gates: { subtitle: 'auto', dubbing: 'manual' },
      dub: {
        engine: { kind: 'cloud', providerId: 'unconfigured-test-tts' },
        voice: 'alloy',
        language: 'en',
        globalSpeed: 1.25,
      },
      compose: { subtitle: 'soft', videoQuality: 'high', encoderMode: 'cpu' },
    },
  };
  await page.evaluate(
    async ({ recipe, mirror }) => {
      await window.ipc.invoke('recipes:save', recipe);
      await window.ipc.invoke('setSettings', {
        downloadEndpoints: { huggingFaceMirror: mirror },
      });
    },
    { recipe, mirror },
  );
  await page.reload();
  await page.evaluate(() =>
    sessionStorage.setItem(
      'wizard:droppedFiles',
      JSON.stringify([
        {
          uuid: 'stale',
          filePath: '/stale-handoff.mp4',
          fileName: 'stale-handoff',
        },
      ]),
    ),
  );
  await nativeDrop(page.locator('[data-drop-recipe="install-recipe"]'));
  const install = page.getByRole('dialog', { name: '需要语音识别模型' });
  await expect(install).toBeVisible();
  const before = await readDraft();
  assert.equal(before.files[0].filePath, media);
  assert.deepEqual(before.goals, recipe.goals);
  assert.equal(before.config.sourceLanguage, 'ja');
  assert.equal(before.pipeline.recipeName, recipe.name);
  assert.equal(before.pipeline.dubbing.globalSpeed, 1.25);
  assert.equal(before.pipeline.subtitleGate, false);
  checks.push(
    'native recipe drop durably saves all configuration before installation',
  );

  const start = install.getByRole('button', {
    name: '一键安装并继续',
    exact: true,
  });
  await start.click();
  await expect.poll(() => requests).toBeGreaterThan(0);
  await expect(start).toBeDisabled();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('http:'),
    );
    win.webContents.send('downloadProgress', 'large-v3', 0.92);
  });
  await expect(
    install.getByText('正在下载模型 (0%)…', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.ipc.invoke('cancelModelDownload', { requestId: 'not-the-owner' }),
  );
  assert.deepEqual(await pendingDownloads(), ['base']);
  await install.getByRole('button', { name: '暂不下载', exact: true }).click();
  await expect(install).toHaveCount(0);
  await expect.poll(pendingDownloads).toEqual([]);
  await expect(page).toHaveURL(/\/home\//);
  assert.deepEqual(await readDraft(), before);
  checks.push(
    'unrelated progress ignored; owner-scoped cancellation preserves draft and stays on home',
  );

  await nativeDrop(
    page.getByRole('heading', { name: '最近任务', exact: true }),
  );
  await expect(page.getByRole('alertdialog')).toBeVisible();
  assert.deepEqual(await readDraft(), before);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await readDraft(), before);
  await nativeDrop(
    page.getByRole('heading', { name: '最近任务', exact: true }),
  );
  await page.getByRole('button', { name: '追加到原草稿', exact: true }).click();
  await expect(install).toBeVisible();
  assert.equal((await readDraft()).files.length, 1);
  assert.equal((await readDraft()).id, before.id);
  fail = true;
  await start.click();
  await expect(install.getByRole('alert')).toBeVisible({ timeout: 90000 });
  await expect(start).toBeEnabled();
  assert.equal((await readDraft()).pipeline.recipeName, recipe.name);
  checks.push(
    'existing draft cancel/add preserve intent, deduplicate files; HTTP failure remains visible and retryable',
  );

  // This is an actual upstream Base download through the production downloader.
  await install
    .getByRole('radio', { name: 'Hugging Face', exact: true })
    .click();
  await start.click();
  await expect(page).toHaveURL(
    new RegExp(`/tasks/new/?\\?draft=${before.id}$`),
    { timeout: 240000 },
  );
  await expect(
    page.getByText(path.basename(media), { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect
    .poll(async () => (await readDraft())?.pipeline)
    .toEqual(before.pipeline);
  const restored = await readDraft();
  assert.deepEqual(restored.goals, recipe.goals);
  assert.equal(restored.config.sourceLanguage, 'ja');
  assert.equal(restored.config.targetLanguage, 'en');
  assert.equal(restored.config.fasterWhisperBeamSize, 7);
  assert.equal(restored.config.transcriptionEngine, 'builtin');
  assert.equal(restored.config.model, 'base');
  assert.equal(restored.id, before.id);
  await expect(page.getByText('未安装本地模型', { exact: true })).toHaveCount(
    0,
  );
  const info = await page.evaluate(() =>
    window.ipc.invoke('getSystemInfo', null),
  );
  const modelPath = path.join(info.modelsPath, 'ggml-base.bin');
  assert.equal((await fs.stat(modelPath)).size, 147951465);
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(modelPath))
      .digest('hex'),
    '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  );
  checks.push(
    'real Base download checksum verified; automatic exact draft restoration without recovery prompt',
  );
  await page.screenshot({ path: path.join(output, 'restored-recipe.png') });

  await page.goto(`${origin}/zh/home/`);
  await nativeDrop(
    page.getByRole('heading', { name: '最近任务', exact: true }),
  );
  await page
    .getByRole('button', { name: '替换草稿并新建', exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks\/new\/?\?draft=/);
  await expect
    .poll(async () => (await readDraft())?.goals)
    .toEqual({ translate: false, dub: false, video: false });
  assert.notEqual((await readDraft()).id, before.id);
  assert.equal((await readDraft()).pipeline.recipeName, null);
  checks.push(
    'explicit replace creates independent intent without stale recipe goals',
  );

  await page.goto(`${origin}/zh/home/`);
  await page.evaluate((key) => {
    localStorage.removeItem(key);
    const original = Storage.prototype.setItem;
    window.__restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key)
        throw new DOMException('Test quota', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, key);
  await page.reload();
  // Reload clears the injected failure; install it again before the first import.
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    window.__restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key)
        throw new DOMException('Test quota', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, key);
  await nativeDrop(
    page.getByRole('heading', { name: '最近任务', exact: true }),
  );
  await expect(
    page.getByRole('alert').filter({ hasText: '草稿未能保存到磁盘' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/home\//);
  await page.evaluate(() => window.__restoreStorage());
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new\/?\?draft=/);
  await expect.poll(async () => (await readDraft())?.files?.length).toBe(1);
  checks.push(
    'storage failure prevents navigation; successful retry restores memory snapshot',
  );

  await page.goto(`${origin}/zh/home/`);
  await page.evaluate(
    (key) => localStorage.setItem(key, '{corrupt draft'),
    key,
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await expect(
    page.getByRole('alertdialog', { name: '草稿无法读取' }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    '{corrupt draft',
  );
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '草稿无法读取' }),
  ).toBeVisible();
  await page.evaluate(
    ({ key, before }) => localStorage.setItem(key, JSON.stringify(before)),
    { key, before },
  );
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect
    .poll(async () => (await readDraft())?.pipeline)
    .toEqual(before.pipeline);

  await page.goto(`${origin}/zh/home/`);
  await page.evaluate(
    (key) => localStorage.setItem(key, '{corrupt draft'),
    key,
  );
  await page.reload();
  await nativeDrop(
    page.getByRole('heading', { name: '最近任务', exact: true }),
  );
  await expect(
    page.getByRole('button', { name: '追加到原草稿', exact: true }),
  ).toBeDisabled();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    '{corrupt draft',
  );
  await page
    .getByRole('button', { name: '替换草稿并新建', exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks\/new\/?\?draft=/);
  await expect.poll(async () => (await readDraft())?.files?.length).toBe(1);
  checks.push(
    'corrupt draft never overwritten by autosave; retry recovers repaired data and explicit replace remains available',
  );
  for (const [recipeId, slug] of [
    ['builtin-generate', 'generate'],
    ['builtin-generate-translate', 'generate-translate'],
  ]) {
    await page.goto(`${origin}/zh/home/`);
    const previousDraft = await readDraft();
    await nativeDrop(page.locator(`[data-drop-recipe="${recipeId}"]`));
    await expect(page).toHaveURL(new RegExp(`/tasks/${slug}/?\\?project=`));
    const projectId = new URL(page.url()).searchParams.get('project');
    const project = await page.evaluate(
      (id) => window.ipc.invoke('getTaskProject', id),
      projectId,
    );
    assert.equal(project.files[0].filePath, media);
    assert.deepEqual(await readDraft(), previousDraft);
  }
  checks.push(
    'ready builtin task shortcuts persist real projects without replacing an unrelated wizard draft',
  );
  console.log(JSON.stringify({ success: true, output, modelPath, checks }));
} catch (error) {
  console.error(JSON.stringify({ output, checks, url: page.url() }));
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await app.close();
}
