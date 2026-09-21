import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-auto-fit-e2e-'),
);
const subtitle = path.join(output, 'alignment.srt');
await fs.writeFile(
  subtitle,
  [
    'Fits small overrun.',
    'Long second sentence needs more time.',
    'Long third sentence needs shortening.',
    'Last.',
  ]
    .map(
      (text, index) =>
        `${index + 1}\n00:00:${String([0, 4, 8, 10][index]).padStart(2, '0')},000 --> 00:00:${String([2, 6, 10, 12][index]).padStart(2, '0')},000\n${text}\n`,
    )
    .join('\n'),
);
const waves = new Map();
for (const duration of [1800, 2200, 2800]) {
  const target = path.join(output, `tone-${duration}.wav`);
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=24000:duration=${duration / 1000}`,
    '-c:a',
    'pcm_s16le',
    target,
  ]);
  waves.set(duration, await fs.readFile(target));
}
const requests = [],
  aiRequests = [],
  held = [];
let holdAi = false,
  failAi = false;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/v1/audio/speech') {
      requests.push(body);
      const duration = body.input.startsWith('Long')
        ? 2800
        : body.input.startsWith('Fits')
          ? 2200
          : 1800;
      return response
        .writeHead(200, { 'Content-Type': 'audio/wav' })
        .end(waves.get(duration));
    }
    aiRequests.push(body);
    const send = () => {
      if (failAi)
        return response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify({
              error: { message: 'shortening fixture unavailable' },
            }),
          );
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Short.' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    };
    if (holdAi) held.push(send);
    else send();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page, locked;
const errors = [];
try {
  app = await _electron.launch({
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
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const session = await page.evaluate(
    async ({ subtitle, url }) => {
      window.ipc.send('setTtsProviders', [
        {
          id: 'fit-tts',
          name: 'Fit TTS',
          type: 'openaiCompatible',
          apiKey: 'test-only',
          apiUrl: url,
          model: 'fixture',
          voices: 'alloy',
        },
      ]);
      window.ipc.send('setTranslationProviders', [
        {
          id: 'fit-ai',
          name: 'Fit AI',
          type: 'openai',
          isAi: true,
          apiUrl: url,
          apiKey: 'test-only',
          modelName: 'fixture',
          prompt: '${content}',
          requestInterval: 0,
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({
          engineKey: 'cloud:fit-tts',
          voice: 'alloy',
          language: 'en',
          globalSpeed: 1,
          output: 'audioOnly',
          background: 'mute',
          audioFormat: 'wav',
          overflow: 'truncate',
          overlapMode: 'shift',
        }),
      );
      const loaded = await window.ipc.invoke('dubbing:loadSubtitle', {
        leaseId: 'fixture',
        subtitlePath: subtitle,
      });
      if (!loaded.success) throw new Error(loaded.error);
      await window.ipc.invoke('dubbing:disposeSession', {
        sessionId: loaded.data.sessionId,
        leaseId: 'fixture',
      });
      await window.next.router.push(
        `/zh/dubbing/?session=${loaded.data.sessionId}`,
      );
      return loaded.data;
    },
    { subtitle, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  const snapshot = async () =>
    (
      await page.evaluate(
        (sessionId) => window.ipc.invoke('dubbing:getSession', { sessionId }),
        session.sessionId,
      )
    ).data;
  const overrun = (index) => page.getByTestId(`overrun-${index}`);
  await app.evaluate(({ ipcMain }) => {
    globalThis.actionFault = 'start';
    for (const operation of ['start', 'cancel', 'export']) {
      const channel = `dubbing:${operation}`;
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        if (globalThis.actionFault === operation)
          throw new Error(`Injected ${operation} transport failure`);
        if (operation === 'start' && globalThis.actionFault === 'hold')
          await new Promise((resolve) => {
            globalThis.releaseBatch = resolve;
          });
        return original(...args);
      });
    }
  });
  const start = page.getByRole('button', { name: '开始配音', exact: true });
  await start.click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Injected start transport failure' }),
  ).toBeVisible();
  await expect(start).toBeEnabled();
  assert.equal(requests.length, 0);
  await app.evaluate(() => {
    globalThis.actionFault = 'hold';
  });
  await start.click();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseBatch))
    .toBe('function');
  await app.evaluate(() => {
    globalThis.actionFault = 'cancel';
  });
  const cancel = page.getByRole('button', { name: '取消', exact: true });
  await cancel.click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Injected cancel transport failure' }),
  ).toBeVisible();
  await expect(cancel).toBeEnabled();
  await app.evaluate(() => {
    globalThis.actionFault = '';
    globalThis.releaseBatch();
  });
  await expect(overrun(1)).toBeVisible();
  await expect(overrun(2)).toBeVisible();
  await expect(overrun(1)).toContainText('超限 +0.80s');
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(async () =>
      (await snapshot()).cues.every((cue) =>
        ['done', 'overlong'].includes(cue.status),
      ),
    )
    .toBe(true);
  let state = await snapshot();
  assert.equal(state.cues[0].originalMeasuredMs, 2200);
  assert.equal(state.cues[0].synthesizedMs, 2000);
  assert.equal(state.cues[1].synthesizedMs, 2800);
  assert.ok(requests.every((request) => request.speed === 1));
  const oldWav = state.cues[1].wavPath;
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({ path: path.join(output, `overrun-${width}.png`) });
  }
  locked = path.dirname(oldWav);
  await fs.chmod(locked, 0o500);
  await overrun(1).getByRole('button', { name: '借用后续空白' }).click();
  await expect(page.getByText(/EACCES/).first()).toBeVisible();
  assert.equal((await snapshot()).cues[1].status, 'overlong');
  await fs.chmod(locked, 0o700);
  locked = undefined;
  await overrun(1).getByRole('button', { name: '借用后续空白' }).click();
  await expect(overrun(1)).toHaveCount(0);
  await expect(page.getByText('已借用后续空白 0.80s')).toBeVisible();
  state = await snapshot();
  assert.equal(state.cues[1].wavPath, oldWav);
  assert.equal(state.cues[1].borrowedMs, 800);
  await overrun(2).getByRole('button', { name: '借用后续空白' }).click();
  await expect(page.getByText(/后续空白不足/).first()).toBeVisible();
  assert.equal((await snapshot()).cues[2].status, 'overlong');
  failAi = true;
  await overrun(2).getByRole('button', { name: 'AI 缩写并重生成' }).click();
  await expect(overrun(2)).toBeVisible();
  await expect(
    page.getByText(/shortening fixture unavailable/).first(),
  ).toBeVisible();
  assert.equal(requests.length, 4);
  failAi = false;
  holdAi = true;
  await overrun(2).getByRole('button', { name: 'AI 缩写并重生成' }).click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByRole('button', { name: '取消缩写' }).click();
  held.shift()();
  await expect(overrun(2)).toBeVisible();
  assert.equal(requests.length, 4);
  holdAi = false;
  await overrun(2).getByRole('button', { name: 'AI 缩写并重生成' }).click();
  await expect(overrun(2)).toHaveCount(0);
  await expect(page.getByText('Short.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await snapshot()).cues[2].status).toBe('done');
  state = await snapshot();
  assert.equal(state.cues[2].synthesizedMs, 1800);
  assert.equal(requests.length, 5);
  assert.ok(
    aiRequests
      .at(-1)
      .messages.some((message) =>
        message.content.includes('Target spoken duration: 2 seconds'),
      ),
  );
  const exportedPath = path.join(output, 'alignment-dubbed.wav');
  await app.evaluate(() => {
    globalThis.actionFault = 'export';
  });
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Injected export transport failure' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  await assert.rejects(fs.stat(exportedPath), { code: 'ENOENT' });
  await app.evaluate(() => {
    globalThis.actionFault = '';
  });
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(
    page.getByRole('main').getByText('导出完成', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(exportedPath, { exact: true })).toBeVisible();
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-i',
    exportedPath,
    '-f',
    's16le',
    '-ar',
    '24000',
    '-ac',
    '1',
    'pipe:1',
  ]);
  const peak = (a, b) => {
    let value = 0;
    for (
      let i = Math.round(a * 24000);
      i < Math.min(pcm.length / 2, Math.round(b * 24000));
      i++
    )
      value = Math.max(value, Math.abs(pcm.readInt16LE(i * 2)));
    return value;
  };
  assert.ok(peak(6.6, 6.75) > 1000, 'borrowed full tail exported');
  assert.equal(peak(7, 7.95), 0, 'remaining real silence kept');
  assert.ok(peak(8.05, 8.2) > 1000, 'following cue retains original start');
  const priorAudio = await fs.readFile(exportedPath);
  await page.getByRole('button', { name: '高级选项', exact: true }).click();
  await page
    .getByRole('switch', { name: '同时导出对齐后字幕', exact: true })
    .click();
  const occupiedSubtitle = path.join(output, 'alignment-dubbed_2.dubbed.srt');
  await fs.writeFile(occupiedSubtitle, 'existing user subtitle');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pairedAudio = path.join(output, 'alignment-dubbed_3.wav');
  await expect(page.getByText(pairedAudio, { exact: true })).toBeVisible();
  assert.deepEqual(await fs.readFile(pairedAudio), priorAudio);
  assert.deepEqual(await fs.readFile(exportedPath), priorAudio);
  assert.equal(
    await fs.readFile(occupiedSubtitle, 'utf8'),
    'existing user subtitle',
  );
  assert.match(
    await fs.readFile(
      path.join(output, 'alignment-dubbed_3.dubbed.srt'),
      'utf8',
    ),
    /Short\./,
  );
  await assert.rejects(fs.stat(path.join(output, 'alignment-dubbed_2.wav')), {
    code: 'ENOENT',
  });
  await page.getByRole('combobox', { name: '音频格式', exact: true }).click();
  await page.getByRole('option', { name: 'MP3', exact: true }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const mp3 = path.join(output, 'alignment-dubbed.mp3');
  await expect(page.getByText(mp3, { exact: true })).toBeVisible();
  execFileSync(ffmpeg, ['-v', 'error', '-i', mp3, '-f', 'null', '-']);
  locked = output;
  await fs.chmod(output, 0o500);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByText(/EACCES/).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  await fs.chmod(output, 0o700);
  locked = undefined;
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(
    page.getByText(path.join(output, 'alignment-dubbed_4.mp3'), {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    (await fs.readdir(output)).some((name) =>
      name.startsWith('.smartsub-compose-'),
    ),
    false,
  );
  assert.equal(requests.length, 5);
  await page.reload();
  await expect(page.getByText('已借用后续空白 0.80s')).toBeVisible();
  await expect(page.getByText('Short.', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'resolved.png') });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      output,
      sessionId: session.sessionId,
      requests: requests.length,
      aiRequests: aiRequests.length,
      checks:
        'start/cancel/export transport rejection and retry without pageerror, original window fit, red overrun at 1024/1440, disk failure/retry, gap collision rejection, AI failure/cancel/retry, actual PCM tail and next-cue timestamps, repeated WAV/MP3 and paired caption collision protection, export permission failure/retry, reload persistence',
    }),
  );
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  for (const send of held) send();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
