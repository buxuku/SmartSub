import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-storage-e2e-'),
);
const profile = path.join(evidence, 'profile');
const source = path.join(evidence, 'durability.srt');
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:02,000\nPersistence test\n',
);
let app;
let page;
let lockedDirectory;
let configPath;
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
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
  });
}
async function readDisk() {
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}
try {
  await launch();
  await page.goto(
    `${new URL(page.url()).origin}/zh/proofread/?file=${encodeURIComponent(source)}`,
  );
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const created = await page.evaluate(
    async (source) =>
      window.ipc.invoke('createProofreadTask', {
        name: 'Durable batch',
        items: [
          {
            id: 'durable-file',
            sourceSubtitlePath: source,
            detectedSubtitles: [],
          },
        ],
      }),
    source,
  );
  assert.equal(created.success, true);
  assert.equal(created.data.items[0].id, 'durable-file');
  for (const directory of [profile, `${profile}-dev`]) {
    const candidate = path.join(directory, 'config.json');
    if (
      await fs.stat(candidate).then(
        () => true,
        () => false,
      )
    ) {
      const config = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (config.workItems?.some((item) => item.id === created.data.id))
        configPath = candidate;
    }
  }
  assert.ok(configPath, 'acknowledged creation is already on disk');
  const updated = await page.evaluate(
    async (taskId) =>
      window.ipc.invoke('updateProofreadTask', {
        taskId,
        updates: { name: 'Immediate disk update' },
      }),
    created.data.id,
  );
  assert.equal(updated.success, true);
  assert.equal(
    (await readDisk()).workItems.find((item) => item.id === created.data.id)
      .name,
    'Immediate disk update',
  );

  await page.goto(
    `${new URL(page.url()).origin}/zh/proofread/?workItem=${created.data.id}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Immediate disk update', exact: true }),
  ).toBeVisible();
  if (process.platform !== 'win32') {
    lockedDirectory = path.dirname(configPath);
    await fs.chmod(lockedDirectory, 0o500);
    await page
      .getByRole('heading', { name: 'Immediate disk update', exact: true })
      .click();
    await page.getByPlaceholder('输入任务名称').fill('Retry recovered');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('status').filter({ hasText: '保存失败' }),
    ).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'EACCES' }),
    ).toBeVisible();
    const inMemory = await page.evaluate(
      async (id) =>
        (await window.ipc.invoke('getProofreadTaskById', { id })).data,
      created.data.id,
    );
    assert.equal(
      inMemory.name,
      'Immediate disk update',
      'failed disk write must not publish edited state',
    );
    assert.equal(
      (await readDisk()).workItems.find((item) => item.id === created.data.id)
        .name,
      'Immediate disk update',
    );
    await page.getByRole('link', { name: '启动台', exact: true }).click();
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page).toHaveURL(/proofread/);
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await page.screenshot({
      path: path.join(evidence, 'disk-failure-retained.png'),
    });
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存' }),
    ).toBeVisible();
    assert.equal(
      (await readDisk()).workItems.find((item) => item.id === created.data.id)
        .name,
      'Retry recovered',
    );
  }

  // Kill immediately after IPC acknowledgement: before-quit cannot flush for us.
  const crashed = await page.evaluate(
    async (taskId) =>
      window.ipc.invoke('updateProofreadTask', {
        taskId,
        updates: { name: 'Survives SIGKILL' },
      }),
    created.data.id,
  );
  assert.equal(crashed.success, true);
  const electronProcess = app.process();
  const exited = new Promise((resolve) =>
    electronProcess.once('exit', resolve),
  );
  electronProcess.kill('SIGKILL');
  await exited;
  app = undefined;
  await launch();
  const recovered = await page.evaluate(
    async (id) =>
      (await window.ipc.invoke('getProofreadTaskById', { id })).data,
    created.data.id,
  );
  assert.equal(recovered.name, 'Survives SIGKILL');
  await page.goto(
    `${new URL(page.url()).origin}/zh/proofread/?workItem=${created.data.id}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Survives SIGKILL', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, 'restarted-after-crash.png'),
  });
  console.log(
    JSON.stringify({
      success: true,
      evidence,
      checks: [
        'creation and update present on disk before acknowledgement',
        'stable item identity',
        ...(process.platform !== 'win32'
          ? [
              'real permission failure visible',
              'failed save preserves disk and memory',
              'failed save blocks navigation',
              'retry after permission recovery',
            ]
          : []),
        'acknowledged save survives SIGKILL and restart',
      ],
    }),
  );
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(evidence, 'unexpected-failure.png') })
      .catch(() => {});
  console.error('Storage evidence:', evidence, error);
  throw error;
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  if (app) {
    await app.close().catch(() => {});
  }
}
