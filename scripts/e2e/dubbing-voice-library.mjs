import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const volc = process.argv.includes('--volc');
const mimo = process.argv.includes('--mimo');
const output = await fs.mkdtemp(
  path.join(
    os.tmpdir(),
    volc
      ? 'smartsub-volc-library-e2e-'
      : mimo
        ? 'smartsub-mimo-library-e2e-'
        : 'smartsub-voice-library-e2e-',
  ),
);
const subtitle = path.join(output, 'voices.srt');
const voice = path.join(output, 'six-seconds.wav');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:10,000\nFirst sentence.\n\n2\n00:00:10,000 --> 00:00:20,000\nSecond sentence.\n',
);
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=6',
  '-c:a',
  'pcm_s16le',
  voice,
]);
const bytes = volc
  ? execFileSync(ffmpeg, ['-v', 'error', '-i', voice, '-f', 's16le', 'pipe:1'])
  : await fs.readFile(voice);
const requests = [];
let failNext = false;
let openResponses = 0;
const server = http.createServer((request, response) => {
  if (
    request.url !==
    (volc ? '/volc' : mimo ? '/v1/chat/completions' : '/v1/audio/speech')
  )
    return response.writeHead(404).end();
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (failNext) {
      failNext = false;
      response
        .writeHead(503, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify(
            volc
              ? { code: 55000000, message: 'fixture unavailable' }
              : { error: { message: 'fixture unavailable' } },
          ),
        );
      return;
    }
    let interval;
    openResponses++;
    const timer = setTimeout(
      () => {
        response.writeHead(200, {
          'Content-Type': volc || mimo ? 'application/json' : 'audio/wav',
        });
        if (mimo) {
          assert.equal(body.stream, false);
          response.end(
            JSON.stringify({
              choices: [
                { message: { audio: { data: bytes.toString('base64') } } },
              ],
            }),
          );
          return;
        }
        let offset = 0;
        interval = setInterval(() => {
          if (offset >= bytes.length) {
            clearInterval(interval);
            response.end(
              volc ? JSON.stringify({ code: 20000000, data: null }) : undefined,
            );
          } else {
            const chunk = bytes.subarray(offset, offset + 12000);
            response.write(
              volc
                ? JSON.stringify({ code: 0, data: chunk.toString('base64') }) +
                    '\n'
                : chunk,
            );
            offset += 12000;
          }
        }, 50);
      },
      (body.voice || body.req_params?.speaker || body.audio?.voice) ===
        'voice-0002'
        ? 1200
        : 0,
    );
    response.on('close', () => {
      clearTimeout(timer);
      clearInterval(interval);
      openResponses--;
    });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page, lockedDirectory;
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
  if (volc)
    await app.evaluate((_electron, url) => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) =>
        original(
          String(input) ===
            'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
            ? url
            : input,
          init,
        );
    }, `http://127.0.0.1:${server.address().port}/volc`);
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const session = await page.evaluate(
    async ({ subtitle, url, volc, mimo }) => {
      const voices = Array.from(
        { length: 1200 },
        (_, i) => `voice-${String(i).padStart(4, '0')}`,
      );
      window.ipc.send('setTtsProviders', [
        {
          id: 'library-test',
          name: 'Library test',
          type: volc ? 'volcengine' : mimo ? 'xiaomiMimo' : 'openaiCompatible',
          apiKey: 'test-only',
          apiUrl: url,
          model: 'test',
          resourceId: 'seed-tts-2.0',
          voices: voices.join(','),
          voiceMetadata: {
            [voices[0]]: { lang: 'en-US', gender: 'female', styles: ['news'] },
            [voices[1]]: { lang: 'zh-CN', gender: 'child', styles: ['anime'] },
            [voices[2]]: { lang: 'en-GB', gender: 'male', styles: ['story'] },
          },
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({
          engineKey: 'cloud:library-test',
          voice: voices[0],
          language: 'en',
          globalSpeed: 1,
          output: 'audioOnly',
          background: 'mute',
          audioFormat: 'wav',
          overflow: 'truncate',
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
      const AudioConstructor = window.Audio;
      window.__previewEvents = [];
      window.__streamChunks = [];
      window.__streamContexts = [];
      const AudioContextConstructor = window.AudioContext;
      window.AudioContext = class extends AudioContextConstructor {
        constructor(...args) {
          super(...args);
          const context = this;
          const entry = {
            state: context.state,
            peak: 0,
            chunks: 0,
            duration: 0,
            firstStarted: false,
          };
          window.__streamContexts.push(entry);
          const analyser = context.createAnalyser();
          const values = new Float32Array(analyser.fftSize);
          let sampleTimer;
          context.addEventListener('statechange', () => {
            entry.state = context.state;
            if (context.state === 'closed') clearInterval(sampleTimer);
          });
          const create = context.createBufferSource.bind(context);
          context.createBufferSource = function () {
            const source = create();
            source.connect(analyser);
            const start = source.start.bind(source);
            source.start = function (...args) {
              entry.chunks++;
              entry.duration += source.buffer.duration;
              if (!entry.firstStarted) {
                entry.firstStarted = true;
                window.__previewEvents.push({
                  type: 'playing',
                  stream: true,
                  duration: 3,
                  state: context.state,
                });
                sampleTimer = setInterval(() => {
                  analyser.getFloatTimeDomainData(values);
                  entry.peak = Math.max(entry.peak, ...values.map(Math.abs));
                }, 20);
              }
              return start(...args);
            };
            return source;
          };
        }
      };
      window.ipc.on('dubbing:previewChunk', (chunk) =>
        window.__streamChunks.push({
          requestId: chunk.requestId,
          bytes: chunk.pcm.length,
        }),
      );
      // Observe real Chromium media events; do not replace playback behavior.
      window.Audio = function (...args) {
        const audio = new AudioConstructor(...args);
        for (const type of ['playing', 'pause', 'ended', 'error'])
          audio.addEventListener(type, () => {
            window.__previewEvents.push({
              type,
              src: audio.src,
              duration: audio.duration,
              time: audio.currentTime,
            });
          });
        return audio;
      };
      return loaded.data;
    },
    {
      subtitle,
      url: `http://127.0.0.1:${server.address().port}/v1`,
      volc,
      mimo,
    },
  );
  await page.evaluate(
    (id) => window.next.router.push(`/zh/dubbing/?session=${id}`),
    session.sessionId,
  );
  const snapshot = () =>
    page.evaluate(
      (sessionId) => window.ipc.invoke('dubbing:getSession', { sessionId }),
      session.sessionId,
    );
  const dialog = page.getByRole('dialog', { name: '音色库' });
  const openGlobal = () =>
    page.getByRole('combobox', { name: '声音', exact: true }).click();
  const search = () => dialog.getByRole('textbox', { name: '搜索音色' });
  const card = (id) => dialog.locator(`[data-voice-id="${id}"]`);
  const events = () => page.evaluate(() => window.__previewEvents);
  const playing = async () =>
    (await events()).filter((event) => event.type === 'playing');
  const clearPointer = () =>
    dialog.getByRole('heading', { name: '音色库' }).hover();

  await openGlobal();
  await expect(card('voice-0000')).toBeVisible();
  const list = dialog.getByRole('list', { name: '音色库' });
  assert.ok(
    (await list.getByRole('listitem').count()) < 30,
    '1200 voices are virtualized',
  );
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(card('voice-1199')).toBeVisible();
  await dialog.getByRole('combobox', { name: '性别' }).selectOption('female');
  await dialog.getByRole('combobox', { name: '语言' }).selectOption('en');
  await dialog.getByRole('combobox', { name: '风格' }).selectOption('news');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(card('voice-0000')).toBeVisible();
  await dialog.getByRole('combobox', { name: '性别' }).selectOption('child');
  await expect(list.getByRole('listitem')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '语言' }).selectOption('zh');
  await dialog.getByRole('combobox', { name: '风格' }).selectOption('anime');
  await expect(card('voice-0001')).toBeVisible();
  for (const name of ['性别', '语言', '风格'])
    await dialog.getByRole('combobox', { name }).selectOption('unknown');
  await search().fill('voice-1199');
  await expect(card('voice-1199')).toBeVisible();
  for (const name of ['性别', '语言', '风格'])
    await dialog.getByRole('combobox', { name }).selectOption('');
  await search().fill('voice-0000');
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(card('voice-0000')).toBeVisible();
    await expect
      .poll(() => dialog.evaluate((node) => getComputedStyle(node).transform))
      .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, `library-${width}.png`) });
  }
  const initialRequests = requests.length;
  await card('voice-0000').hover();
  await expect.poll(async () => (await playing()).length).toBe(1);
  if (mimo) {
    assert.equal(openResponses, 0, 'MiMo plays its completed response');
    assert.equal((await playing())[0].stream, undefined);
    assert.equal(await page.evaluate(() => window.__streamChunks.length), 0);
  } else {
    assert.ok(
      openResponses > 0,
      'playback starts while the HTTP audio response is still open',
    );
    assert.equal((await playing())[0].stream, true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__streamContexts.some(
            (entry) => entry.firstStarted && entry.state === 'closed',
          ),
        ),
      )
      .toBe(true);
    const firstStream = await page.evaluate(() =>
      window.__streamContexts.find((entry) => entry.firstStarted),
    );
    assert.ok(
      firstStream.peak > 0.01,
      `actual decoded PCM peak ${firstStream.peak}`,
    );
    assert.ok(firstStream.duration > 2.9 && firstStream.duration <= 3.001);
  }
  const sampleEvent = (await playing())[0];
  assert.ok(
    sampleEvent.duration > 2.9 && sampleEvent.duration <= 3.001,
    `preview duration ${sampleEvent.duration}`,
  );
  assert.equal(requests.length, initialRequests + 1);
  await clearPointer();
  await card('voice-0000').hover();
  await expect.poll(async () => (await playing()).length).toBe(2);
  assert.equal(
    (await playing())[1].stream,
    undefined,
    'cache hit uses the saved WAV',
  );
  assert.equal(
    requests.length,
    initialRequests + 1,
    'same sample is served from cache',
  );
  await clearPointer();
  await search().fill('voice-0002');
  await card('voice-0002').hover();
  await expect.poll(() => requests.length).toBe(initialRequests + 2);
  await clearPointer();
  await page.waitForTimeout(1500);
  assert.equal(
    (await playing()).length,
    2,
    'cancelled slow response never starts playback',
  );
  failNext = true;
  await search().fill('voice-0001');
  await card('voice-0001').hover();
  await expect(dialog.getByRole('alert')).toContainText('fixture unavailable');
  await clearPointer();
  await card('voice-0001').hover();
  await expect.poll(async () => (await playing()).length).toBe(3);
  await clearPointer();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const cueVoice = page.getByRole('combobox', {
    name: '第 1 句的音色',
    exact: true,
  });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const sessionDir = path.join(userData, 'dubbing-sessions', session.sessionId);
  const meta = async () =>
    JSON.parse(
      await fs.readFile(path.join(sessionDir, 'session.json'), 'utf8'),
    );
  await cueVoice.click();
  await search().fill('voice-0001');
  if (process.platform !== 'win32') {
    lockedDirectory = sessionDir;
    await fs.chmod(lockedDirectory, 0o500);
    await dialog
      .getByRole('button', { name: 'voice-0001', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toContainText('EACCES');
    assert.equal((await meta()).cues[0].voiceId, undefined);
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
  }
  await dialog.getByRole('button', { name: 'voice-0001', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await meta()).cues[0].voiceId, 'voice-0001');
  await page.getByRole('button', { name: '开始配音', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot()).data.cues.filter((cue) => cue.status === 'done')
          .length,
    )
    .toBe(2);
  const prior = (await snapshot()).data.cues[0].wavPath;
  await cueVoice.click();
  await search().fill('voice-0000');
  failNext = true;
  await dialog.getByRole('button', { name: 'voice-0000', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('fixture unavailable');
  assert.equal(
    (await meta()).cues[0].voiceId,
    'voice-0000',
    'the edit is retained for retry',
  );
  assert.equal((await snapshot()).data.cues[0].wavPath, prior);
  assert.ok(
    (await fs.stat(prior)).size > 0,
    'failed replacement preserves prior audio',
  );
  await dialog.getByRole('button', { name: 'voice-0000', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.notEqual((await snapshot()).data.cues[0].wavPath, prior);
  assert.equal((await snapshot()).data.cues[0].status, 'done');
  assert.deepEqual(errors, []);
  const result = {
    output,
    protocol: volc
      ? 'volcengine JSON/PCM'
      : mimo
        ? 'MiMo completed base64 WAV'
        : 'OpenAI compatible WAV',
    requests: requests.length,
    plays: (await playing()).length,
    sampleDuration: sampleEvent.duration,
    checks: `${mimo ? 'Completed audio fallback (no streaming), ' : 'Streaming, '}1200-voice virtualization, metadata/search filters, 3-second cap and cached WAV replay, hover/cancel/failure/retry, durable cue overrides and resynthesis failure recovery, 1024/1440. Local deterministic TTS fixture, not commercial-provider quality validation.`,
  };
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error({ output });
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
