import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const models = process.env.SMARTSUB_TEST_TTS_MODELS;
assert.ok(
  models,
  'Set SMARTSUB_TEST_TTS_MODELS to a directory containing vits-zh-aishell3',
);
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-local-preview-e2e-'),
);
const app = await _electron.launch({
  args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
  env: {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(async (models) => {
    const result = await window.ipc.invoke('setSettings', {
      ttsModelsPath: models,
    });
    if (result?.rejectedKeys?.length) throw new Error(JSON.stringify(result));
    window.__localChunks = [];
    window.ipc.on('dubbing:previewChunk', (chunk) =>
      window.__localChunks.push(chunk),
    );
  }, models);
  const request = {
    engine: { kind: 'local', modelId: 'vits-zh-aishell3' },
    voiceId: '0',
    language: 'zh',
    text: '欢迎使用智能字幕，今天我们一起体验本地语音合成和精确时间轴。',
  };
  const preview = async (id, extra = {}) =>
    page.evaluate(
      (payload) => window.ipc.invoke('dubbing:previewVoice', payload),
      { ...request, ...extra, requestId: id },
    );
  const first = await preview('first');
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal((await preview('cache')).data, first.data);
  assert.equal(
    await page.evaluate(() => window.__localChunks.length),
    0,
    'local model uses completed file fallback',
  );
  const adjusted = await preview('role', {
    speakerSettings: { speed: 1.1, pitch: 2 },
  });
  assert.equal(adjusted.success, true, JSON.stringify(adjusted));
  assert.notEqual(adjusted.data, first.data);
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-i',
    first.data,
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    '8000',
    'pipe:1',
  ]);
  let peak = 0;
  for (let index = 0; index < pcm.length; index += 2)
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(index)));
  assert.ok(peak > 100);
  assert.ok(pcm.length / 16000 <= 3.001 && pcm.length / 16000 > 1);
  // Observe actual Chromium decoding and playback of the result.
  const playback = await page.evaluate(async (file) => {
    const audio = new Audio(`media://${encodeURIComponent(file)}`);
    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const result = {
      duration: audio.duration,
      time: audio.currentTime,
      paused: audio.paused,
    };
    audio.pause();
    return result;
  }, first.data);
  assert.ok(
    playback.time > 0 && playback.duration <= 3.001 && !playback.paused,
  );
  const cancelled = await page.evaluate(async (request) => {
    const pending = window.ipc.invoke('dubbing:previewVoice', {
      ...request,
      voiceId: '1',
      requestId: 'cancel',
    });
    await window.ipc.invoke('dubbing:cancelPreview', { requestId: 'cancel' });
    return pending;
  }, request);
  assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
  const retry = await preview('retry', { voiceId: '1' });
  assert.equal(retry.success, true, JSON.stringify(retry));
  await fs.copyFile(first.data, path.join(output, 'local-preview.wav'));
  await fs.copyFile(adjusted.data, path.join(output, 'local-role-preview.wav'));
  assert.deepEqual(errors, []);
  const result = {
    output,
    model: request.engine.modelId,
    playback,
    peak,
    checks: [
      'real native model synthesis and Chromium playback',
      'three-second file fallback',
      'cache identity and speaker DSP',
      'cancel and synthesize again',
    ],
    errors,
  };
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error({ output, errors });
  throw error;
} finally {
  await app.close();
}
