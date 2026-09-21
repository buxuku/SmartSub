import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-speaker-e2e-'),
);
const media = path.join(output, 'interview.wav');
const subtitle = path.join(output, 'interview.srt');
const source =
  [
    '1\n00:00:00,000 --> 00:00:04,000\nFirst speaker introduction.',
    '2\n00:00:04,000 --> 00:00:08,000\nFirst speaker continues.',
    '3\n00:00:08,000 --> 00:00:12,000\nSecond speaker introduction.',
    '4\n00:00:12,000 --> 00:00:16,000\nSecond speaker continues.',
  ].join('\n\n') + '\n';
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/asr-zh-60s.wav',
  '-ss',
  '30',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/A simple way to break a bad habit   Judson Brewer   TED.mp4',
  '-filter_complex',
  '[0:a]atrim=0:8,asetpts=PTS-STARTPTS,aformat=sample_rates=16000:channel_layouts=mono[a];[1:a]atrim=0:8,asetpts=PTS-STARTPTS,aformat=sample_rates=16000:channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]',
  '-map',
  '[out]',
  '-c:a',
  'pcm_s16le',
  media,
]);
await fs.writeFile(subtitle, source);
const voice = path.join(output, 'voice.wav');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '0.5',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  voice,
]);
const audio = await fs.readFile(voice);
const requests = [];
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/speech') return response.writeHead(404).end();
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(audio);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
let movedModels;
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
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  page.on('console', (message) => {
    if (message.text().startsWith('speaker-download:'))
      console.log(message.text());
  });
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const tts = {
    id: 'speaker-tts',
    name: 'Local speaker TTS',
    type: 'openaiCompatible',
    apiKey: 'test-only',
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'test-voice',
    voices: 'alloy',
  };
  const key = 'smartsub_task_wizard_draft_v1';
  await page.evaluate(
    async ({ media, subtitle, tts, key }) => {
      window.ipc.send('setTtsProviders', [tts]);
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media, subtitle],
        taskType: 'any',
      });
      const config = {
        taskType: 'generateOnly',
        translateProvider: '-1',
        sourceLanguage: 'en',
        speakerDiarization: true,
        speakerDiarizationCount: 2,
        speakerDiarizationEmbedInSubtitle: true,
        subtitleLayout: 'two-line',
        subtitleLineWidth: 16,
        aiCorrection: false,
        aiSegmentation: false,
      };
      const saved = await window.ipc.invoke('recipes:save', {
        name: 'Interview roles',
        accepts: 'media',
        goals: { translate: false, dub: true, video: false },
        config,
      });
      if (saved.config.speakerDiarization !== true)
        throw new Error('recipe lost roles');
      const recipes = await window.ipc.invoke('recipes:list');
      if (
        recipes.find((recipe) => recipe.id === saved.id)?.config
          .speakerDiarizationCount !== 2
      )
        throw new Error('recipe reload lost count');
      localStorage.setItem(
        key,
        JSON.stringify({
          files,
          manualPairs: [[media, subtitle]],
          goals: { translate: false, dub: true, video: false },
          config,
          pipeline: {
            dubbing: {
              engineKey: 'cloud:speaker-tts',
              voice: 'alloy',
              language: 'en',
              globalSpeed: 1,
            },
            subtitle: 'none',
            styleId: 'classic',
            quality: 'original',
            encoder: 'cpu',
            subtitleGate: false,
            dubbingGate: true,
            recipeName: 'Interview roles',
          },
          savedAt: Date.now(),
        }),
      );
    },
    { media, subtitle, tts, key },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(
    page.getByText(
      '角色分离模型或运行库未就绪。请在引擎页安装，或在专家参数中关闭角色分离。',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '专家参数', exact: true }).click();
  const advanced = page.getByRole('dialog');
  await expect(advanced.getByText('识别设置', { exact: true })).toHaveCount(0);
  const roleSwitch = advanced.getByRole('switch', { name: /^角色分离/ });
  await expect(roleSwitch).toBeChecked();
  await roleSwitch.click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '专家参数', exact: true }).click();
  await roleSwitch.click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: path.join(output, 'missing-model.png') });
  const status = await page.evaluate(() =>
    window.ipc.invoke('getSpeakerDiarizationModelStatus'),
  );
  assert.equal(
    status.runtimeInstalled,
    true,
    'bundled sherpa runtime required',
  );
  if (process.env.SMARTSUB_E2E_SPEAKER_MODELS) {
    await fs.cp(
      process.env.SMARTSUB_E2E_SPEAKER_MODELS,
      path.join(status.modelsPath, 'default'),
      { recursive: true },
    );
  } else {
    console.log(`Downloading actual speaker models into ${status.modelsPath}`);
    await page.evaluate(() => {
      window.speakerDownload = { pending: true };
      window.ipc
        .invoke('downloadSpeakerDiarizationModel', { source: 'github' })
        .then((result) => {
          window.speakerDownload = result;
        });
    });
    await expect
      .poll(() => page.evaluate(() => window.speakerDownload.pending), {
        timeout: 300000,
        intervals: [1000, 3000, 5000],
      })
      .not.toBe(true);
    const download = await page.evaluate(() => window.speakerDownload);
    assert.equal(download.success, true, JSON.stringify(download));
  }
  assert.equal(
    (
      await page.evaluate(() =>
        window.ipc.invoke('getSpeakerDiarizationModelStatus'),
      )
    ).installed,
    true,
  );
  console.log(`Speaker models ready; evidence: ${output}`);
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/project=/);
  const id = new URL(page.url()).searchParams.get('project');
  const item = () =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  await expect
    .poll(async () => (await item())?.pipelineFiles?.[0]?.dubbingGate, {
      timeout: 120000,
    })
    .toBe('review');
  const task = await item();
  const file = task.pipelineFiles[0];
  assert.equal(task.configSnapshot.speakerDiarization, true);
  assert.equal(task.configSnapshot.recipeName, 'Interview roles');
  assert.equal(file.speakerDiarization, 'done');
  const roles = JSON.parse(await fs.readFile(file.proofreadDataFile, 'utf8'));
  assert.equal(roles.speakers.length, 2, JSON.stringify(roles.speakers));
  assert.ok(roles.cues.every((cue) => cue.speakerIds.length > 0));
  assert.equal(
    await fs.readFile(subtitle, 'utf8'),
    source,
    'label mode never changes provided subtitle',
  );
  const session = await page.evaluate(
    (file) =>
      window.ipc.invoke('dubbing:getSession', {
        sessionId: file.dubbingSessionId,
        subtitlePath: file.srtFile,
        proofreadDataFile: file.proofreadDataFile,
      }),
    file,
  );
  assert.equal(session.success, true, JSON.stringify(session));
  assert.equal(session.data.speakers.length, 2);
  assert.ok(session.data.cues.every((cue) => cue.speakerIds.length > 0));
  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((request) => request.input).sort(),
    roles.cues.map((cue) => cue.source).sort(),
    'two-line source-sidecar path sends original cue text to TTS',
  );
  assert.ok(
    requests.every(
      (request) =>
        request.voice === 'alloy' && !request.input.includes('[Speaker'),
    ),
  );
  await page.screenshot({ path: path.join(output, 'roles-and-gate.png') });
  // A completed downstream gate resumes from persisted metadata without models.
  movedModels = {
    from: path.join(status.modelsPath, 'default'),
    to: path.join(status.modelsPath, 'held-for-resume'),
  };
  await fs.rename(movedModels.from, movedModels.to);
  await page.getByRole('button', { name: '放行', exact: true }).click();
  await expect
    .poll(async () => (await item()).pipelineFiles[0].dubbingGate, {
      timeout: 60000,
    })
    .toBe('passed');
  await expect
    .poll(
      () => page.evaluate((id) => window.ipc.invoke('getTaskStatus', id), id),
      { timeout: 60000 },
    )
    .toBe('idle');
  const final = (await item()).pipelineFiles[0];
  assert.equal(final.speakerDiarization, 'done');
  assert.equal(final.dubbing, 'done');
  assert.equal(requests.length, 4);
  assert.ok((await fs.stat(final.dubbedAudioPath)).size > 1000);
  assert.deepEqual(
    JSON.parse(await fs.readFile(file.proofreadDataFile, 'utf8')).speakers,
    roles.speakers,
  );
  console.log(
    JSON.stringify({
      output,
      modelsPath: status.modelsPath,
      speakers: roles.speakers.length,
      speechRequests: requests.length,
      checks: [
        'missing-model blocker',
        'recipe persistence',
        'paired media without ASR',
        'real sherpa clustering',
        'protected imported subtitle',
        'sidecar to dubbing roles',
        'two-line source-sidecar TTS text',
        'global voice fallback',
        'resume without model or resynthesis',
      ],
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(`Speaker E2E evidence: ${output}`);
  throw error;
} finally {
  if (movedModels) await fs.rename(movedModels.to, movedModels.from);
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
