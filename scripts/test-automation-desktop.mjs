import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { _electron } from '@playwright/test';
import electron from 'electron';
import http from 'node:http';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-desktop-automation-'),
);
const profile = path.join(root, 'profile');
const packaged = process.env.SMARTSUB_PACKAGED_APP;
const executablePath = packaged || electron;
const args = [
  ...(packaged ? [] : ['.']),
  '--automation-background',
  `--automation-data-dir=${profile}`,
];
const env = { ...process.env, NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath, args, env });
const errors = [];
let asrRequests = 0;
const mock = http.createServer(async (req, res) => {
  for await (const chunk of req) {
  }
  asrRequests++;
  const timer = setTimeout(
    () =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          text: 'Hello',
          segments: [{ start: 0, end: 1, text: 'Hello' }],
        }),
      ),
    20000,
  );
  res.on('close', () => clearTimeout(timer));
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
async function waitRequests(count) {
  for (let n = 0; n < 200 && asrRequests < count; n++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    asrRequests >= count,
    'ASR fixture must receive the active request before cancellation',
  );
}
async function call(operation, args = {}) {
  const endpoint = JSON.parse(
    fs.readFileSync(path.join(profile, 'automation/endpoint.json'), 'utf8'),
  );
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operation, args }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}
try {
  for (
    let i = 0;
    !fs.existsSync(path.join(profile, 'automation/endpoint.json')) && i < 100;
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call('system.info')).background, true);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    0,
  );
  // Launching the desktop against the same profile must activate this backend.
  const second = spawn(
    executablePath,
    [...(packaged ? [] : ['.']), `--automation-data-dir=${profile}`],
    { env, stdio: 'ignore' },
  );
  const page = await app.firstWindow({ timeout: 30000 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^app:\/\//);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.ipc));
  assert.equal((await call('system.info')).background, false);
  const settings = await call('settings.get');
  await call('settings.update', {
    settings: { ...settings.settings, language: 'en' },
  });
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getSettings'))).language,
    'en',
  );
  const glossary = await call('glossaries.create', {
    name: 'Desktop coexistence',
  });
  const glossaries = await page.evaluate(() =>
    window.ipc.invoke('glossaries:list'),
  );
  assert.ok(glossaries.some((g) => g.id === glossary.data.id));
  await call('providers.save', {
    kind: 'asr',
    provider: {
      id: 'cancel-asr',
      name: 'Cancel fixture',
      type: 'openaiCompatible',
      apiKey: 'fixture',
      apiUrl: `http://127.0.0.1:${mock.address().port}/v1`,
      models: 'fixture',
    },
  });
  const sample = await call('system.sample');
  const task = await call('transcribe', {
    files: [sample],
    engine: 'cloud',
    model: 'fixture',
    providerId: 'cancel-asr',
    sourceLanguage: 'en',
    config: { useEmbeddedSubtitles: false },
  });
  await waitRequests(1);
  await page.evaluate((id) => window.ipc.send('cancelTask', id), task.id);
  const cancelled = await call('tasks.wait', { id: task.id, timeoutMs: 25000 });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  const retry = await call('tasks.retry', {
    id: task.id,
    requestId: 'desktop-retry',
  });
  await waitRequests(2);
  assert.equal(
    (await call('tasks.retry', { id: task.id, requestId: 'desktop-retry' })).id,
    retry.id,
  );
  await page.evaluate((id) => window.ipc.send('cancelTask', id), task.id);
  assert.equal(
    (await call('tasks.wait', { id: retry.id, timeoutMs: 25000 })).status,
    'cancelled',
  );
  // The real BrowserWindow must be passed to native dialogs, not the service port.
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showOpenDialog = async (window) => {
      if (!(window instanceof BrowserWindow))
        throw new Error('Invalid dialog parent');
      return { canceled: true, filePaths: [] };
    };
  });
  await page.evaluate(() => window.ipc.invoke('toolbox:selectFolder'));
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  assert.deepEqual(errors, []);
  second.unref();
  console.log(
    JSON.stringify(
      {
        success: true,
        root,
        packaged: Boolean(packaged),
        checks: [
          'no-window startup',
          'desktop attaches to existing backend',
          'renderer IPC shares settings and resources',
          'native dialog parent',
          'desktop cancellation reaches automation outcome',
          'retry acknowledgement replay while the shared pipeline is running',
          'renderer screenshot',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  mock.closeAllConnections();
  mock.close();
  await app.close();
}
