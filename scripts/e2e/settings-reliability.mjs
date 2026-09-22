import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-settings-e2e-'),
);
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(output, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss();
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];
let lockedDirectory;
const loadFailure = () =>
  page.getByRole('alert').filter({ hasText: '设置读取失败' });
const saveFailure = () =>
  page.locator('main').getByRole('alert').filter({ hasText: '设置保存失败' });
const saved = () =>
  expect(page.locator('main').getByRole('status', { exact: true })).toHaveText(
    '已保存',
  );
const goHome = () =>
  page.getByRole('link', { name: '启动台', exact: true }).click();
const settings = () =>
  page.getByRole('link', { name: '设置', exact: true }).click();
async function size(width, height, name) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().startsWith('http:'))
        .setContentSize(...size);
    },
    [width, height],
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(output, `${name}-${width}.png`) });
}
try {
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(() =>
    window.ipc.invoke('setSettings', {
      customLanguages: [{ name: 'Existing language', value: 'qaa' }],
    }),
  );
  let configPath;
  for (const directory of ['profile', 'profile-dev']) {
    const candidate = path.join(output, directory, 'config.json');
    const value = await fs
      .readFile(candidate, 'utf8')
      .then(JSON.parse, () => null);
    if (value?.settings?.customLanguages?.[0]?.value === 'qaa')
      configPath = candidate;
  }
  assert.ok(configPath, 'Locate acknowledged configuration by fixture content');
  const disk = async () =>
    JSON.parse(await fs.readFile(configPath, 'utf8')).settings;
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('getSettings');
    globalThis.settingsReadFault = true;
    ipcMain.removeHandler('getSettings');
    ipcMain.handle('getSettings', (...args) => {
      if (
        globalThis.settingsReadFault &&
        args[0].sender.getURL().includes('/settings')
      )
        throw new Error('EACCES injected settings read');
      return original(...args);
    });
  });
  await settings();
  await expect(loadFailure()).toBeVisible();
  await expect(page.locator('main').getByRole('switch')).toHaveCount(0);
  await loadFailure().locator('summary').click();
  await expect(loadFailure()).toContainText('EACCES injected settings read');
  await size(1024, 700, 'load-failed');
  await app.evaluate(() => {
    globalThis.settingsReadFault = false;
  });
  await loadFailure()
    .getByRole('button', { name: '重新读取', exact: true })
    .click();
  await saved();
  checks.push(
    'Injected read error blocks editable defaults; details and reload recover existing settings',
  );

  const original = await disk();
  const updateSwitch = page.getByRole('switch', {
    name: '启动时检查更新',
    exact: true,
  });
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await updateSwitch.click();
  await expect(saveFailure()).toBeVisible();
  await saveFailure().locator('summary').click();
  await expect(saveFailure()).toContainText(/EACCES|EPERM/);
  assert.equal(
    (await disk()).checkUpdateOnStartup,
    original.checkUpdateOnStartup,
  );
  await size(1024, 700, 'write-failed');
  await size(1440, 900, 'write-failed');
  await goHome();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page).toHaveURL(/\/settings/);
  await page.getByRole('button', { name: '留在当前页', exact: true }).click();
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await saveFailure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await saved();
  assert.equal(
    (await disk()).checkUpdateOnStartup,
    !original.checkUpdateOnStartup,
  );
  await page.reload();
  await expect(updateSwitch).toHaveAttribute(
    'data-state',
    original.checkUpdateOnStartup ? 'unchecked' : 'checked',
  );
  checks.push(
    'Real config directory chmod failure retains toggle, blocks save-and-leave, and retry persists across reload',
  );

  await page.getByRole('button', { name: /^管理（1）$/ }).click();
  const languages = page.getByRole('dialog');
  await languages
    .getByRole('textbox', { name: '语言名称', exact: true })
    .fill('Test language');
  await languages
    .getByRole('textbox', { name: '语言代码', exact: true })
    .fill('qab');
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await languages.getByRole('button', { name: '添加', exact: true }).click();
  await expect(languages.getByRole('alert')).toContainText('设置保存失败');
  await expect(
    languages.getByText('Test language', { exact: true }),
  ).toBeVisible();
  await expect(
    languages.getByText('Existing language', { exact: true }),
  ).toBeVisible();
  await expect(
    languages.getByRole('textbox', { name: '语言代码', exact: true }),
  ).toHaveValue('');
  assert.deepEqual((await disk()).customLanguages, original.customLanguages);
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await languages
    .getByRole('button', { name: '重试操作', exact: true })
    .click();
  await expect(languages.getByRole('alert')).toHaveCount(0);
  assert.deepEqual((await disk()).customLanguages, [
    ...original.customLanguages,
    { name: 'Test language', value: 'qab' },
  ]);
  await languages.getByRole('button', { name: '完成', exact: true }).click();
  checks.push(
    'Custom language failed save keeps both old and staged entries; retry writes once without duplicate-add trap',
  );

  await page.getByRole('combobox').filter({ hasText: '不使用' }).click();
  await page.getByRole('option', { name: '自定义', exact: true }).click();
  await saved();
  const proxy = page.getByRole('textbox', { name: '代理地址', exact: true });
  await proxy.fill('http://127.0.0.1:7899');
  await expect(page.locator('main').getByRole('status')).toHaveText(
    '未保存的修改',
  );
  // Programmatic route initiation does not blur the focused input first.
  await page.evaluate(
    () => void window.next.router.push('/zh/home').catch(() => {}),
  );
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  assert.equal((await disk()).proxyUrl, 'http://127.0.0.1:7899');
  await settings();
  await expect(proxy).toHaveValue('http://127.0.0.1:7899');
  checks.push(
    'Focused proxy input is dirty before blur; route guard flushes it and navigation retains the value',
  );

  await page.getByText('VAD 灵敏度（环境微调）', { exact: true }).click();
  const threshold = page.getByRole('spinbutton', {
    name: 'VAD 阈值',
    exact: true,
  });
  await threshold.fill('0.7');
  await page.evaluate(
    () => void window.next.router.push('/zh/home').catch(() => {}),
  );
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  assert.equal((await disk()).vadThreshold, 0.7);
  await settings();
  await page.getByText('VAD 灵敏度（环境微调）', { exact: true }).click();
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await threshold.fill('0.9');
  await expect(saveFailure()).toBeVisible();
  assert.equal((await disk()).vadThreshold, 0.7);
  await goHome();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await settings();
  await page.getByText('VAD 灵敏度（环境微调）', { exact: true }).click();
  await expect(threshold).toHaveValue('0.7');
  checks.push(
    'Immediate VAD navigation flushes debounce; failed VAD edit can be explicitly discarded without delayed writes',
  );
  for (const value of ['', '-1', '1.5']) {
    await threshold.fill(value);
    await expect(threshold).toHaveAttribute('aria-invalid', 'true');
    await expect(saveFailure()).toContainText('请填写有效的 VAD 数值');
    assert.equal((await disk()).vadThreshold, 0.7);
    await goHome();
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page).toHaveURL(/\/settings/);
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await threshold.fill('0.7');
    await saved();
  }
  const rejected = await page.evaluate(() =>
    window.ipc.invoke('setSettings', { vadThreshold: 2, vadSpeechPad: -100 }),
  );
  assert.deepEqual(rejected.rejectedKeys.sort(), [
    'vadSpeechPad',
    'vadThreshold',
  ]);
  assert.equal((await disk()).vadThreshold, 0.7);
  assert.equal((await disk()).vadSpeechPad, original.vadSpeechPad);
  checks.push(
    'Empty, negative, and out-of-range VAD values remain editable but cannot save or leave; backend rejects bypassed invalid fields',
  );

  const storageRoot = path.join(output, 'selected-storage');
  await fs.mkdir(storageRoot);
  await app.evaluate(({ ipcMain }, directoryPath) => {
    ipcMain.removeHandler('selectDirectory');
    ipcMain.handle('selectDirectory', () => ({
      canceled: false,
      directoryPath,
    }));
  }, storageRoot);
  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await page.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(saveFailure()).toBeVisible();
  assert.notEqual((await disk()).storageRoot, storageRoot);
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await saveFailure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  const storageDialog = page.getByRole('dialog');
  await expect(storageDialog).toContainText('存储目录已更新');
  await expect(storageDialog.locator('input').last()).toHaveValue(storageRoot);
  assert.equal((await disk()).storageRoot, storageRoot);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('openDirectoryPath');
    ipcMain.handle('openDirectoryPath', () => ({
      success: false,
      error: 'Injected old directory failure',
    }));
  });
  await storageDialog
    .getByRole('button', { name: '打开旧目录', exact: true })
    .click();
  await expect(storageDialog.getByRole('alert')).toBeVisible();
  await storageDialog.locator('summary').click();
  await expect(storageDialog.getByRole('alert')).toContainText(
    'Injected old directory failure',
  );
  await size(1024, 700, 'storage-dialog-failed');
  await storageDialog
    .getByRole('button', { name: '知道了', exact: true })
    .click();
  await saved();
  checks.push(
    'Storage selector uses fixture path but real persistence; retry updates the path and presents old/new storage guidance',
  );

  lockedDirectory = path.dirname(configPath);
  await fs.chmod(lockedDirectory, 0o500);
  await page.getByRole('combobox').filter({ hasText: '中文' }).click();
  await page.getByRole('option', { name: '英文', exact: true }).click();
  await expect(saveFailure()).toBeVisible();
  await expect(page).toHaveURL(/\/zh\/settings/);
  assert.equal((await disk()).language, 'zh');
  await fs.chmod(lockedDirectory, 0o700);
  lockedDirectory = undefined;
  await saveFailure()
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await expect(page).toHaveURL(/\/en\/settings/);
  assert.equal((await disk()).language, 'en');
  await page.getByRole('combobox').filter({ hasText: 'English' }).click();
  await page.getByRole('option', { name: 'Chinese', exact: true }).click();
  await expect(page).toHaveURL(/\/zh\/settings/);
  await saved();
  checks.push(
    'Failed language change stays in the original locale; generic retry commits and navigates to the new locale',
  );

  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['proxy:test', 'exportConfig', 'openStorageRoot']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({
        success: false,
        ok: false,
        error: `Injected ${channel} failure`,
      }));
    }
    ipcMain.removeHandler('importConfig');
    ipcMain.handle('importConfig', () => {
      globalThis.settingsReadFault = true;
      return { success: true };
    });
  });
  await page.getByRole('button', { name: '测试连通性', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    '连接失败',
  );
  await page.getByRole('button', { name: '打开目录', exact: true }).click();
  await page.locator('main').getByRole('alert').locator('summary').click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Injected openStorageRoot failure',
  );
  await page.getByRole('button', { name: '导出配置', exact: true }).click();
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('alert')).toHaveCount(0);
  await exportDialog
    .getByPlaceholder('请输入密码', { exact: true })
    .fill('test-password');
  await exportDialog
    .getByPlaceholder('请再次输入密码', { exact: true })
    .fill('test-password');
  await exportDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(exportDialog.getByRole('alert')).toContainText('配置导出失败');
  await exportDialog.locator('summary').click();
  await expect(exportDialog.getByRole('alert')).toContainText(
    'Injected exportConfig failure',
  );
  await size(1024, 700, 'export-failed');
  await exportDialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '导入配置', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByPlaceholder('请输入密码', { exact: true })
    .fill('test-password');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(loadFailure()).toBeVisible();
  await expect(page.locator('main').getByRole('switch')).toHaveCount(0);
  await app.evaluate(() => {
    globalThis.settingsReadFault = false;
  });
  await loadFailure()
    .getByRole('button', { name: '重新读取', exact: true })
    .click();
  await saved();
  checks.push(
    'Injected proxy/export faults remain in context; simulated import acknowledgement followed by read failure blocks stale editing until reload',
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
