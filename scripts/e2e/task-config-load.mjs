import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { appOrigin, waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-task-config-e2e-'),
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
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
page.setDefaultTimeout(20000);
const errors = [];
const checks = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const expected = await page.evaluate(async () => {
    const config = await window.ipc.invoke('getUserConfig');
    const saved = await window.ipc.invoke('saveTaskProject', {
      id: 'config-recovery',
      name: 'Saved configuration',
      taskType: 'generateOnly',
      files: [],
      taskDraft: {
        config: { ...config, targetLanguage: 'ja' },
        manuscripts: [],
      },
      preserveTaskProgress: true,
    });
    if (!saved?.id) throw new Error('fixture save failed');
    return config;
  });
  await app.evaluate(({ ipcMain }) => {
    globalThis.configFault = 'reject';
    globalThis.configReads = 0;
    globalThis.configWrites = 0;
    const original = ipcMain._invokeHandlers.get('getUserConfig');
    ipcMain.removeHandler('getUserConfig');
    ipcMain.handle('getUserConfig', async (...args) => {
      globalThis.configReads++;
      if (globalThis.configFault === 'reject')
        throw new Error('Injected task configuration read failure');
      if (globalThis.configFault === 'malformed') return null;
      return original(...args);
    });
    ipcMain.on('setUserConfig', () => globalThis.configWrites++);
  });
  const origin = appOrigin(page);
  for (const [route, message] of [
    ['tasks/new', '任务配置读取失败'],
    ['tasks/generate', '任务草稿读取失败'],
  ]) {
    await page.goto(`${origin}/zh/${route}/`);
    const alert = page.getByRole('alert').filter({ hasText: message });
    await expect(alert).toBeVisible();
    await alert.locator('summary').click();
    await expect(alert).toContainText(
      'Injected task configuration read failure',
    );
    await expect(page.getByTestId('task-inspector')).toHaveCount(0);
    await app.evaluate(() => {
      globalThis.configFault = 'malformed';
    });
    await alert.getByRole('button', { name: '重新读取' }).click();
    await expect(alert).toContainText('INVALID_USER_CONFIG_RESPONSE');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => /^(app:|http:)/.test(window.webContents.getURL()))
        .setContentSize(1024, 700);
    });
    await page.screenshot({
      path: path.join(output, `${route.replace('/', '-')}-failed.png`),
      animations: 'disabled',
    });
    await app.evaluate(() => {
      globalThis.configFault = '';
    });
    await alert.getByRole('button', { name: '重新读取' }).click();
    await expect(page.getByTestId('task-inspector')).toBeVisible();
    await app.evaluate(() => {
      globalThis.configFault = 'reject';
    });
  }
  checks.push(
    'Wizard and new project block editing on rejected/malformed defaults, show persistent details, retry to actual configuration',
  );
  const before = await app.evaluate(() => globalThis.configReads);
  await page.goto(`${origin}/zh/tasks/generate/?project=config-recovery`);
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  assert.equal(
    await app.evaluate(() => globalThis.configReads),
    before,
    'saved project never reads broken defaults',
  );
  const item = await page.evaluate(() =>
    window.ipc.invoke('getWorkItem', 'config-recovery'),
  );
  assert.equal(item.taskDraft.config.targetLanguage, 'ja');
  assert.equal(await app.evaluate(() => globalThis.configWrites), 0);
  await app.evaluate(() => {
    globalThis.configFault = '';
  });
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getUserConfig')),
    expected,
  );
  checks.push(
    'Saved project restores its own config while defaults fail; no global preference writes',
  );
  await app.evaluate(({ ipcMain }) => {
    for (const channel of [
      'getSystemInfo',
      'getTranslationProviders',
      'getAsrProviders',
      'getSettings',
    ]) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => {
        if (globalThis.dependencyFault === channel)
          throw new Error(`Injected dependency failure: ${channel}`);
        return original(...args);
      });
    }
  });
  for (const route of [
    'tasks/new',
    'tasks/generate/?project=config-recovery',
  ]) {
    for (const channel of [
      'getSystemInfo',
      'getTranslationProviders',
      'getAsrProviders',
      'getSettings',
    ]) {
      await app.evaluate((_electron, channel) => {
        globalThis.dependencyFault = channel;
      }, channel);
      await page.goto(`${origin}/zh/${route}${route.includes('?') ? '' : '/'}`);
      const alert = page
        .getByRole('alert')
        .filter({ hasText: '任务配置读取失败' });
      await expect(alert).toBeVisible();
      await alert.locator('summary').click();
      await expect(alert).toContainText(
        `Injected dependency failure: ${channel}`,
      );
      await expect(page.getByTestId('task-inspector')).toHaveCount(0);
      await app.evaluate(() => {
        globalThis.dependencyFault = '';
      });
      await alert.getByRole('button', { name: '重新读取' }).click();
      await expect(page.getByTestId('task-inspector')).toBeVisible();
    }
  }
  checks.push(
    'Both task entry points block incomplete system/provider/settings reads and recover each dependency without unhandled errors',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error({ output, checks, errors });
  throw error;
} finally {
  await app
    .evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.destroy());
    })
    .catch(() => {});
  await app.close().catch(() => {});
}
