import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage, appOrigin } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-engine-settings-e2e-'),
);
const profile = path.join(output, 'profile');
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${profile}`,
  ],
  env: {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss();
});
const checks = [];
let lockedDirectory;
const status = () => page.locator('[data-settings-persistence]');
const failure = () => status().getByRole('alert');
const saved = () => expect(status().getByRole('status')).toHaveText('已保存');
const command = () =>
  page.getByRole('textbox', { name: 'Whisper 命令', exact: true });
const cli = () => page.getByRole('button', { name: /^本地命令行 / }).click();
async function size(width, height, name) {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()
        .find((window) => /^(http:|app:)/.test(window.webContents.getURL()))
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
    path: path.join(output, `${name}-${width}.png`),
    animations: 'disabled',
  });
}
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(() =>
    window.ipc.invoke('setSettings', {
      whisperCommand: 'fixture-original-command',
      useLocalWhisper: false,
      fasterWhisperDevice: 'auto',
      fasterWhisperComputeType: 'auto',
    }),
  );
  const configPath = path.join(profile, 'config.json');
  const disk = async () =>
    JSON.parse(await fs.readFile(configPath, 'utf8')).settings;
  assert.equal((await disk()).whisperCommand, 'fixture-original-command');
  await app.evaluate(({ ipcMain }) => {
    globalThis.engineSettingsReadFault = true;
    globalThis.asrReadFault = false;
    globalThis.engineSettingsSaveFault = '';
    globalThis.engineStatusCalls = 0;
    globalThis.engineStatusReadFault = false;
    globalThis.engineModelReadFault = false;
    for (const channel of [
      'getSettings',
      'getAsrProviders',
      'setSettings',
      'get-engine-status',
      'getSystemInfo',
    ]) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        if (channel === 'get-engine-status' && globalThis.engineStatusReadFault)
          throw new Error('Injected engine status failure');
        if (
          channel === 'getSystemInfo' &&
          globalThis.engineModelReadFault &&
          args[0].sender.getURL().includes('/engines')
        )
          throw new Error('Injected model status failure');
        if (
          channel === 'getSettings' &&
          globalThis.engineSettingsReadFault &&
          args[0].sender.getURL().includes('/engines')
        )
          throw new Error('Injected engine settings read failure');
        if (channel === 'getAsrProviders' && globalThis.asrReadFault)
          throw new Error('Injected cloud provider read failure');
        if (
          channel === 'setSettings' &&
          globalThis.engineSettingsSaveFault === 'reject'
        )
          return { rejectedKeys: Object.keys(args[1]) };
        if (
          channel === 'setSettings' &&
          globalThis.engineSettingsSaveFault === 'malformed'
        )
          return { success: true };
        const result = await original(...args);
        if (channel === 'get-engine-status') {
          globalThis.engineStatusCalls++;
          // Only expose installed-only controls; configuration writes remain real.
          return {
            ...result,
            fasterWhisper: { state: 'ready', variant: 'cpu' },
          };
        }
        return result;
      });
    }
  });
  const origin = appOrigin(page);
  await page.goto(`${origin}/zh/engines/`);
  await cli();
  await expect(failure()).toContainText('设置读取失败');
  await expect(command()).toHaveCount(0);
  await failure().locator('summary').click();
  await expect(failure()).toContainText(
    'Injected engine settings read failure',
  );
  await size(1024, 700, 'read-failed');
  await app.evaluate(() => {
    globalThis.engineSettingsReadFault = false;
  });
  await failure()
    .getByRole('button', { name: '重新读取', exact: true })
    .click();
  await saved();
  await expect(command()).toHaveValue('fixture-original-command');
  checks.push(
    'Read failure blocks default editing; explicit reload restores actual command',
  );

  await command().fill('unblurred-command');
  const before = await app.evaluate(() => globalThis.engineStatusCalls);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('/engines'))
      .webContents.send('py-engine-download-progress', {
        engineId: 'faster-whisper',
        status: 'error',
        error: 'fixture refresh',
      }),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.engineStatusCalls))
    .toBeGreaterThan(before);
  await expect(command()).toHaveValue('unblurred-command');
  assert.equal((await disk()).whisperCommand, 'fixture-original-command');
  await page.evaluate(
    () => void window.next.router.push('/zh/home').catch(() => {}),
  );
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  assert.equal((await disk()).whisperCommand, 'unblurred-command');
  checks.push(
    'Background engine refresh cannot overwrite typed command; unblurred save-and-leave reaches disk',
  );

  await page.goto(`${origin}/zh/engines/`);
  await cli();
  await saved();
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await command().fill('retry-command');
  await page
    .locator('main')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(failure()).toContainText('设置保存失败');
  await failure().locator('summary').click();
  await expect(failure()).toContainText(/EACCES|EPERM/);
  assert.equal((await disk()).whisperCommand, 'unblurred-command');
  await size(1024, 700, 'command-failed');
  await size(1440, 900, 'command-failed');
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await failure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await saved();
  assert.equal((await disk()).whisperCommand, 'retry-command');
  await page.reload();
  await saved();
  await expect(command()).toHaveValue('retry-command');
  checks.push(
    'Real chmod write failure retains command and blocks leaving; repaired retry persists and reloads',
  );

  for (const mode of ['reject', 'malformed']) {
    await app.evaluate((_electron, mode) => {
      globalThis.engineSettingsSaveFault = mode;
    }, mode);
    await command().fill(`failure-${mode}`);
    await page
      .locator('main')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect(failure()).toContainText('设置保存失败');
    assert.equal((await disk()).whisperCommand, 'retry-command');
    await expect(command()).toHaveValue(`failure-${mode}`);
  }
  await app.evaluate(() => {
    globalThis.engineSettingsSaveFault = '';
  });
  await failure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await saved();
  checks.push(
    'Rejected fields and malformed acknowledgements never show saved or overwrite disk; retry uses latest input',
  );

  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await page
    .getByRole('switch', { name: '启用本地命令行', exact: true })
    .click();
  await expect(failure()).toContainText('设置保存失败');
  await expect(
    page.getByRole('switch', { name: '启用本地命令行', exact: true }),
  ).toBeChecked();
  assert.equal((await disk()).useLocalWhisper, false);
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await failure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await saved();
  assert.equal((await disk()).useLocalWhisper, true);

  await page.getByRole('button', { name: /^faster-whisper / }).click();
  await page.getByRole('button', { name: /^高级设置 / }).click();
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await page.locator('#fw-device').click();
  await page.getByRole('option', { name: 'CPU', exact: true }).click();
  await expect(failure()).toContainText('设置保存失败');
  await page.locator('#fw-compute').click();
  await page.getByRole('option', { name: 'int8', exact: true }).click();
  await expect(failure()).toContainText('设置保存失败');
  assert.equal((await disk()).fasterWhisperDevice, 'auto');
  assert.equal((await disk()).fasterWhisperComputeType, 'auto');
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await failure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await saved();
  assert.equal((await disk()).fasterWhisperDevice, 'cpu');
  assert.equal((await disk()).fasterWhisperComputeType, 'int8');
  checks.push(
    'CLI toggle and installed-only device/precision controls retain rejected edits and retry real settings writes',
  );

  const invalid = await page.evaluate(async () => ({
    general: await window.ipc.invoke('setSettings', {
      fasterWhisperDevice: 'invalid',
      fasterWhisperComputeType: 'invalid',
      useLocalWhisper: 'yes',
      whisperCommand: null,
    }),
    legacy: await window.ipc.invoke('set-faster-whisper-settings', {
      device: 'invalid',
      computeType: 'invalid',
    }),
  }));
  assert.deepEqual(
    invalid.general.rejectedKeys.sort(),
    [
      'fasterWhisperDevice',
      'fasterWhisperComputeType',
      'useLocalWhisper',
      'whisperCommand',
    ].sort(),
  );
  assert.equal(invalid.legacy.success, false);
  assert.equal((await disk()).fasterWhisperDevice, 'cpu');
  checks.push('Both real IPC write paths reject malformed engine settings');

  await app.evaluate(({ ipcMain }) => {
    globalThis.engineCommandFault = true;
    globalThis.engineCommandCalls = [];
    for (const channel of [
      'check-py-engine-update',
      'uninstall-py-engine',
      'start-py-engine-download',
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, payload) => {
        globalThis.engineCommandCalls.push({ channel, payload });
        if (globalThis.engineCommandFault)
          throw new Error(`Injected ${channel} failure`);
        return {
          success: true,
          info: { hasUpdate: false, protocolSupported: true },
        };
      });
    }
  });
  const operationFailure = () => page.locator('[data-engine-operation-error]');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(operationFailure()).toContainText('引擎操作未完成');
  await operationFailure().locator('summary').click();
  await expect(operationFailure()).toContainText(
    'Injected check-py-engine-update failure',
  );
  await size(1024, 700, 'operation-failed');
  await app.evaluate(() => {
    globalThis.engineCommandFault = false;
  });
  await operationFailure()
    .getByRole('button', { name: '重试操作', exact: true })
    .click();
  await expect(operationFailure()).toHaveCount(0);
  const calls = await app.evaluate(() => globalThis.engineCommandCalls);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  await app.evaluate(() => {
    globalThis.engineCommandFault = true;
  });
  await page.getByRole('button', { name: '卸载', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '卸载', exact: true })
    .click();
  await expect(operationFailure()).toContainText('引擎操作未完成');
  await operationFailure().locator('summary').click();
  await expect(operationFailure()).toContainText(
    'Injected uninstall-py-engine failure',
  );
  await app.evaluate(() => {
    globalThis.engineCommandFault = false;
  });
  await operationFailure()
    .getByRole('button', { name: '重试操作', exact: true })
    .click();
  await expect(operationFailure()).toHaveCount(0);
  checks.push(
    'Injected check-update and confirmed-uninstall failures stay visible with details; retry reuses the command without launching an actual download or uninstall',
  );

  await app.evaluate(() => {
    globalThis.asrReadFault = true;
  });
  await page.reload();
  await expect(
    page.locator('[data-provider-persistence]').getByRole('alert'),
  ).toContainText('服务配置读取失败');
  await cli();
  await expect(command()).toHaveValue('failure-malformed');
  await command().fill('cloud-failure-independent');
  await page
    .locator('main')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await saved();
  assert.equal((await disk()).whisperCommand, 'cloud-failure-independent');
  await app.evaluate(() => {
    globalThis.asrReadFault = false;
  });
  await page
    .locator('[data-provider-persistence]')
    .getByRole('button', { name: '重新读取', exact: true })
    .click();
  await command().fill('discard-this-command');
  await page.evaluate(
    () => void window.next.router.push('/zh/home').catch(() => {}),
  );
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  assert.equal((await disk()).whisperCommand, 'cloud-failure-independent');
  checks.push(
    'Cloud read failures do not block local configuration; explicit discard never writes unsubmitted command',
  );

  await app.evaluate(() => {
    globalThis.engineStatusReadFault = true;
    globalThis.engineModelReadFault = true;
  });
  await page.goto(`${origin}/zh/engines/`);
  await page.getByRole('button', { name: /^faster-whisper / }).click();
  const statusFailure = () => page.locator('[data-engine-status-error]');
  await expect(statusFailure()).toContainText('引擎或模型状态读取失败');
  await statusFailure().locator('summary').click();
  await expect(statusFailure()).toContainText('Injected engine status failure');
  await expect(statusFailure()).toContainText('Injected model status failure');
  await expect(
    page.locator('main').getByText('状态未确认', { exact: true }),
  ).toBeVisible();
  await size(1024, 700, 'status-read-failed');
  await cli();
  await expect(command()).toHaveValue('cloud-failure-independent');
  await command().fill('retained-during-status-retry');
  await app.evaluate(() => {
    globalThis.engineStatusReadFault = false;
    globalThis.engineModelReadFault = false;
  });
  await statusFailure()
    .getByRole('button', { name: '重试操作', exact: true })
    .click();
  await expect(statusFailure()).toHaveCount(0);
  await expect(command()).toHaveValue('retained-during-status-retry');
  assert.equal((await disk()).whisperCommand, 'cloud-failure-independent');
  await page
    .locator('main')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await saved();
  checks.push(
    'Engine/model read failures are persistent and unverified; retry refreshes status without resetting unsaved command',
  );

  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ output, checks, errors }, null, 2),
  );
  console.log(
    JSON.stringify({ success: true, output, checks, errors }, null, 2),
  );
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  await app.close();
}
