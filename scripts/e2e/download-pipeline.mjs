import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const downloader = process.env.SMARTSUB_E2E_YTDLP;
assert.ok(downloader, 'Set SMARTSUB_E2E_YTDLP to a real yt-dlp executable');
const version = execFileSync(downloader, ['--version'], {
  encoding: 'utf8',
}).trim();
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-download-pipeline-e2e-'),
);
const profile = path.join(output, 'profile');
const downloadDir = path.join(output, 'downloads');
await fs.mkdir(downloadDir);
const media = path.join(output, 'source.mp4');
const voice = path.join(output, 'voice.wav');
const runFfmpeg = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
runFfmpeg([
  '-i',
  process.env.SMARTSUB_E2E_VIDEO ||
    '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/A simple way to break a bad habit   Judson Brewer   TED.mp4',
  '-t',
  '4',
  '-vf',
  'scale=480:-2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  media,
]);
runFfmpeg([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '0.25',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  voice,
]);
const video = await fs.readFile(media);
const audio = await fs.readFile(voice);
const requests = [];
let hold = false;
const held = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      requests.push({ method: request.method, path: url.pathname });
      if (/^\/(a|b|repair|fallback)$/.test(url.pathname)) {
        const id = url.pathname.slice(1);
        response
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            `<!doctype html><html lang="en"><head><title>Download ${id}</title></head><body><video controls><source src="/${id}.mp4" type="video/mp4">${id === 'fallback' ? '' : '<track kind="subtitles" src="/en.vtt" srclang="en" label="English"><track kind="subtitles" src="/zh.vtt" srclang="zh" label="Chinese">'}</video></body></html>`,
          );
        return;
      }
      if (url.pathname.endsWith('.mp4')) {
        const send = () => {
          response.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': video.length,
          });
          response.end(request.method === 'HEAD' ? undefined : video);
        };
        if (hold && request.method === 'GET') held.push(send);
        else send();
        return;
      }
      if (url.pathname.endsWith('.vtt')) {
        response
          .writeHead(200, { 'Content-Type': 'text/vtt' })
          .end(
            `WEBVTT\n\n00:00:00.100 --> 00:00:01.500\n${url.pathname === '/en.vtt' ? 'Official English sentence.' : 'Chinese subtitle fixture.'}\n`,
          );
        return;
      }
      if (url.pathname === '/v1/audio/speech') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.at(-1).body = body;
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(audio);
        return;
      }
      if (url.pathname === '/v1/audio/transcriptions') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            language: 'english',
            duration: 4,
            text: 'Fallback transcription.',
            segments: [
              {
                id: 0,
                start: 0.1,
                end: 1.5,
                text: 'Fallback transcription.',
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const input = JSON.parse(
          body.messages.find((message) => message.role === 'user').content,
        );
        requests.at(-1).input = input;
        const result = Object.fromEntries(
          Object.entries(input).map(([id, src]) => [
            id,
            { src, tr: 'Translated official sentence.' },
          ]),
        );
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify(result),
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const host = `http://127.0.0.1:${server.address().port}`;
let app;
let page;
const checks = [];
const count = (suffix) =>
  requests.filter((r) => r.path.endsWith(suffix) && r.method === 'GET').length;
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
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
  const userData = await app.evaluate(({ app, BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
    return app.getPath('userData');
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const origin = new URL(page.url()).origin;
  const binaryDir = path.join(userData, 'downloaders', 'yt-dlp', version);
  await fs.mkdir(binaryDir, { recursive: true });
  await fs.copyFile(downloader, path.join(binaryDir, 'yt-dlp'));
  await fs.chmod(path.join(binaryDir, 'yt-dlp'), 0o755);
  await fs.writeFile(
    path.join(userData, 'downloaders', 'config.json'),
    JSON.stringify({
      engines: {
        'yt-dlp': {
          version,
          binaryName: 'yt-dlp',
          installedAt: new Date().toISOString(),
        },
      },
    }),
  );
  const tts = {
    id: 'download-tts',
    name: 'Download speech fixture',
    type: 'openaiCompatible',
    apiUrl: `${host}/v1`,
    apiKey: 'test-only',
    model: 'fixture',
    voices: 'alloy',
  };
  const recipe = await page.evaluate(
    async ({ host, downloadDir, tts }) => {
      await window.ipc.invoke('setSettings', {
        videoDownloadSavePath: downloadDir,
        videoDownloadEngine: 'yt-dlp',
        proxyMode: 'none',
        cloudUploadConsent: false,
      });
      window.ipc.send('setTranslationProviders', [
        {
          id: 'download-ai',
          name: 'Translation fixture',
          type: 'openai',
          isAi: true,
          apiUrl: `${host}/v1`,
          apiKey: 'test-only',
          modelName: 'fixture',
          prompt: '${content}',
          echoAnchoring: true,
          useJsonMode: true,
          requestInterval: 0,
        },
      ]);
      window.ipc.send('setTtsProviders', [tts]);
      return window.ipc.invoke('recipes:save', {
        name: 'Download to finished video',
        accepts: 'media',
        goals: { translate: true, dub: true, video: true },
        config: {
          transcriptionEngine: 'builtin',
          model: 'intentionally-not-installed',
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          translateProvider: 'download-ai',
          translateContent: 'sourceAndTranslate',
          sourceSrtSaveOption: 'fileName',
          targetSrtSaveOption: 'fileNameWithLang',
          aiCorrection: false,
          aiSegmentation: false,
          speakerDiarization: false,
          dub: {
            engine: { kind: 'cloud', providerId: tts.id },
            voice: 'alloy',
            globalSpeed: 1,
          },
          compose: {
            subtitle: 'hard',
            encoderMode: 'cpu',
            videoQuality: 'standard',
          },
          gates: { subtitle: 'auto', dubbing: 'auto' },
        },
      });
    },
    { host, downloadDir, tts },
  );
  const readItem = (id) =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  const waitBatch = async (id) => {
    await expect
      .poll(
        async () =>
          (await readItem(id))?.downloadEntries?.every(
            (e) => e.status === 'done' || e.status === 'error',
          ),
        { timeout: 120000 },
      )
      .toBe(true);
    const batch = await readItem(id);
    assert.ok(
      batch.downloadEntries.every((e) => e.status === 'done'),
      JSON.stringify(batch.downloadEntries),
    );
    return batch;
  };
  await page.goto(`${origin}/zh/download/`);
  await page.getByRole('textbox').fill(`${host}/a\n${host}/b`);
  await page.goto(`${origin}/zh/home/`);
  await page.goto(`${origin}/zh/download/`);
  await expect(page.getByRole('textbox')).toHaveValue(`${host}/a\n${host}/b`);
  checks.push('Download links survived navigation away to configure a recipe');
  await page.getByText('下载完成后自动启动创作流水线', { exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '下载完成后自动启动创作流水线' }),
  ).toBeChecked();
  await page.getByRole('combobox', { name: '流水线配方' }).click();
  await page.getByRole('option', { name: recipe.name }).click();
  await page.getByRole('button', { name: '解析链接', exact: true }).click();
  await expect(page.getByText(/官方字幕 ·/).first()).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole('button', { name: /开始下载.*2/ }).click();
  await expect(page).toHaveURL(/workItem=/);
  const batchId = new URL(page.url()).searchParams.get('workItem');
  const batch = await waitBatch(batchId);
  for (const entry of batch.downloadEntries) {
    assert.equal(entry.pipeline?.status, 'submitted', JSON.stringify(entry));
    assert.equal(entry.subtitlePaths.length, 2);
    assert.ok(entry.pipeline.subtitlePaths[0].endsWith('.en.srt'));
    await expect
      .poll(
        async () => {
          const child = await readItem(entry.pipeline.projectId);
          if (child.status === 'error') throw Error(JSON.stringify(child));
          return child.pipelineFiles[0].composeVideo;
        },
        { timeout: 120000 },
      )
      .toBe('done');
    const child = await readItem(entry.pipeline.projectId);
    const file = child.pipelineFiles[0];
    assert.ok((await fs.stat(file.finalVideoPath)).size > 1000);
    assert.equal(
      file.audioFile,
      undefined,
      'no ASR audio extraction for official subtitles',
    );
    assert.ok(
      (await fs.readFile(file.srtFile, 'utf8')).includes(
        'Official English sentence.',
      ),
    );
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
  }
  assert.equal(
    requests.filter((r) => r.path === '/v1/audio/transcriptions').length,
    0,
  );
  assert.ok(requests.some((r) => r.path === '/v1/audio/speech'));
  checks.push(
    'Real yt-dlp batch with two official languages bypassed missing ASR, translated, dubbed and produced playable video',
  );
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()
          .find((w) => !w.isDestroyed())
          .setSize(width, height),
      { width, height },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({ path: path.join(output, `download-${width}.png`) });
  }
  checks.push('No page overflow at 1024x700 and 1440x900');
  hold = true;
  const repair = await page.evaluate(
    async ({ recipe, host, downloadDir }) => {
      const prepared = await window.ipc.invoke(
        'videoDownload:preparePipeline',
        recipe.id,
      );
      return window.ipc.invoke('videoDownload:start', {
        name: 'Repair handoff',
        savePath: downloadDir,
        quality: 'best',
        engine: 'yt-dlp',
        writeSubs: true,
        entries: [{ url: `${host}/repair` }],
        autoChain: { recipeId: recipe.id, configKey: prepared.configKey },
      });
    },
    { recipe, host, downloadDir },
  );
  await expect.poll(() => held.length, { timeout: 45000 }).toBeGreaterThan(0);
  await page.evaluate(
    async ({ recipe }) => {
      window.ipc.send('setTtsProviders', []);
      await window.ipc.invoke('recipes:save', {
        ...recipe,
        config: { ...recipe.config, targetLanguage: 'de' },
      });
    },
    { recipe },
  );
  hold = false;
  held.splice(0).forEach((send) => send());
  const failed = await waitBatch(repair.id);
  assert.equal(failed.downloadEntries[0].pipeline.status, 'error');
  assert.match(failed.downloadEntries[0].pipeline.error, /TTS_REQUIRED/);
  const savedMedia = failed.downloadEntries[0].outputPath;
  const originalHash = await hash(savedMedia);
  const previousDownloads = count('/repair.mp4');
  await page.goto(`${origin}/zh/download/?workItem=${repair.id}`);
  await expect(
    page.getByText('流水线未能启动，下载文件已保留', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(output, 'download-repair.png') });
  await page.evaluate(async (tts) => {
    window.ipc.send('setTtsProviders', [tts]);
    await window.ipc.invoke('getTtsProviders');
  }, tts);
  await page.getByRole('button', { name: '重试流水线', exact: true }).click();
  await expect(page.getByText('已提交任务', { exact: true })).toBeVisible();
  const repaired = await readItem(repair.id);
  const childId = repaired.downloadEntries[0].pipeline.projectId;
  await expect
    .poll(async () => (await readItem(childId)).pipelineFiles[0].composeVideo, {
      timeout: 120000,
    })
    .toBe('done');
  assert.equal(
    (await readItem(childId)).configSnapshot.targetLanguage,
    'fr',
    'retry retains original batch snapshot',
  );
  await page.evaluate(
    async ({ id, entryId }) => {
      await window.ipc.invoke('videoDownload:retryPipeline', {
        workItemId: id,
        entryId,
      });
    },
    { id: repair.id, entryId: repaired.downloadEntries[0].id },
  );
  assert.equal((await readItem(childId)).taskSubmissions.length, 1);
  assert.equal(await hash(savedMedia), originalHash);
  assert.equal(count('/repair.mp4'), previousDownloads);
  checks.push(
    'Dependency removed during download: persistent error, repair through UI, immutable snapshot, no redownload or duplicate submission',
  );
  const fallbackRecipe = await page.evaluate(
    async ({ host }) => {
      window.ipc.send('setAsrProviders', [
        {
          id: 'download-asr',
          name: 'ASR fixture',
          type: 'openaiCompatible',
          apiUrl: `${host}/v1`,
          apiKey: 'test-only',
          models: 'fixture',
        },
      ]);
      return window.ipc.invoke('recipes:save', {
        name: 'Fallback ASR',
        accepts: 'media',
        goals: { translate: false, dub: false, video: false },
        config: {
          transcriptionEngine: 'cloud',
          asrProviderId: 'download-asr',
          model: 'fixture',
          sourceLanguage: 'en',
          sourceSrtSaveOption: 'fileName',
          aiCorrection: false,
          aiSegmentation: false,
          speakerDiarization: false,
        },
      });
    },
    { host },
  );
  await page.goto(`${origin}/zh/download/`);
  await page.getByRole('textbox').fill(`${host}/fallback`);
  if (
    !(await page
      .getByRole('checkbox', { name: '下载完成后自动启动创作流水线' })
      .isChecked())
  )
    await page
      .getByText('下载完成后自动启动创作流水线', { exact: true })
      .click();
  await page.getByRole('combobox', { name: '流水线配方' }).click();
  await page.getByRole('option', { name: fallbackRecipe.name }).click();
  await page.getByRole('button', { name: '直接下载', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const consentButtons = await page
    .getByRole('alertdialog')
    .getByRole('button')
    .allTextContents();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '本次上传', exact: true })
    .click();
  await expect(page).toHaveURL(/workItem=/);
  const fallbackId = new URL(page.url()).searchParams.get('workItem');
  const fallback = await waitBatch(fallbackId);
  assert.equal(
    fallback.downloadEntries[0].pipeline.status,
    'submitted',
    JSON.stringify(fallback),
  );
  const fallbackChild = fallback.downloadEntries[0].pipeline.projectId;
  await expect
    .poll(
      async () => {
        const child = await readItem(fallbackChild);
        if (child.status === 'error') throw Error(JSON.stringify(child));
        return child.pipelineFiles[0].exportSubtitle;
      },
      { timeout: 90000 },
    )
    .toBe('done');
  assert.ok(requests.some((r) => r.path === '/v1/audio/transcriptions'));
  assert.equal(fallback.configSnapshot.autoChain.cloudUploadConsent, true);
  checks.push(
    `Missing official subtitles used cloud ASR only after one-time consent (${consentButtons.join(', ')})`,
  );
  const beforeRestart = requests.length;
  const downloadCount = requests.filter((r) => r.path.endsWith('.mp4')).length;
  const speechCount = requests.filter(
    (r) => r.path === '/v1/audio/speech',
  ).length;
  await app.close();
  app = undefined;
  // Seed an interrupted parent acknowledgement over a real accepted child.
  const storePath = path.join(profile, 'config.json');
  const saved = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const parent = saved.workItems.find((item) => item.id === repair.id);
  const child = saved.workItems.find((item) => item.id === childId);
  parent.downloadEntries[0].pipeline = {
    projectId: childId,
    status: 'pending',
    submission: {
      projectId: childId,
      requestId: child.taskSubmissions[0].requestId,
      name: child.name,
      files: failed.downloadEntries[0].pipeline.submission.files,
      formData: failed.downloadEntries[0].pipeline.submission.formData,
    },
  };
  await fs.writeFile(storePath, JSON.stringify(saved, null, 2));
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
  });
  await page.goto(`${origin}/zh/download/?workItem=${repair.id}`);
  await expect(page.getByText('已提交任务', { exact: true })).toBeVisible();
  assert.equal((await readItem(childId)).taskSubmissions.length, 1);
  assert.equal(
    requests.filter((r) => r.path.endsWith('.mp4')).length,
    downloadCount,
  );
  assert.equal(
    requests.filter((r) => r.path === '/v1/audio/speech').length,
    speechCount,
  );
  assert.equal(requests.length, beforeRestart);
  checks.push(
    'Real application restart reconciled a seeded pending acknowledgement with the accepted child without requeue or redownload',
  );
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      { version, checks, requests, batchId, repairId: repair.id, fallbackId },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, checks }, null, 2));
} catch (error) {
  console.error('Evidence:', output);
  if (page) {
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    await fs.writeFile(
      path.join(output, 'failure-body.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  hold = false;
  held.splice(0).forEach((send) => send());
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
