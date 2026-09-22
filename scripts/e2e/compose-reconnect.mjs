import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-reconnect-e2e-'),
);
const source = path.join(output, 'source.mp4');
const video = path.join(output, 'long.mp4');
const subtitle = path.join(output, 'source.srt');
const destination = path.join(output, 'shared.mp4');
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=black:s=1280x720:r=25:d=1',
  '-c:v',
  'libx264',
  source,
]);
run(['-stream_loop', '1799', '-i', source, '-c', 'copy', video]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:30:00,000\nIdentity test\n',
);
const style = {
  fontName: 'Arial',
  fontSize: 30,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 1,
  shadow: 0,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};
const config = {
  videoPath: video,
  subtitlePath: subtitle,
  outputPath: destination,
  outputMode: 'hardcode',
  style,
  videoQuality: 'original',
  encoderMode: 'cpu',
};
const checks = [];
let app, page, peer;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate((config) => {
    window.reconnectRuns = [
      window.ipc.invoke('subtitleMerge:startMerge', {
        ...config,
        requestId: 'first-request',
      }),
    ];
  }, config);
  const jobs = () =>
    page.evaluate(
      async () => (await window.ipc.invoke('subtitleMerge:getQueue')).data,
    );
  await expect.poll(async () => (await jobs())[0]?.status).toBe('running');
  await page.evaluate((config) => {
    window.reconnectRuns.push(
      window.ipc.invoke('subtitleMerge:startMerge', {
        ...config,
        style: { ...config.style, fontSize: 50 },
        requestId: 'second-request',
      }),
    );
  }, config);
  await expect.poll(async () => (await jobs()).length).toBe(2);
  const [first, second] = await jobs();
  assert.equal(first.requestId, 'first-request');
  assert.equal(second.requestId, 'second-request');

  const opened = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const main = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('http://localhost'),
    );
    globalThis.reconnectPeer = new BrowserWindow({
      width: 1280,
      height: 900,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await globalThis.reconnectPeer.loadURL(
      new URL('/zh/subtitleMerge/', main.webContents.getURL()).href,
    );
  }, path.resolve('app/preload.js'));
  peer = await opened;
  const peerErrors = [];
  peer.on('pageerror', (error) => peerErrors.push(error.message));
  peer.setDefaultTimeout(20000);
  await expect(
    peer.getByRole('region', { name: '选择要恢复的导出作业' }),
  ).toBeVisible();
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toHaveCount(0);
  await app.evaluate(() => globalThis.reconnectPeer.setContentSize(1024, 700));
  assert.ok(
    await peer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await peer.screenshot({ path: path.join(output, 'job-choice-1024.png') });
  await peer.getByRole('button').filter({ hasText: second.id }).click();
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      peer.evaluate(
        () =>
          JSON.parse(localStorage.getItem('smartsub_compose_draft_v1:["",""]'))
            .job.jobId,
      ),
    )
    .toBe(second.id);
  await peer.screenshot({ path: path.join(output, 'selected-second.png') });
  await peer.evaluate(() => window.next.router.push('/zh/home/'));
  await peer.evaluate(() => window.next.router.push('/zh/subtitleMerge/'));
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toBeVisible();
  await expect(
    peer.getByRole('region', { name: '选择要恢复的导出作业' }),
  ).toHaveCount(0);
  await peer.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(
      async () => (await jobs()).find((job) => job.id === second.id)?.status,
    )
    .toBe('cancelled');
  assert.equal(
    (await jobs()).find((job) => job.id === first.id).status,
    'running',
  );
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toHaveCount(0);
  checks.push(
    'two real same-path jobs: explicit second-job selection, durable remount identity, peer receives queue terminal event, cancellation leaves first running',
  );

  // Emulate renderer loss before acknowledgement: only the pre-submission request ID survived.
  await peer.evaluate(() => window.next.router.push('/zh/home/'));
  await peer.evaluate(
    ({ first }) => {
      const key = 'smartsub_compose_draft_v1:["",""]';
      const draft = JSON.parse(localStorage.getItem(key));
      draft.job = { requestId: first.requestId };
      localStorage.setItem(key, JSON.stringify(draft));
    },
    { first },
  );
  await peer.evaluate(() => window.next.router.push('/zh/subtitleMerge/'));
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      peer.evaluate(
        () =>
          JSON.parse(localStorage.getItem('smartsub_compose_draft_v1:["",""]'))
            .job.jobId,
      ),
    )
    .toBe(first.id);
  await expect
    .poll(() =>
      peer.evaluate(() =>
        Number(
          document
            .querySelector('[role="progressbar"]')
            ?.getAttribute('aria-valuenow'),
        ),
      ),
    )
    .toBeGreaterThan(0);
  await peer.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(async () => (await jobs()).find((job) => job.id === first.id)?.status)
    .toBe('cancelled');
  await expect(
    peer.getByRole('button', { name: '取消', exact: true }),
  ).toHaveCount(0);
  assert.equal(
    (await fs.readdir(output)).some((name) =>
      name.startsWith('.smartsub-compose-'),
    ),
    false,
  );
  checks.push(
    'request-only persisted identity reconnects real running job in second window; exact running-job cancellation and private output cleanup',
  );
  await peer.getByRole('button', { name: '保存合成工程', exact: true }).click();
  await peer.evaluate(() => window.next.router.push('/zh/home/'));
  await fs.writeFile(destination, 'existing output');
  const terminal = await page.evaluate(
    (config) =>
      window.ipc.invoke('subtitleMerge:startMerge', {
        ...config,
        requestId: 'terminal-request',
      }),
    { ...config, videoPath: source },
  );
  assert.equal(terminal.success, true);
  assert.equal(terminal.data, path.join(output, 'shared_2.mp4'));
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing output');
  await peer.evaluate(() => {
    const key = 'smartsub_compose_draft_v1:["",""]';
    const draft = JSON.parse(localStorage.getItem(key));
    draft.job = { requestId: 'terminal-request' };
    localStorage.setItem(key, JSON.stringify(draft));
  });
  await peer.evaluate(() => window.next.router.push('/zh/subtitleMerge/'));
  await expect(peer.getByText('视频生成成功', { exact: true })).toBeVisible();
  await expect(
    peer.getByRole('textbox', { name: '选择输出路径', exact: true }),
  ).toHaveValue(terminal.data);
  await peer.screenshot({ path: path.join(output, 'terminal-output.png') });
  checks.push(
    'completion while away reconnects by request identity, displays collision-safe published path, preserves pre-existing output',
  );
  await fs.writeFile(
    path.join(output, 'checks.json'),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
  assert.deepEqual(peerErrors, [], 'no renderer/hydration errors');
} catch (error) {
  await peer
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error('Evidence:', output);
  throw error;
} finally {
  if (page && !page.isClosed()) {
    await page
      .evaluate(async () => {
        const queue = (await window.ipc.invoke('subtitleMerge:getQueue')).data;
        for (const job of queue.filter((job) =>
          ['queued', 'running'].includes(job.status),
        ))
          await window.ipc.invoke('subtitleMerge:cancelMerge', {
            jobId: job.id,
          });
        await Promise.all(window.reconnectRuns || []);
      })
      .catch(() => {});
  }
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
      )
      .catch(() => {});
    await app.close();
  }
}
