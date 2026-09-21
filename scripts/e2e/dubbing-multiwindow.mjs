import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-dubbing-multiwindow-e2e-'),
);
const subtitle = path.join(output, 'shared.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:05,000\nShared project.\n',
);
let app;
const wavPath = path.join(output, 'voice.wav');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=1',
  '-c:a',
  'pcm_s16le',
  wavPath,
]);
const wav = await fs.readFile(wavPath);
let requests = 0,
  releaseAudio;
const server = http.createServer(async (request, response) => {
  for await (const chunk of request) {
    /* Consume the synthesis request. */
  }
  requests++;
  releaseAudio = () => {
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(wav);
  };
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const errors = [],
  checks = [];
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  const first = await app.firstWindow();
  first.on('pageerror', (error) => errors.push(error.message));
  await first.waitForURL(/^http:\/\/localhost:\d+/);
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
    const load = ipcMain._invokeHandlers.get('dubbing:loadSubtitle');
    globalThis.dubbingLoads = [];
    ipcMain.removeHandler('dubbing:loadSubtitle');
    ipcMain.handle('dubbing:loadSubtitle', async (...args) => {
      const result = await load(...args);
      globalThis.dubbingLoads.push({ payload: args[1], result });
      return result;
    });
  });
  await first.getByRole('button', { name: '跳过', exact: true }).click();
  const session = await first.evaluate(
    async ({ subtitle, url }) => {
      window.ipc.send('setTtsProviders', [
        {
          id: 'shared',
          name: 'Shared voice',
          type: 'openaiCompatible',
          apiKey: 'fixture',
          apiUrl: url,
          model: 'fixture',
          voices: 'voice',
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({
          engineKey: 'cloud:shared',
          voice: 'voice',
          globalSpeed: 1,
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
    },
    { subtitle, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  const route = `/zh/dubbing/?session=${session.sessionId}`;
  const go = (page, route) =>
    page.evaluate((route) => window.next.router.push(route), route);
  const speed = (page) =>
    page.getByRole('slider', { name: '整体语速', exact: true });
  const start = (page) =>
    page.getByRole('button', { name: '开始配音', exact: true });
  const locked = (page) =>
    page
      .getByRole('alert')
      .filter({ hasText: '此配音项目正在其他窗口或流水线中使用' });
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  const metadata = path.join(
    root,
    'dubbing-sessions',
    session.sessionId,
    'session.json',
  );
  const meta = async () => JSON.parse(await fs.readFile(metadata, 'utf8'));
  await go(first, route);
  await expect(start(first)).toBeEnabled();
  const firstLease = await app.evaluate(
    () => globalThis.dubbingLoads.at(-1).result.data.leaseId,
  );
  assert.ok(firstLease && firstLease !== 'fixture');
  await go(first, '/zh/home/');
  await go(first, route);
  await expect(start(first)).toBeEnabled();
  const nextLease = await app.evaluate(
    () => globalThis.dubbingLoads.at(-1).result.data.leaseId,
  );
  assert.ok(nextLease && nextLease !== firstLease);
  const leaseBefore = await fs.readFile(metadata, 'utf8');
  const late = await first.evaluate(
    async ({ sessionId, leaseId }) => {
      const snapshot = await window.ipc.invoke('dubbing:getSession', {
        sessionId,
      });
      const acquire = await window.ipc.invoke('dubbing:loadSubtitle', {
        sessionId,
        leaseId,
      });
      const rejected = [];
      for (const name of [
        'syncVoiceState',
        'readConfigDraft',
        'writeConfigDraft',
        'readCueDraft',
        'writeCueDraft',
        'saveCueTexts',
        'setMedia',
        'start',
        'setSpeakerVoice',
        'setSpeakerSettings',
        'resynthesizeCue',
        'setCueVoice',
        'borrowSilence',
        'export',
        'cancel',
      ])
        rejected.push(
          await window.ipc.invoke(`dubbing:${name}`, { sessionId, leaseId }),
        );
      const released = await window.ipc.invoke('dubbing:disposeSession', {
        sessionId,
        leaseId,
      });
      return { snapshot, acquire, rejected, released };
    },
    { sessionId: session.sessionId, leaseId: firstLease },
  );
  assert.equal(late.snapshot.success, true);
  assert.equal(late.snapshot.data.leaseId, undefined);
  assert.equal(late.acquire.success, false);
  assert.match(late.acquire.error, /released/);
  assert.ok(late.rejected.every((result) => result.success === false));
  assert.equal(late.released.data, false);
  assert.equal(await fs.readFile(metadata, 'utf8'), leaseBefore);
  await expect(start(first)).toBeEnabled();
  checks.push(
    'same-window reopening rotates lease; all 11 stale writes plus 4 journal endpoints, stale acquisition and late release rejected; read-only snapshot has no lease and preserves metadata',
  );
  const cancelledLease = await first.evaluate(
    async ({ subtitle, media }) => {
      const leaseId = crypto.randomUUID();
      const loading = window.ipc.invoke('dubbing:loadSubtitle', {
        subtitlePath: subtitle,
        videoPath: media,
        leaseId,
      });
      const cancellation = await window.ipc.invoke('dubbing:disposeSession', {
        leaseId,
      });
      const result = await loading;
      const retry = await window.ipc.invoke('dubbing:loadSubtitle', {
        subtitlePath: subtitle,
        leaseId,
      });
      return { cancellation, result, retry };
    },
    { subtitle, media: wavPath },
  );
  assert.equal(cancelledLease.cancellation.data, true);
  assert.equal(cancelledLease.result.success, false);
  assert.match(cancelledLease.result.error, /closed while loading/);
  assert.equal(cancelledLease.retry.success, false);
  const survivingSessions = await fs.readdir(
    path.dirname(path.dirname(metadata)),
  );
  assert.deepEqual(
    survivingSessions.filter((name) => !name.startsWith('.')),
    [session.sessionId],
  );
  checks.push(
    'cancel during actual asynchronous media probing deletes the abandoned session and permanently rejects the retired lease',
  );
  const conflicting = await first.evaluate(
    (sessionId) =>
      window.ipc.invoke('dubbing:loadSubtitle', {
        leaseId: 'conflicting',
        sessionId,
        rebuildSessionId: 'unrelated-project',
      }),
    session.sessionId,
  );
  assert.equal(conflicting.success, false);
  assert.match(conflicting.error, /Conflicting/);
  const opened = app.waitForEvent('window');
  await app.evaluate(
    async ({ BrowserWindow }, { route, preload }) => {
      const owner = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('http://localhost'),
      );
      const peer = new BrowserWindow({
        width: 1024,
        height: 700,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      globalThis.dubbingPeer = peer;
      await peer.loadURL(new URL(route, owner.webContents.getURL()).href);
    },
    { route, preload: path.resolve('app/preload.js') },
  );
  const second = await opened;
  second.setDefaultTimeout(20000);
  second.on('pageerror', (error) => errors.push(error.message));
  await expect(locked(second)).toBeVisible();
  const deletionDenied = await second.evaluate(async (id) => {
    const outcomes = [];
    for (const channel of [
      'deleteWorkItem',
      'deleteTaskProject',
      'clearAllWorkItems',
    ]) {
      try {
        await window.ipc.invoke(channel, id);
        outcomes.push(false);
      } catch (error) {
        outcomes.push(String(error).includes('Project is open or running'));
      }
    }
    return outcomes;
  }, session.workItemId);
  assert.deepEqual(deletionDenied, [true, true, true]);
  await fs.access(metadata);
  checks.push(
    'Both task deletion endpoints and clear-all reject a project owned by another window, preserving metadata',
  );
  await expect(speed(second)).toHaveCount(0);
  await expect(
    second.getByRole('button', { name: '选择字幕', exact: true }),
  ).toBeDisabled();
  const before = await fs.readFile(metadata, 'utf8');
  const denied = await second.evaluate(async (sessionId) => {
    const outcomes = [];
    for (const name of [
      'syncVoiceState',
      'readConfigDraft',
      'writeConfigDraft',
      'readCueDraft',
      'writeCueDraft',
      'saveCueTexts',
      'setMedia',
      'start',
      'setSpeakerVoice',
      'setSpeakerSettings',
      'resynthesizeCue',
      'setCueVoice',
      'borrowSilence',
      'export',
      'cancel',
    ])
      outcomes.push(await window.ipc.invoke(`dubbing:${name}`, { sessionId }));
    outcomes.push(
      await window.ipc.invoke('dubbing:disposeSession', { sessionId }),
    );
    return outcomes;
  }, session.sessionId);
  assert.ok(denied.slice(0, -1).every((result) => result.success === false));
  assert.equal(denied.at(-1).data, false);
  assert.equal(await fs.readFile(metadata, 'utf8'), before);
  await second.setViewportSize({ width: 1024, height: 700 });
  assert.ok(
    await second.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await second.screenshot({ path: path.join(output, 'locked-1024.png') });
  await go(second, '/zh/home/');
  await speed(first).focus();
  await speed(first).press('ArrowRight');
  await expect(start(first)).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, 1.05);
  checks.push(
    'second window cannot mutate/cancel/dispose first session; leaving waiter preserves owner',
  );
  await go(second, route);
  await expect(locked(second)).toBeVisible();
  await go(first, '/zh/home/');
  await expect(locked(second)).toHaveCount(0);
  await expect(start(second)).toBeEnabled();
  await expect(speed(second)).toHaveAttribute('aria-valuenow', '1.05');
  await speed(second).focus();
  await speed(second).press('ArrowRight');
  await expect(start(second)).toBeEnabled();
  assert.equal((await meta()).configSnapshot.globalSpeed, 1.1);
  await start(second).click();
  await expect.poll(() => requests).toBe(1);
  await go(first, route);
  await expect(locked(first)).toBeVisible();
  await app.evaluate(() =>
    globalThis.dubbingPeer.webContents.forcefullyCrashRenderer(),
  );
  await expect(locked(first)).toHaveCount(0);
  await expect(
    first.getByRole('button', { name: '取消', exact: true }),
  ).toBeEnabled();
  releaseAudio();
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  assert.equal((await meta()).cues[0].status, 'done');
  assert.equal(requests, 1);
  await expect(speed(first)).toHaveAttribute('aria-valuenow', '1.1');
  checks.push(
    'navigation and actual renderer crash release ownership; waiting editor reloads latest config, receives running batch progress and completion with one HTTP request',
  );
  await first.reload();
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  await expect(speed(first)).toHaveAttribute('aria-valuenow', '1.1');
  await first
    .getByRole('button', { name: '重新合成该行', exact: true })
    .click();
  await expect.poll(() => requests).toBe(2);
  await go(first, '/zh/home/');
  await go(first, route);
  await expect(
    first.getByRole('button', { name: '取消', exact: true }),
  ).toBeEnabled();
  releaseAudio();
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  assert.equal((await meta()).cues[0].status, 'done');
  assert.equal(requests, 2);
  checks.push(
    'single-cue regeneration survives page departure and reconnects through a terminal snapshot',
  );
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs');
    const original = fs.promises.copyFile;
    globalThis.restoreCopy = () => {
      fs.promises.copyFile = original;
    };
    fs.promises.copyFile = async (...args) => {
      if (String(args[1]).includes('.smartsub-compose-'))
        await new Promise((resolve) => {
          globalThis.releaseExport = resolve;
        });
      return original(...args);
    };
  });
  await first.getByRole('button', { name: '导出', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseExport))
    .toBe('function');
  await go(first, '/zh/home/');
  await go(first, route);
  await expect(
    first.getByRole('button', { name: '取消', exact: true }),
  ).toBeEnabled();
  await app.evaluate(() => {
    globalThis.restoreCopy();
    globalThis.releaseExport();
  });
  const exported = path.join(output, 'shared-dubbed.wav');
  await expect(first.getByText(exported, { exact: true })).toBeVisible();
  execFileSync(ffmpeg, ['-v', 'error', '-i', exported, '-f', 'null', '-']);
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  checks.push(
    'in-flight real WAV export survives route departure; reconnect receives output path and leaves busy state',
  );
  const loseReply = async (channel, mode) => {
    await app.evaluate(
      ({ ipcMain }, { channel, mode }) => {
        const handler = ipcMain._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, payload) => {
          const result = handler(event, payload);
          globalThis.lastOperation = { channel, payload };
          globalThis.replayOperation = async (conflict = false) =>
            handler(
              event,
              conflict
                ? {
                    ...payload,
                    config: { ...payload.config, globalSpeed: 1.7 },
                  }
                : payload,
            );
          if (mode === 'early') {
            void result.catch(() => {});
            throw new Error('fixture acknowledgement lost while running');
          }
          await result;
          if (mode === 'hang') return new Promise(() => {});
          throw new Error('fixture acknowledgement lost after completion');
        });
        globalThis.restoreOperation = () => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, handler);
        };
      },
      { channel, mode },
    );
  };
  await loseReply('dubbing:resynthesizeCue', 'early');
  await first
    .getByRole('button', { name: '重新合成该行', exact: true })
    .click();
  await expect.poll(() => requests).toBe(3);
  await first.waitForTimeout(1200);
  await expect(
    first.getByRole('button', { name: '重新合成该行', exact: true }),
  ).toBeDisabled();
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeDisabled();
  const duplicate = app.evaluate(() => globalThis.replayOperation());
  const conflictingOperation = await app.evaluate(() =>
    globalThis.replayOperation(true),
  );
  assert.equal(conflictingOperation.success, false);
  assert.match(conflictingOperation.error, /conflicts/);
  assert.equal(requests, 3);
  releaseAudio();
  assert.equal((await duplicate).success, true);
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  assert.equal(
    (await app.evaluate(() => globalThis.replayOperation())).success,
    true,
  );
  assert.equal(requests, 3);
  await app.evaluate(() => globalThis.restoreOperation());
  checks.push(
    'Lost single-cue acknowledgement while HTTP is pending keeps edits/export disabled; duplicate request joins exactly one synthesis, conflicting reuse rejected, completed replay does not call TTS',
  );

  await loseReply('dubbing:start', 'hang');
  await first.getByRole('button', { name: '重新合成', exact: true }).click();
  await expect.poll(() => requests).toBe(4);
  releaseAudio();
  await expect(
    first.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  assert.equal((await meta()).cues[0].status, 'done');
  assert.equal(requests, 4);
  await app.evaluate(() => globalThis.restoreOperation());
  checks.push(
    'Permanently withheld batch acknowledgement resolves through operation status and renders completed cues without a second synthesis',
  );

  await loseReply('dubbing:export', 'complete');
  await first.getByRole('button', { name: '导出', exact: true }).click();
  const secondExport = path.join(output, 'shared-dubbed_2.wav');
  await expect(first.getByText(secondExport, { exact: true })).toBeVisible();
  const replayedExport = await app.evaluate(() => globalThis.replayOperation());
  assert.equal(replayedExport.data.outputPath, secondExport);
  assert.equal(
    (await fs.readdir(output)).filter((file) =>
      /^shared-dubbed.*\.wav$/.test(file),
    ).length,
    2,
  );
  execFileSync(ffmpeg, ['-v', 'error', '-i', secondExport, '-f', 'null', '-']);
  await app.evaluate(() => globalThis.restoreOperation());
  checks.push(
    'Export acknowledgement rejected after actual WAV publication reconnects to the exact output; replay creates no additional file',
  );
  await first.screenshot({ path: path.join(output, 'recovered.png') });
  await go(first, '/zh/home/');
  const savedWav = (await meta()).cues[0].wavFile;
  await fs.writeFile(
    subtitle,
    '1\n00:00:00,000 --> 00:00:05,000\nChanged input.\n',
  );
  await go(first, route);
  await expect(first.getByRole('alertdialog')).toContainText('字幕内容已变化');
  const anotherWindow = app.waitForEvent('window');
  await app.evaluate(
    async ({ BrowserWindow }, { route, preload }) => {
      const owner = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('http://localhost'),
      );
      const peer = new BrowserWindow({
        width: 1440,
        height: 900,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await peer.loadURL(new URL(route, owner.webContents.getURL()).href);
    },
    { route, preload: path.resolve('app/preload.js') },
  );
  const third = await anotherWindow;
  third.on('pageerror', (error) => errors.push(error.message));
  await expect(locked(third)).toBeVisible();
  assert.ok(
    await third.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await third.screenshot({ path: path.join(output, 'locked-1440.png') });
  await first
    .getByRole('alertdialog')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(third.getByRole('alertdialog')).toContainText('字幕内容已变化');
  await third
    .getByRole('alertdialog')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal((await meta()).cues[0].wavFile, savedWav);
  await fs.access(path.join(path.dirname(metadata), savedWav));
  checks.push(
    'stale-source confirmation also owns the session; declining releases the reservation without deleting old audio; 1440 bounds',
  );
  await go(first, '/zh/home/');
  await go(first, route);
  await expect(first.getByRole('alertdialog')).toContainText('字幕内容已变化');
  const reservation = await app.evaluate(
    () => globalThis.dubbingLoads.at(-1).result.data.leaseId,
  );
  await first
    .getByRole('alertdialog')
    .getByRole('button', { name: '重建会话', exact: true })
    .click();
  await expect(start(first)).toBeEnabled();
  await expect(
    first.getByText('Changed input.', { exact: true }),
  ).toBeVisible();
  const rebuilt = await app.evaluate(
    () =>
      globalThis.dubbingLoads.findLast(
        (entry) => entry.payload.rebuildSessionId,
      )?.result.data,
  );
  assert.ok(rebuilt?.sessionId && rebuilt.sessionId !== session.sessionId);
  assert.equal(rebuilt.leaseId, reservation);
  assert.equal(rebuilt.workItemId, session.workItemId);
  await assert.rejects(fs.access(metadata), { code: 'ENOENT' });
  checks.push(
    'confirmed rebuild retains reservation and task identity, acquires the replacement session and deletes old data only after publication',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ output, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  console.error({ output, errors });
  for (const [index, page] of ((await app?.windows()) || []).entries())
    await page
      .screenshot({ path: path.join(output, `failure-${index}.png`) })
      .catch(() => {});
  throw error;
} finally {
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    )
    .catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
