import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-provider-save-e2e-'),
);
const profile = path.join(output, 'profile');
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${profile}`,
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
const status = () => page.locator('[data-provider-persistence]');
const saved = () => expect(status().getByRole('status')).toHaveText('已保存');
const failure = () => status().getByRole('alert');
const fixtures = [
  {
    kind: 'Translation',
    route: 'translation',
    key: 'translationProviders',
    name: 'Provider translation fixture',
    type: 'openai',
    isAi: true,
    modelName: 'test-model',
  },
  {
    kind: 'Asr',
    route: 'engines',
    key: 'asrProviders',
    name: 'Provider ASR fixture',
    type: 'openaiCompatible',
    models: 'test-model',
  },
  {
    kind: 'Tts',
    route: 'ttsServices',
    key: 'ttsProviders',
    name: 'Provider TTS fixture',
    type: 'openaiCompatible',
    model: 'test-model',
    voices: 'alloy',
  },
];
async function size(width, height, name) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.id === globalThis.providerMainWindowId)
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
  await page.screenshot({
    path: path.join(output, `${name}-${width}.png`),
    animations: 'disabled',
  });
}
try {
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    globalThis.providerMainWindowId = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL().startsWith('http:'),
    ).id;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  for (const fixture of fixtures) {
    const provider = {
      ...fixture,
      id: `fixture-${fixture.kind}`,
      apiUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-old',
    };
    delete provider.kind;
    delete provider.route;
    delete provider.key;
    await page.evaluate(
      async ({ kind, provider }) => {
        const current = await window.ipc.invoke(`get${kind}Providers`);
        const result = await window.ipc.invoke(`set${kind}Providers`, {
          providers: [provider],
          expectedProviders: current,
        });
        if (result?.success !== true) throw new Error('Fixture save failed');
      },
      { kind: fixture.kind, provider },
    );
  }
  const configPath = path.join(profile, 'config.json');
  const disk = async (key) =>
    JSON.parse(await fs.readFile(configPath, 'utf8'))[key];
  assert.equal((await disk('translationProviders'))[0].apiKey, 'fixture-old');
  await app.evaluate(({ ipcMain }) => {
    globalThis.providerReadFault = '';
    globalThis.providerReadCalls = 0;
    for (const kind of ['Translation', 'Asr', 'Tts']) {
      const channel = `get${kind}Providers`;
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => {
        if (globalThis.providerReadFault === kind) {
          globalThis.providerReadCalls++;
          throw new Error('Injected provider read failure');
        }
        return original(...args);
      });
    }
  });
  const origin = new URL(page.url()).origin;
  for (const fixture of fixtures) {
    const { kind, route, key, name } = fixture;
    await app.evaluate((_electron, kind) => {
      globalThis.providerReadFault = kind;
    }, kind);
    await page.goto(`${origin}/zh/${route}/`);
    await expect(failure()).toContainText('服务配置读取失败');
    await expect(page.locator('main input[type="password"]')).toHaveCount(0);
    await failure().locator('summary').click();
    await expect(failure()).toContainText('Injected provider read failure');
    await app.evaluate(() => {
      globalThis.providerReadFault = '';
    });
    await failure()
      .getByRole('button', { name: '重新读取', exact: true })
      .click();
    await saved();
    await page.getByText(name, { exact: true }).first().click();
    if (kind !== 'Translation') {
      await expect(
        page.locator('main').getByText('已配置', { exact: true }),
      ).toBeVisible();
    }
    if (kind === 'Translation') {
      await expect
        .poll(async () => (await disk('userConfig')).translateProvider)
        .toBe(`fixture-${kind}`);
    }
    const input = page.locator('main input[type="password"]').first();
    await expect(input).toHaveValue('fixture-old');
    await saved();
    lockedDirectory = path.dirname(configPath);
    await fs.chmod(lockedDirectory, 0o500);
    await input.fill(`fixture-${kind}-new`);
    await expect(failure()).toContainText('服务配置未保存');
    await failure().locator('summary').click();
    await expect(failure()).toContainText(/EACCES|EPERM/);
    assert.equal((await disk(key))[0].apiKey, 'fixture-old');
    await size(1024, 700, `${kind}-failed`);
    await size(1440, 900, `${kind}-failed`);
    await page.getByRole('link', { name: '启动台', exact: true }).click();
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${route}/`));
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    await failure()
      .getByRole('button', { name: '重试保存', exact: true })
      .click();
    await saved();
    assert.equal((await disk(key))[0].apiKey, `fixture-${kind}-new`);
    await page.reload();
    await saved();
    await expect(input).toHaveValue(`fixture-${kind}-new`);

    await app.evaluate(({ ipcMain }, kind) => {
      const channel = `set${kind}Providers`;
      const original = ipcMain._invokeHandlers.get(channel);
      globalThis.loseProviderAcknowledgement = true;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args);
        if (globalThis.loseProviderAcknowledgement) {
          globalThis.loseProviderAcknowledgement = false;
          throw new Error('Injected lost provider acknowledgement');
        }
        return result;
      });
    }, kind);
    await input.fill('accepted-without-ack');
    await expect(failure()).toContainText('服务配置未保存');
    assert.equal((await disk(key))[0].apiKey, 'accepted-without-ack');
    await input.fill('newer-after-lost-ack');
    await failure()
      .getByRole('button', { name: '重试保存', exact: true })
      .click();
    await saved();
    assert.equal((await disk(key))[0].apiKey, 'newer-after-lost-ack');

    // A second renderer commits while the first still holds its loaded base.
    await app.evaluate(async ({ BrowserWindow }, preload) => {
      const original = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('http:'),
      );
      const other = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      globalThis.providerOtherWindow = other;
      await other.loadURL(
        new URL('/zh/home/', original.webContents.getURL()).href,
      );
    }, path.resolve('app/preload.js'));
    await expect
      .poll(() =>
        app.evaluate(() =>
          globalThis.providerOtherWindow.webContents.isLoading(),
        ),
      )
      .toBe(false);
    await app.evaluate(async (_electron, kind) => {
      await globalThis.providerOtherWindow.webContents
        .executeJavaScript(`(async () => {
        const current = await window.ipc.invoke('get${kind}Providers');
        const providers = current.map(provider => ({...provider, apiKey:'external-new'}));
        return window.ipc.invoke('set${kind}Providers', {providers, expectedProviders:current});
      })()`);
    }, kind);
    await input.fill('local-conflicting');
    await expect(failure()).toContainText('另一个窗口');
    assert.equal((await disk(key))[0].apiKey, 'external-new');
    await expect(input).toHaveValue('local-conflicting');
    await failure()
      .getByRole('button', { name: '放弃修改并重新读取', exact: true })
      .click();
    await size(1024, 700, `${kind}-conflict`);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '放弃修改并重新读取', exact: true })
      .click();
    await saved();
    await expect(input).toHaveValue('external-new');
    await app.evaluate(() => globalThis.providerOtherWindow.destroy());

    await input.fill('immediate-navigation');
    await page.evaluate(
      () => void window.next.router.push('/zh/home').catch(() => {}),
    );
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page).toHaveURL(/\/home/);
    assert.equal((await disk(key))[0].apiKey, 'immediate-navigation');
    checks.push(
      `${kind}: read failure/reload, real chmod write failure, failed save-and-leave, retry/reload, lost acknowledgement with newer edits, second-window CAS conflict, explicit discard/reload and immediate navigation flush`,
    );

    await page.goto(`${origin}/zh/${route}/`);
    await saved();
    await page.getByText(name, { exact: true }).first().click();
    if (kind !== 'Translation') {
      const field = kind === 'Asr' ? 'models' : 'voices';
      const tag = page.getByPlaceholder(
        kind === 'Asr' ? '输入模型 id，回车添加' : '输入音色名，回车添加',
      );
      await tag.fill('unblurred-tag');
      assert.equal(
        (await disk(key))[0][field].includes('unblurred-tag'),
        false,
      );
      await page.evaluate(
        () => void window.next.router.push('/zh/home').catch(() => {}),
      );
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page
        .getByRole('button', { name: '保存并离开', exact: true })
        .click();
      await expect(page).toHaveURL(/\/home/);
      assert.equal((await disk(key))[0][field].includes('unblurred-tag'), true);
      await page.goto(`${origin}/zh/${route}/`);
      await saved();
      checks.push(
        `${kind}: unblurred tag input participates in save-and-leave`,
      );
    }

    const addLabel = kind === 'Asr' ? '添加自定义' : '添加自定义服务';
    await page
      .getByRole('button', { name: addLabel, exact: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    const prefix =
      kind === 'Translation'
        ? 'new-provider'
        : kind === 'Asr'
          ? 'asr-custom'
          : 'tts-custom';
    const createdName = `Created ${kind}`;
    await dialog.locator(`#${prefix}-name`).fill(createdName);
    await dialog
      .locator(`#${prefix}-${kind === 'Translation' ? 'api-url' : 'url'}`)
      .fill('http://127.0.0.1:9/v1');
    lockedDirectory = path.dirname(configPath);
    await fs.chmod(lockedDirectory, 0o500);
    await dialog
      .getByRole('button', {
        name: kind === 'Translation' ? '添加' : addLabel,
        exact: true,
      })
      .click();
    await expect(failure()).toContainText('服务配置未保存');
    assert.equal(
      (await disk(key)).some((entry) => entry.name === createdName),
      false,
    );
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    await failure()
      .getByRole('button', { name: '重试保存', exact: true })
      .click();
    await saved();
    const created = (await disk(key)).find(
      (entry) => entry.name === createdName,
    );
    assert.ok(created);
    if (kind === 'Translation') {
      const selectionAlert = page
        .getByRole('alert')
        .filter({ hasText: 'PROVIDER_LIST_NOT_SAVED' });
      await selectionAlert
        .getByRole('button', { name: '重试保存', exact: true })
        .click();
      await expect(selectionAlert).toHaveCount(0);
      await expect
        .poll(async () => (await disk('userConfig')).translateProvider)
        .toBe(created.id);
      await page.getByRole('button', { name: '重命名', exact: true }).click();
      await page.locator('h1 input').fill(`${createdName} renamed`);
      await page.evaluate(
        () => void window.next.router.push('/zh/home').catch(() => {}),
      );
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page
        .getByRole('button', { name: '保存并离开', exact: true })
        .click();
      await expect(page).toHaveURL(/\/home/);
      assert.equal(
        (await disk(key)).find((entry) => entry.id === created.id).name,
        `${createdName} renamed`,
      );
      await page.goto(`${origin}/zh/${route}/`);
      await saved();
    }
    const remove =
      kind === 'Translation'
        ? page.getByRole('button', {
            name: `删除服务商「${createdName} renamed」`,
            exact: true,
          })
        : page
            .getByRole('button', { name: '删除', exact: true })
            .filter({ hasText: '删除' });
    await remove.click();
    lockedDirectory = path.dirname(configPath);
    await fs.chmod(lockedDirectory, 0o500);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await expect(failure()).toContainText('服务配置未保存');
    assert.ok((await disk(key)).some((entry) => entry.id === created.id));
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    await failure()
      .getByRole('button', { name: '重试保存', exact: true })
      .click();
    await saved();
    assert.equal(
      (await disk(key)).some((entry) => entry.id === created.id),
      false,
    );
    checks.push(
      `${kind}: real write failures on add/delete retain queued changes and retry reaches disk; translation default and rename are acknowledged`,
    );

    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...config, [key]: null }));
    await page.goto(`${origin}/zh/${route}/`);
    await expect(failure()).toContainText('服务配置读取失败');
    assert.equal(await disk(key), null);
    await fs.writeFile(configPath, JSON.stringify(config));
    await failure()
      .getByRole('button', { name: '重新读取', exact: true })
      .click();
    await saved();
    checks.push(
      `${kind}: malformed on-disk null is not reinitialized or overwritten; repair and reload recovers`,
    );

    await page
      .getByRole('button', { name: addLabel, exact: true })
      .first()
      .click();
    await page
      .getByRole('dialog')
      .locator(`#${prefix}-name`)
      .fill('unsubmitted-create');
    await page.getByRole('dialog').press('Escape');
    await page.evaluate(
      () => void window.next.router.push('/zh/home').catch(() => {}),
    );
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await page
      .getByRole('button', { name: addLabel, exact: true })
      .first()
      .click();
    await expect(
      page.getByRole('dialog').locator(`#${prefix}-name`),
    ).toHaveValue('unsubmitted-create');
    await page.getByRole('dialog').press('Escape');
    await page.evaluate(
      () => void window.next.router.push('/zh/home').catch(() => {}),
    );
    await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
    await expect(page).toHaveURL(/\/home/);
    assert.equal(
      (await disk(key)).some((entry) => entry.name === 'unsubmitted-create'),
      false,
    );
    checks.push(
      `${kind}: unsubmitted creation remains guarded after closing its dialog; stay retains input and explicit discard never creates a provider`,
    );
  }
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
