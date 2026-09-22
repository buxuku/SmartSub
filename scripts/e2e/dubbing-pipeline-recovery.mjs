import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-dub-recovery-e2e-'),
);
const media = path.join(output, 'recovery.mp4');
const subtitle = path.join(output, 'recovery.srt');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
  '-t',
  '7',
  '-vf',
  'scale=320:-2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  media,
]);
const original =
  '1\n00:00:00,000 --> 00:00:02,000\nLong sentence needs shortening.\n\n2\n00:00:04,000 --> 00:00:06,000\nFinal sentence.\n';
await fs.writeFile(subtitle, original);
const waves = new Map();
for (const ms of [1800, 2800]) {
  const file = path.join(output, `tone-${ms}.wav`);
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=24000:duration=${ms / 1000}`,
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  waves.set(ms, await fs.readFile(file));
}
const requests = [],
  aiRequests = [],
  errors = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/v1/audio/speech') {
      requests.push(body);
      res
        .writeHead(200, { 'Content-Type': 'audio/wav' })
        .end(waves.get(body.input.startsWith('Long') ? 2800 : 1800));
    } else {
      aiRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
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
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page;
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const origin = new URL(page.url()).origin;
  await page.evaluate(
    async ({ media, subtitle, url }) => {
      window.ipc.send('setTtsProviders', [
        {
          id: 'recovery-tts',
          name: 'Recovery TTS',
          type: 'openaiCompatible',
          apiKey: 'test-only',
          apiUrl: url,
          model: 'fixture',
          voices: 'alloy',
        },
      ]);
      window.ipc.send('setTranslationProviders', [
        {
          id: 'recovery-ai',
          name: 'Recovery AI',
          type: 'openai',
          isAi: true,
          apiKey: 'test-only',
          apiUrl: url,
          modelName: 'fixture',
          prompt: '${content}',
          requestInterval: 0,
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media, subtitle],
        taskType: 'any',
      });
      localStorage.setItem(
        'smartsub_task_wizard_draft_v1',
        JSON.stringify({
          files,
          manualPairs: [[media, subtitle]],
          goals: { translate: false, dub: true, video: true },
          config: {
            taskType: 'generateOnly',
            translateProvider: '-1',
            sourceLanguage: 'en',
            aiCorrection: false,
            aiSegmentation: false,
          },
          pipeline: {
            dubbing: {
              engineKey: 'cloud:recovery-tts',
              voice: 'alloy',
              language: 'en',
              globalSpeed: 1,
            },
            subtitle: 'soft',
            styleId: 'classic',
            quality: 'original',
            encoder: 'cpu',
            subtitleGate: false,
            dubbingGate: false,
            recipeName: null,
          },
          savedAt: Date.now(),
        }),
      );
    },
    { media, subtitle, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/project=/);
  const id = new URL(page.url()).searchParams.get('project');
  const item = () =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  await expect
    .poll(async () => (await item())?.pipelineFiles[0]?.dubbing, {
      timeout: 60000,
    })
    .toBe('error');
  const failed = (await item()).pipelineFiles[0];
  assert.equal(failed.finalVideoPath, undefined);
  assert.equal(requests.length, 2);
  await page.getByRole('button', { name: '检查配音', exact: true }).click();
  await expect(page.getByTestId('overrun-0')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '放行并继续', exact: true }),
  ).toBeDisabled();
  const speed = page.getByRole('slider', { name: '整体语速', exact: true });
  await speed.focus();
  await page.keyboard.press('ArrowRight');
  await expect(speed).toHaveAttribute('aria-valuenow', '1.05');
  await page
    .getByTestId('overrun-0')
    .getByRole('button', { name: 'AI 缩写并重生成' })
    .click();
  await expect(page.getByText('Short.', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '重新生成全部需更新项', exact: true })
    .first()
    .click();
  await expect.poll(() => requests.length).toBe(4);
  const session = () =>
    page.evaluate(
      (sessionId) => window.ipc.invoke('dubbing:getSession', { sessionId }),
      failed.dubbingSessionId,
    );
  await expect
    .poll(async () =>
      (await session()).data.cues.every(
        (c) => c.status === 'done' && !c.needsUpdate,
      ),
    )
    .toBe(true);
  const repaired = (await session()).data;
  assert.equal(repaired.configSnapshot.globalSpeed, 1.05);
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
    await page.screenshot({ path: path.join(output, `repaired-${width}.png`) });
  }
  // Inspector mode intentionally hides standalone export. Reopen the same saved
  // session as a regular workbench, then return to the failed pipeline task.
  await page.getByRole('button', { name: '返回任务', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/.*project=/);
  const taskUrl = page.url();
  await page.evaluate(
    (sessionId) => window.next.router.push(`/zh/dubbing/?session=${sessionId}`),
    failed.dubbingSessionId,
  );
  await page.getByRole('combobox', { name: '输出形态', exact: true }).click();
  await page
    .getByRole('option', { name: '替换音轨的视频', exact: true })
    .click();
  await page.getByRole('button', { name: '高级选项', exact: true }).click();
  await page
    .getByRole('switch', { name: '同时导出对齐后字幕', exact: true })
    .click();
  const priorCaption = path.join(output, 'recovery-dubbed.dubbed.srt');
  await fs.writeFile(priorCaption, 'existing user subtitle');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const workbenchVideo = path.join(output, 'recovery-dubbed_2.mp4');
  await expect(page.getByText(workbenchVideo, { exact: true })).toBeVisible();
  assert.equal(
    await fs.readFile(priorCaption, 'utf8'),
    'existing user subtitle',
  );
  assert.match(
    await fs.readFile(
      path.join(output, 'recovery-dubbed_2.dubbed.srt'),
      'utf8',
    ),
    /Short\./,
  );
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-i',
    workbenchVideo,
    '-f',
    'null',
    '-',
  ]);
  assert.equal(
    (await fs.readdir(output)).some((name) =>
      name.startsWith('.smartsub-compose-'),
    ),
    false,
  );
  await page.goto(taskUrl);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect
    .poll(async () => (await item()).pipelineFiles[0].composeVideo, {
      timeout: 60000,
    })
    .toBe('done');
  const result = (await item()).pipelineFiles[0];
  assert.equal(result.dubbingError, '');
  await expect(page.getByText(/还有 1 条配音未生成、失败或超限/)).toHaveCount(
    0,
  );
  assert.equal(result.dubbingSessionId, failed.dubbingSessionId);
  assert.equal(requests.length, 4, 'retry must reuse repaired audio');
  assert.equal(aiRequests.length, 1);
  assert.deepEqual(
    (await session()).data.cues.map((c) => c.wavPath),
    repaired.cues.map((c) => c.wavPath),
  );
  assert.equal(await fs.readFile(subtitle, 'utf8'), original);
  const captions = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-copyts',
    '-i',
    result.finalVideoPath,
    '-map',
    '0:s:0',
    '-f',
    'srt',
    'pipe:1',
  ]).toString();
  assert.match(captions, /Short\./);
  assert.doesNotMatch(captions, /Long sentence/);
  assert.match(captions, /00:00:04,000 --> 00:00:06,000/);
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-i',
    result.finalVideoPath,
    '-map',
    '0:a:0',
    '-f',
    's16le',
    '-ar',
    '24000',
    '-ac',
    '1',
    'pipe:1',
  ]);
  const peak = (a, b) => {
    let max = 0;
    for (
      let i = Math.round(a * 24000);
      i < Math.min(pcm.length / 2, Math.round(b * 24000));
      i++
    )
      max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)));
    return max;
  };
  assert.ok(peak(0.2, 1.4) > 1000);
  assert.ok(peak(2.3, 3.8) < 20);
  assert.ok(peak(4.1, 5.4) > 1000);
  await page.screenshot({ path: path.join(output, 'completed.png') });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      output,
      finalVideoPath: result.finalVideoPath,
      requests: requests.length,
      aiRequests: aiRequests.length,
      checks:
        'UI task failure, inspect, speed repair and AI shortening, stale-row regeneration, workbench video/caption collision protection, return/retry with no extra TTS, original subtitle preserved, real video caption/PCM verification, responsive screenshots',
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(`Recovery E2E evidence: ${output}`);
  throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
