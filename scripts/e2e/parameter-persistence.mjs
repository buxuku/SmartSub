import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-parameter-e2e-'),
);
const profile = path.join(evidence, 'profile');
let app;
let page;
let locked;
try {
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
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.closeDevTools();
      window.setSize(1024, 700);
    });
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(async () => {
    window.ipc.send('setTranslationProviders', [
      {
        id: 'openai',
        type: 'openai',
        name: 'Parameter test',
        isAi: true,
        apiKey: '',
        apiUrl: 'http://127.0.0.1:9',
        modelName: 'test',
      },
    ]);
    await window.ipc.invoke('getTranslationProviders');
    const result = await window.ipc.invoke('config-manager:save', 'openai', {
      headerParameters: {},
      bodyParameters: { temperature: 0.7 },
      configVersion: '1.2.0',
      lastModified: 1,
    });
    if (result?.success !== true)
      throw new Error(result?.error || 'seed failed');
    await window.next.router.push('/zh/translation/');
  });
  await page.getByText('Parameter test', { exact: true }).first().click();
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /自定义参数配置/ });
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  const input = dialog
    .getByRole('row')
    .filter({ has: page.getByText('temperature', { exact: true }) })
    .getByRole('textbox');
  await expect(input).toHaveValue('0.7');
  for (const directory of [profile, `${profile}-dev`]) {
    const candidate = path.join(directory, 'parameter-configs');
    if (
      await fs
        .stat(path.join(candidate, 'configurations.json'))
        .catch(() => false)
    )
      locked = candidate;
  }
  assert.ok(locked);
  const file = path.join(locked, 'configurations.json');
  const original = await fs.readFile(file, 'utf8');
  await fs.chmod(locked, 0o555);
  await input.fill('0.2');
  await input.press('Tab');
  await expect(dialog.getByRole('alert')).toContainText('尚未保存');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('尚未保存');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(
    (
      await page.evaluate(() =>
        window.ipc.invoke('config-manager:get', 'openai'),
      )
    ).bodyParameters.temperature,
    0.7,
  );
  await page.screenshot({ path: path.join(evidence, 'save-failed.png') });
  await fs.chmod(locked, 0o755);
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByText('已保存', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  await expect(input).toHaveValue('0.2');
  await input.fill('0.4');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.equal(
    JSON.parse(await fs.readFile(file, 'utf8')).openai.config.bodyParameters
      .temperature,
    0.4,
  );
  await page.reload();
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  await expect(input).toHaveValue('0.4');
  await input.fill('0.5');
  await input.press('Escape');
  await expect(dialog).not.toBeVisible();
  assert.equal(
    JSON.parse(await fs.readFile(file, 'utf8')).openai.config.bodyParameters
      .temperature,
    0.5,
  );
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  const body = dialog.getByRole('tabpanel');
  await body.locator('input[data-draft-field="key"]').fill('max_tokens');
  await body.locator('input[data-draft-field="key"]').press('Escape');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('请输入参数值后再保存。', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('tab', { name: /请求头/ }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  await expect(body.locator('input[data-draft-field="key"]')).toHaveValue(
    'max_tokens',
  );
  await body.locator('input[data-draft-field="value"]').fill('500');
  await body.locator('input[data-draft-field="value"]').press('Escape');
  await expect(dialog).not.toBeVisible();
  assert.equal(
    JSON.parse(await fs.readFile(file, 'utf8')).openai.config.bodyParameters
      .max_tokens,
    500,
  );
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  await fs.chmod(locked, 0o555);
  await input.fill('0.6');
  await page.evaluate(async () => {
    try {
      await window.next.router.push('/zh/home/');
    } catch {}
  });
  const guard = page.getByRole('alertdialog');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: /保存.*离开/ }).click();
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(/translation/);
  await fs.chmod(locked, 0o755);
  await guard.getByRole('button', { name: /保存.*离开/ }).click();
  await expect(page).toHaveURL(/home/);
  assert.equal(
    JSON.parse(await fs.readFile(file, 'utf8')).openai.config.bodyParameters
      .temperature,
    0.6,
  );
  await page.evaluate(() => window.next.router.push('/zh/translation/'));
  await page.getByRole('button', { name: '配置参数', exact: true }).click();
  await dialog.getByRole('tab', { name: /请求体/ }).click();
  await page.screenshot({ path: path.join(evidence, 'saved-reloaded.png') });
  console.log(`Parameter UI persistence passed: ${evidence}`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(evidence, 'failure.png') })
      .catch(() => {});
  console.error(`Evidence: ${evidence}`);
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o755).catch(() => {});
  if (app) await app.close();
}
