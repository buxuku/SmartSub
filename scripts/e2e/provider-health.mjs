import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-health-e2e-'),
);
let requests = 0;
let failure = false;
const service = http.createServer((request, response) => {
  requests++;
  request.resume();
  response.writeHead(failure ? 401 : 200, {
    'Content-Type': 'application/json',
  });
  response.end(
    JSON.stringify(
      failure
        ? { message: 'Health test rejected' }
        : { data: 'Translated sample' },
    ),
  );
});
await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(evidence, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow, dialog }) => {
  dialog.showMessageBoxSync = () => 0;
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.closeDevTools(),
  );
});
const provider = {
  id: 'local-health-test',
  name: 'Local health test',
  type: 'deeplx',
  isAi: false,
  apiUrl: `http://127.0.0.1:${service.address().port}/translate`,
  apiKey: 'not-a-real-secret',
  requestInterval: 0,
};
async function saveProvider(next) {
  await page.evaluate(async (provider) => {
    window.ipc.send('setTranslationProviders', [provider]);
    return window.ipc.invoke('getTranslationProviders');
  }, next);
}
async function probe(next) {
  return page.evaluate(async (provider) => {
    try {
      return await window.ipc.invoke('testTranslation', {
        provider: { ...provider, strictStructuredOutput: true },
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      });
    } catch (error) {
      return { error: String(error) };
    }
  }, next);
}
try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await saveProvider(provider);
  await page.reload();
  await expect(
    page.getByRole('button', { name: '服务已配置 · 连接未验证', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  assert.equal(requests, 0, 'status check must not trigger network requests');
  assert.equal((await probe(provider)).translation, 'Translated sample');
  await expect(
    page.getByRole('button', { name: '1 个服务连接已验证', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const health = await page.evaluate(() =>
    window.ipc.invoke('getProviderHealth'),
  );
  assert.equal(
    health.find((entry) => entry.id === 'local-health-test').status,
    'connected',
  );
  assert.ok(!JSON.stringify(health).includes('not-a-real-secret'));
  assert.equal(requests, 1);
  failure = true;
  assert.match((await probe(provider)).error, /Health test rejected/);
  await expect(
    page.getByRole('button', { name: '服务连接异常', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: path.join(evidence, 'connection-failed.png') });
  const changed = { ...provider, apiKey: 'changed-test-key' };
  await saveProvider(changed);
  await expect(
    page.getByRole('button', { name: '服务已配置 · 连接未验证', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  assert.equal(
    requests,
    2,
    'configuration changes do not automatically retest',
  );
  failure = false;
  assert.equal((await probe(changed)).translation, 'Translated sample');
  await expect(
    page.getByRole('button', { name: '1 个服务连接已验证', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.screenshot({
    path: path.join(evidence, 'connection-recovered.png'),
  });
  console.log(
    JSON.stringify({
      success: true,
      evidence,
      checks: [
        'configured is not connected',
        'no automatic network probes',
        'real HTTP test updates status bar',
        'failed test stays failed',
        'credential edit invalidates result',
        'retry recovers',
        'health payload contains no credentials',
      ],
    }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(evidence, 'unexpected-failure.png') })
    .catch(() => {});
  console.error('Provider health evidence:', evidence);
  throw error;
} finally {
  await app.close();
  await new Promise((resolve) => service.close(resolve));
}
