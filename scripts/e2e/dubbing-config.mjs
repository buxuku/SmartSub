import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-dubbing-config-e2e-'),
);
const profile = path.join(output, 'profile');
const subtitle = path.join(output, 'config.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:05,000\nConfig persistence.\n',
);
let app, page, locked;
const errors = [],
  checks = [];
const launch = async () => {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await expect
    .poll(() =>
      app.evaluate(({ ipcMain }) =>
        ipcMain._invokeHandlers.has('dubbing:loadSubtitle'),
      ),
    )
    .toBe(true);
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    const channel = 'dubbing:syncVoiceState';
    const original = ipcMain._invokeHandlers.get(channel);
    globalThis.configFault = '';
    globalThis.configCalls = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      globalThis.configCalls.push(args[1].config);
      const mode = globalThis.configFault;
      if (mode === 'before')
        return { success: false, error: 'Injected project save failure' };
      if (mode === 'delay')
        await new Promise((resolve) => {
          globalThis.releaseConfig = resolve;
        });
      const result = await original(...args);
      if (mode === 'after')
        throw new Error('Configuration acknowledgement lost');
      return result;
    });
    const journalChannel = 'dubbing:writeConfigDraft';
    const journalWrite = ipcMain._invokeHandlers.get(journalChannel);
    globalThis.journalFault = '';
    ipcMain.removeHandler(journalChannel);
    ipcMain.handle(journalChannel, async (...args) => {
      if (args[1].raw === null) {
        if (globalThis.journalFault === 'clear-fail')
          return { success: false, error: 'Journal cleanup denied' };
        if (globalThis.journalFault === 'clear-delay')
          await new Promise((resolve) => {
            globalThis.releaseJournal = resolve;
          });
      }
      return journalWrite(...args);
    });
  });
};
const go = (url) =>
  page.evaluate(
    (url) =>
      window.next.router.push(url).catch((error) => {
        if (!error?.cancelled) throw error;
      }),
    url,
  );
const start = () => page.getByRole('button', { name: '开始配音', exact: true });
const speed = () => page.getByRole('slider', { name: '整体语速', exact: true });
const failure = () =>
  page.getByRole('alert').filter({ hasText: '配音配置尚未保存' });
