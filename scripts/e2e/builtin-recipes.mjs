import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const model = process.env.SMARTSUB_E2E_WHISPER_MODEL;
assert.ok(model, 'Set SMARTSUB_E2E_WHISPER_MODEL to a real ggml-base.bin');
assert.equal(
  createHash('sha256')
    .update(await fs.readFile(model))
    .digest('hex'),
  '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
);
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-recipes-e2e-'),
);
const profile = path.join(output, 'profile');
const media = path.join(output, 'source.mp4');
const runFfmpeg = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
runFfmpeg([
  '-ss',
  '30',
  '-i',
  process.env.SMARTSUB_E2E_VIDEO ||
    '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/A simple way to break a bad habit   Judson Brewer   TED.mp4',
  '-t',
  '8',
  '-vf',
  'scale=640:-2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  media,
]);
const voice = path.join(output, 'voice.wav');
runFfmpeg([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '0.35',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  voice,
]);
const audio = await fs.readFile(voice);
const requests = [];
const translated = 'This is the translated test sentence.';
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/v1/audio/speech') {
        requests.push({ kind: 'speech', body });
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(audio);
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      const input = JSON.parse(
        body.messages.find((message) => message.role === 'user').content,
      );
      requests.push({ kind: 'translation', input });
      const result = Object.fromEntries(
        Object.entries(input).map(([id, src]) => [id, { src, tr: translated }]),
      );
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'recipe-fixture',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(result) },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
const checks = [];
const results = [];
try {
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
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const origin = new URL(page.url()).origin;
  const info = await page.evaluate(() =>
    window.ipc.invoke('getSystemInfo', null),
  );
  assert.ok(
    (await fs.realpath(info.modelsPath)).startsWith(
      `${await fs.realpath(output)}/`,
    ),
    `Model directory must belong to the isolated profile: ${info.modelsPath}`,
  );
  await fs.mkdir(info.modelsPath, { recursive: true });
  await fs.copyFile(model, path.join(info.modelsPath, 'ggml-base.bin'));
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await page.evaluate(
    async ({ apiUrl }) => {
      window.ipc.send('setTranslationProviders', [
        {
          id: 'recipe-ai',
          name: 'Recipe translation fixture',
          type: 'openai',
          isAi: true,
          apiUrl,
          apiKey: 'test-only',
          modelName: 'fixture',
          prompt: '${content}',
          echoAnchoring: true,
          useJsonMode: true,
          requestInterval: 0,
        },
      ]);
      window.ipc.send('setTtsProviders', [
        {
          id: 'recipe-tts',
          name: 'Recipe speech fixture',
          type: 'openaiCompatible',
          apiUrl,
          apiKey: 'test-only',
          model: 'fixture',
          voices: 'alloy',
        },
      ]);
      const defaults = await window.ipc.invoke('getUserConfig');
      window.ipc.send('setUserConfig', {
        ...defaults,
        transcriptionEngine: 'builtin',
        model: 'base',
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        translateProvider: 'recipe-ai',
        aiCorrection: false,
        aiSegmentation: false,
        speakerDiarization: false,
        useEmbeddedSubtitles: false,
        translateContent: 'onlyTranslate',
        sourceSrtSaveOption: 'fileName',
        targetSrtSaveOption: 'fileNameWithLang',
      });
      await window.ipc.invoke('setSettings', { gpuMode: 'cpu' });
    },
    { apiUrl },
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.ipc.invoke('getUserConfig')).model,
      ),
    )
    .toBe('base');
  const readItem = (id) =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  const count = (kind) =>
    requests.filter((request) => request.kind === kind).length;
  async function drop(recipe, input) {
    await page.goto(`${origin}/zh/home/`);
    const target = page.locator(`[data-drop-recipe="${recipe}"]`);
    await expect(page.getByText('本地模型可用', { exact: true })).toBeVisible();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box);
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', {
          type,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          data: { items: [], files: [input], dragOperationsMask: 1 },
        });
      }
    } finally {
      await cdp.detach();
    }
  }
  async function completed(id, field) {
    await expect
      .poll(
        async () => {
          const item = await readItem(id);
          const file = item?.pipelineFiles?.[0];
          if (item?.status === 'error') throw Error(JSON.stringify(item));
          return file?.[field];
        },
        { timeout: 180000 },
      )
      .toBe('done');
    return readItem(id);
  }
  for (const manual of [true, false]) {
    const input = path.join(output, manual ? 'manual.mp4' : 'automatic.mp4');
    await fs.copyFile(media, input);
    await drop('builtin-pipeline', input);
    await expect(page).toHaveURL(/\/tasks\/new\/?\?draft=/);
    const subtitleGate = page.getByRole('switch', { name: /^字幕校对/ });
    const dubbingGate = page.getByRole('switch', { name: /^配音确认/ });
    await expect(subtitleGate).toBeChecked();
    await expect(dubbingGate).not.toBeChecked();
    if (!manual) await subtitleGate.click();
    const speechBefore = count('speech');
    const translationBefore = count('translation');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page).toHaveURL(/project=/);
    const id = new URL(page.url()).searchParams.get('project');
    if (manual) {
      await expect
        .poll(
          async () => (await readItem(id))?.pipelineFiles?.[0]?.subtitleGate,
          { timeout: 180000 },
        )
        .toBe('review');
      const held = await readItem(id);
      assert.equal(held.status, 'review');
      assert.equal(held.pipelineFiles[0].finalVideoPath, undefined);
      assert.equal(count('speech'), speechBefore);
      assert.ok(count('translation') > translationBefore);
      await page.screenshot({ path: path.join(output, 'manual-review.png') });
      await page.getByRole('button', { name: '放行', exact: true }).click();
    }
    const item = await completed(id, 'composeVideo');
    const file = item.pipelineFiles[0];
    assert.equal(
      item.configSnapshot.gates.subtitle,
      manual ? 'manual' : 'auto',
    );
    assert.equal(item.configSnapshot.gates.dubbing, 'auto');
    assert.equal(file.extractSubtitle, 'done');
    assert.equal(file.translateSubtitle, 'done');
    assert.equal(file.dubbing, 'done');
    assert.ok((await fs.readFile(file.srtFile, 'utf8')).trim().length > 40);
    assert.ok(
      (await fs.readFile(file.translatedSrtFile, 'utf8')).includes(translated),
    );
    assert.ok(count('speech') > speechBefore);
    assert.ok(
      requests
        .filter((request) => request.kind === 'speech')
        .every(
          (request) =>
            request.body.voice === 'alloy' &&
            request.body.input.includes(translated),
        ),
    );
    assert.ok((await fs.stat(file.dubbedTrackPath)).size > 1000);
    assert.ok((await fs.stat(file.finalVideoPath)).size > 1000);
    runFfmpeg([
      '-i',
      file.finalVideoPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ]);
    runFfmpeg([
      '-ss',
      '0.2',
      '-i',
      file.finalVideoPath,
      '-frames:v',
      '1',
      path.join(output, manual ? 'manual-frame.png' : 'automatic-frame.png'),
    ]);
    await page.screenshot({
      path: path.join(
        output,
        manual ? 'manual-completed.png' : 'automatic-completed.png',
      ),
    });
    checks.push(
      manual
        ? 'builtin native drop -> real Base ASR -> translation -> manual review -> TTS -> video'
        : 'builtin native drop -> explicit automatic gate -> real Base ASR -> translation -> TTS -> video without review',
    );
    results.push({ id, file });
  }
  for (const [recipe, translate, inputSubtitle] of [
    ['builtin-generate', false, false],
    ['builtin-generate-translate', true, false],
    ['builtin-translate', true, true],
  ]) {
    const input = path.join(
      output,
      `${recipe}.${inputSubtitle ? 'srt' : 'mp4'}`,
    );
    if (inputSubtitle)
      await fs.writeFile(
        input,
        '1\n00:00:00,100 --> 00:00:02,000\nTranslate the supplied subtitle.\n',
      );
    else await fs.copyFile(media, input);
    const before = count('translation');
    await drop(recipe, input);
    await expect(page).toHaveURL(/project=/);
    const id = new URL(page.url()).searchParams.get('project');
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    const item = await completed(id, 'exportSubtitle');
    const file = item.pipelineFiles[0];
    assert.equal(count('translation') > before, translate);
    assert.ok(
      (
        await fs.readFile(
          translate ? file.translatedSrtFile : file.srtFile,
          'utf8',
        )
      ).trim().length > 40,
    );
    if (translate)
      assert.ok(
        (await fs.readFile(file.translatedSrtFile, 'utf8')).includes(
          translated,
        ),
      );
    if (inputSubtitle)
      assert.equal(
        await fs.readFile(input, 'utf8'),
        '1\n00:00:00,100 --> 00:00:02,000\nTranslate the supplied subtitle.\n',
      );
    checks.push(
      `${recipe}: native card drop, actual execution and subtitle output`,
    );
    results.push({ id, file });
  }
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ checks, results, requests }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error(JSON.stringify({ output, checks, url: page?.url() }));
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-6000));
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await app?.close();
}