const retry = () =>
  failure().getByRole('button', { name: '重试保存', exact: true });
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const session = await page.evaluate(async (subtitle) => {
    window.ipc.send('setTtsProviders', [
      {
        id: 'config-test',
        name: 'Config test',
        type: 'openaiCompatible',
        apiKey: 'fixture',
        apiUrl: 'http://127.0.0.1:1/v1',
        model: 'test',
        voices: 'voice',
      },
    ]);
    await window.ipc.invoke('getTtsProviders');
    localStorage.setItem(
      'dubbingConfig',
      JSON.stringify({
        engineKey: 'cloud:config-test',
        voice: 'voice',
        globalSpeed: 1,
        output: 'audioOnly',
        audioFormat: 'wav',
        background: 'mute',
      }),
    );
    const result = await window.ipc.invoke('dubbing:loadSubtitle', {
      leaseId: 'fixture',
      subtitlePath: subtitle,
    });
    if (!result.success) throw new Error(result.error);
    await window.ipc.invoke('dubbing:disposeSession', {
      sessionId: result.data.sessionId,
      leaseId: 'fixture',
    });
    return result.data;
  }, subtitle);
  const route = `/zh/dubbing/?session=${session.sessionId}`;
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  const directory = path.join(root, 'dubbing-sessions', session.sessionId);
  const meta = async () =>
    JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
  await go(route);
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, 1);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreConfigStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dubbingConfig')
        throw new DOMException('Config quota denied', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect(failure()).toBeVisible();
  await expect(speed()).toHaveAttribute('aria-valuenow', '1.05');
  await expect(start()).toBeDisabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, 1);
  await go('/zh/home/');
  let guard = page.getByRole('alertdialog');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(/dubbing/);
  await guard.getByRole('button', { name: '留在当前页', exact: true }).click();
  await expect(guard).toHaveCount(0);
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(output, `storage-error-${width}.png`),
    });
  }
  await page.evaluate(() => window.restoreConfigStorage());
  await retry().click();
  await expect(start()).toBeEnabled();
  await expect(failure()).not.toBeVisible();
  assert.equal((await meta()).configSnapshot.globalSpeed, 1.05);
  checks.push(
    'localStorage denial retains input, blocks start/file changes and save-and-leave, retry confirms disk snapshot; 1024/1440 bounds',
  );
  if (process.platform !== 'win32') {
    locked = directory;
    await fs.chmod(locked, 0o500);
    await speed().focus();
    await speed().press('ArrowRight');
    await expect(failure()).toBeVisible();
    await failure().locator('summary').click();
    await expect(failure()).toContainText('EACCES');
    assert.equal((await meta()).configSnapshot.globalSpeed, 1.05);
    await expect(start()).toBeDisabled();
    await fs.chmod(locked, 0o700);
    locked = undefined;
    await retry().click();
    await expect(start()).toBeEnabled();
    assert.equal((await meta()).configSnapshot.globalSpeed, 1.1);
    checks.push(
      'real chmod failure rolls back backend config and retries safely',
    );
  }
  const committed = (await meta()).configSnapshot.globalSpeed;
  await app.evaluate(() => {
    globalThis.configFault = 'after';
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect(failure()).toBeVisible();
  assert.equal(
    (await meta()).configSnapshot.globalSpeed,
    Number((committed + 0.05).toFixed(2)),
  );
  await app.evaluate(() => {
    globalThis.configFault = '';
  });
  await failure()
    .getByRole('button', { name: '还原配置', exact: true })
    .click();
  await expect(start()).toBeEnabled();
  await expect(speed()).toHaveAttribute('aria-valuenow', String(committed));
  assert.equal((await meta()).configSnapshot.globalSpeed, committed);
  checks.push(
    'lost acknowledgement cannot silently leave disk on rejected config; revert re-persists old settings',
  );
  await app.evaluate(() => {
    globalThis.configFault = 'delay';
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseConfig))
    .toBe('function');
  await speed().press('ArrowRight');
  await expect(start()).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '清除字幕', exact: true }),
  ).toBeDisabled();
  await app.evaluate(() => {
    globalThis.configFault = '';
    globalThis.releaseConfig();
  });
  await expect(start()).toBeEnabled();
  const savedSpeed = Number((committed + 0.1).toFixed(2));
  assert.equal((await meta()).configSnapshot.globalSpeed, savedSpeed);
  checks.push(
    'rapid keyboard edits serialized through delayed IPC; final intent persisted',
  );
  const electronProcess = app.process();
  const exited = once(electronProcess, 'exit');
  electronProcess.kill('SIGKILL');
  await exited;
  app = null;
  await launch();
  await go(route);
  await expect(start()).toBeEnabled();
  await expect(speed()).toHaveAttribute('aria-valuenow', String(savedSpeed));
  await go('/zh/home/');
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('dubbingConfig'));
    localStorage.setItem(
      'dubbingConfig',
      JSON.stringify({ ...saved, globalSpeed: 1.9 }),
    );
  });
  await go(route);
  await expect(start()).toBeEnabled();
  await expect(speed()).toHaveAttribute('aria-valuenow', String(savedSpeed));
  assert.equal((await meta()).configSnapshot.globalSpeed, savedSpeed);
  checks.push(
    'SIGKILL restart retains saved config; per-project snapshot takes precedence over unrelated defaults',
  );
  const draftKey = `smartsub_dubbing_config_draft_v1:${session.sessionId}`;
  const recovery = () =>
    page
      .getByRole('alert')
      .filter({ hasText: '检测到此项目未确认保存的配音配置' });
  const crashAndReopen = async () => {
    const process = app.process();
    const exited = once(process, 'exit');
    process.kill('SIGKILL');
    await exited;
    app = null;
    await launch();
    await go(route);
  };
  await app.evaluate(() => {
    globalThis.configFault = 'before';
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect(failure()).toBeVisible();
  const intendedSpeed = Number((savedSpeed + 0.05).toFixed(2));
  assert.equal((await meta()).configSnapshot.globalSpeed, savedSpeed);
  const draft = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    draftKey,
  );
  assert.equal(draft.current.globalSpeed, intendedSpeed);
  await crashAndReopen();
  await expect(recovery()).toBeVisible();
  await expect(start()).toBeDisabled();
  await expect(speed()).toHaveAttribute('aria-valuenow', String(savedSpeed));
  assert.equal((await meta()).configSnapshot.globalSpeed, savedSpeed);
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(output, `draft-recovery-${width}.png`),
    });
  }
  await recovery()
    .getByRole('button', { name: '恢复配置草稿', exact: true })
    .click();
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, intendedSpeed);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  checks.push(
    'unacknowledged config survives whole-app SIGKILL; recovery blocks auto-save and generation, restores only on explicit choice, then removes journal after acknowledgement; 1024/1440',
  );

  await app.evaluate(() => {
    globalThis.configFault = 'after';
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect(failure()).toBeVisible();
  const acknowledgedOnDisk = Number((intendedSpeed + 0.05).toFixed(2));
  assert.equal((await meta()).configSnapshot.globalSpeed, acknowledgedOnDisk);
  await crashAndReopen();
  await expect(recovery()).toBeVisible();
  await expect(speed()).toHaveAttribute(
    'aria-valuenow',
    String(acknowledgedOnDisk),
  );
  await recovery()
    .getByRole('button', { name: '放弃配置草稿', exact: true })
    .click();
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, acknowledgedOnDisk);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  checks.push(
    'lost acknowledgement plus SIGKILL retains a recovery choice; discarding does not roll back already-persisted project settings',
  );

  await go('/zh/home/');
  await page.evaluate(
    (key) => localStorage.setItem(key, '{unreadable-draft'),
    draftKey,
  );
  await go(route);
  const damaged = page
    .getByRole('alert')
    .filter({ hasText: '无法读取此项目的配音配置草稿' });
  await expect(damaged).toBeVisible();
  await expect(start()).toBeDisabled();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    '{unreadable-draft',
  );
  await damaged.getByRole('button', { name: '重读草稿', exact: true }).click();
  await expect(damaged).toBeVisible();
  await damaged
    .getByRole('button', { name: '放弃配置草稿', exact: true })
    .click();
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, acknowledgedOnDisk);
  checks.push(
    'malformed recovery record is preserved and blocks edits until explicit discard; saved project snapshot is unchanged',
  );
  await app.evaluate(() => {
    globalThis.configFault = 'before';
    globalThis.journalFault = 'clear-fail';
  });
  await speed().focus();
  await speed().press('ArrowRight');
  await expect(failure()).toBeVisible();
  await go('/zh/home/');
  guard = page.getByRole('alertdialog');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(/dubbing/);
  assert.notEqual(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  await app.evaluate(() => {
    globalThis.journalFault = 'clear-delay';
  });
  await guard.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseJournal))
    .toBe('function');
  await expect(page).toHaveURL(/dubbing/);
  await expect(
    guard.getByRole('button', { name: '放弃并离开', exact: true }),
  ).toBeDisabled();
  await app.evaluate(() => {
    globalThis.configFault = '';
    globalThis.journalFault = '';
    globalThis.releaseJournal();
  });
  await expect(page).toHaveURL(/home/);
  await go(route);
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, acknowledgedOnDisk);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  checks.push(
    'discard-and-leave waits for durable journal cleanup; rejected cleanup keeps dialog/page/draft, delayed cleanup disables repeated commands, retry exits only after acknowledgement',
  );
  await go('/zh/home/');
  const provider = await page.evaluate(async () => {
    const providers = await window.ipc.invoke('getTtsProviders');
    window.ipc.send('setTtsProviders', [
      { ...providers[0], id: 'replacement', name: 'Replacement' },
    ]);
    await window.ipc.invoke('getTtsProviders');
    return providers[0];
  });
  await go(route);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: '原引擎 cloud:config-test 不可用' }),
  ).toBeVisible();
  await expect(start()).toBeDisabled();
  assert.equal((await meta()).configSnapshot.engine.providerId, 'config-test');
  await page.getByRole('combobox', { name: '引擎', exact: true }).click();
  await page.getByRole('option', { name: /Replacement/ }).click();
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.engine.providerId, 'replacement');
  await go('/zh/home/');
  await page.evaluate(async (provider) => {
    window.ipc.send('setTtsProviders', [
      {
        ...provider,
        id: 'replacement',
        name: 'Replacement',
        voices: 'new-voice',
      },
    ]);
    await window.ipc.invoke('getTtsProviders');
  }, provider);
  await go(route);
  await expect(
    page.getByRole('alert').filter({ hasText: '原音色 voice 不可用' }),
  ).toBeVisible();
  await expect(start()).toBeDisabled();
  assert.equal((await meta()).configSnapshot.voice, 'voice');
  await page.getByRole('combobox', { name: '声音', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /new-voice/ })
    .click();
  await expect(start()).toBeEnabled();
  assert.equal((await meta()).configSnapshot.voice, 'new-voice');
  checks.push(
    'missing saved engine/voice retained on disk and visibly blocked until explicit replacement',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ output, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error({ output, errors });
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  await app?.close().catch(() => {});
}
