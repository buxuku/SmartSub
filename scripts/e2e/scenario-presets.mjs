import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-presets-e2e-'),
);
const media = path.join(output, 'pauses.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
  '-t',
  '3',
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
let requests = 0;
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/transcriptions')
    return response.writeHead(404).end();
  request.resume();
  request.on('end', () => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        text: 'First I agree',
        language: 'en',
        duration: 3,
        segments: [{ start: 0, end: 1.5, text: 'First I agree' }],
        words: [
          { start: 0, end: 0.2, word: 'First' },
          { start: 0.6, end: 0.8, word: 'I' },
          { start: 1.2, end: 1.5, word: 'agree' },
        ],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  const origin = new URL(page.url()).origin;
  const key = 'smartsub_task_wizard_draft_v1';
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const globalBefore = await page.evaluate(() =>
    window.ipc.invoke('getSettings'),
  );
  await page.evaluate(
    async ({ media, key }) => {
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [media],
        taskType: 'media',
      });
      const defaults = await window.ipc.invoke('getUserConfig');
      localStorage.setItem(
        key,
        JSON.stringify({
          files,
          goals: { translate: false, dub: false, video: false },
          config: {
            ...defaults,
            transcriptionEngine: 'builtin',
            model: 'base',
            translateProvider: '-1',
            sourceLanguage: 'en',
            useEmbeddedSubtitles: false,
          },
          savedAt: Date.now(),
        }),
      );
    },
    { media, key },
  );
  await page.goto(`${origin}/zh/tasks/new/`);
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  // A fresh install is the 通用均衡 scenario, untouched: the name alone (no 已调整 dot, so
  // nothing to restore) and no "专家自定义" row anywhere.
  const scenarioButton = page.getByTestId('scenario-preset-trigger');
  await expect(scenarioButton).toHaveAccessibleName('通用均衡');
  await expect(page.getByTestId('scenario-adjusted-dot')).toHaveCount(0);
  await scenarioButton.click();
  await expect(page.getByTestId('scenario-footer-adjusted')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /专家自定义/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="scenario-option-"]')).toHaveCount(
    5,
  );
  await page.keyboard.press('Escape');
  // The popover's own footer also has a 「更多设置」 button; wait for it to be gone.
  await expect(page.locator('[data-testid^="scenario-option-"]')).toHaveCount(
    0,
  );
  // 常用 opens on the groups an ordinary user reaches for: in the smallest window the first
  // three of them are on the first screen of a fresh task, with no scrolling.
  const sheet = page.getByRole('dialog');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 700),
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
  // Opened from the keyboard: the panel itself takes focus (not whatever happens to be first
  // inside it) and, not being a control, draws no ring of its own around the whole sheet.
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: '更多设置', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toBeFocused();
  await expect(sheet).not.toHaveCSS('outline-style', 'auto');
  await expect(sheet.getByTestId('settings-tab-common')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The first two groups are fully on screen (ratio 1, so polling also waits out the sheet's
  // slide-in); the third starts there, its remaining rows are one short scroll away.
  for (const [group, ratio] of [
    ['source', 1],
    ['assist', 1],
    ['output', 0.5],
  ]) {
    await expect(
      sheet.getByTestId(`settings-group-${group}`),
      `the ${group} group is on the first screen of 常用 at 1024x700`,
    ).toBeInViewport({ ratio });
  }
  await page.screenshot({ path: path.join(output, 'common-1024.png') });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await scenarioButton.click();
  await page.getByRole('button', { name: /^会议访谈 \/ 播客/ }).click();
  const draftConfig = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key)).config, key);
  await expect
    .poll(async () => (await draftConfig()).scenarioPreset)
    .toBe('interview');
  const selected = await draftConfig();
  assert.equal(selected.subtitleMaxDuration, 3);
  assert.equal(selected.subtitleMaxGap, 0.25);
  assert.equal(selected.preserveSpeechPauses, true);
  assert.equal(selected.vadThreshold, 0.35);
  assert.equal(selected.speakerDiarization, true);

  // The scenario names itself, with no dot, once it is applied.
  await expect(scenarioButton).toHaveAccessibleName('会议访谈 / 播客');
  await expect(page.getByTestId('scenario-adjusted-dot')).toHaveCount(0);
  // The scenario's footer goes straight to the 专家 page; the recognition strategy is chosen
  // there, and 手动调节 lays the strategy's low-level parameters out.
  await scenarioButton.click();
  await page.getByTestId('scenario-open-expert').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('settings-tab-expert')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const vad = page.getByRole('slider', { name: 'VAD 语音阈值', exact: true });
  await expect(vad).toHaveCount(0);
  await sheet.getByTestId('outcome-select').click();
  await page.getByRole('option', { name: /^手动调节/ }).click();
  await expect(vad).toHaveAttribute('aria-valuenow', '0.35');
  await vad.focus();
  await page.keyboard.press('ArrowRight');
  await expect(vad).toHaveAttribute('aria-valuenow', '0.36');
  await expect.poll(async () => (await draftConfig()).vadThreshold).toBe(0.36);
  const expert = await draftConfig();
  assert.equal(expert.subtitleOutcome, 'custom');
  assert.equal(expert.maxContext, 0);
  assert.equal(expert.reduceRepetition, true);
  assert.equal(expert.preserveSpeechPauses, true);
  for (const width of [1024, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          width,
          width === 1024 ? 700 : 900,
        ),
      width,
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await vad.scrollIntoViewIfNeeded();
    await expect(vad).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, `expert-${width}.png`) });
    // The two pages share one scroll area: 常用 starts from its top even though 专家 was
    // scrolled to reach the slider.
    await sheet.getByTestId('settings-tab-common').click();
    await expect(
      sheet.getByTestId('settings-group-source'),
      `${width}: 常用 opens at its first group, not where 专家 was scrolled to`,
    ).toBeInViewport();
    await sheet.getByTestId('settings-tab-expert').click();
  }
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '更多设置', exact: true }).click();
  // The panel opens on 常用; the tuned value is one tab away.
  await expect(sheet.getByTestId('settings-tab-common')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await sheet.getByTestId('settings-tab-expert').click();
  await expect(vad).toHaveAttribute('aria-valuenow', '0.36');
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getSettings')),
    globalBefore,
    'expert edits stay task-local',
  );

  // Picking a built-in strategy again hands the task back to that tier: what 手动调节 held
  // (the slider tuned above included) goes with it, so the tier means what its name says.
  await page.getByRole('button', { name: '更多设置', exact: true }).click();
  await sheet.getByTestId('settings-tab-expert').click();
  await expect(vad).toHaveAttribute('aria-valuenow', '0.36');
  await sheet.getByTestId('outcome-select').click();
  await page.getByRole('option', { name: /^最干净最稳/ }).click();
  await expect
    .poll(async () => (await draftConfig()).subtitleOutcome)
    .toBe('clean');
  const handedBack = await draftConfig();
  for (const key of [
    'vadThreshold',
    'maxContext',
    'useVAD',
    'reduceRepetition',
  ])
    assert.equal(
      handedBack[key],
      undefined,
      `${key} does not outlive 手动调节`,
    );
  assert.equal(handedBack.preserveSpeechPauses, true, 'the scenario stays');
  await expect(vad).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Keep the actual task values, switch only the ASR transport to a local fixture. 「保存源
  // 字幕文件」 is deliberately left at the factory 「不保存」: a task that only generates
  // subtitles has to read that as the video's file name (see the assertions below).
  const provider = {
    id: 'scenario-asr',
    name: 'Scenario ASR',
    type: 'openaiCompatible',
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'test-only',
    models: ['whisper-1'],
  };
  await page.evaluate(
    async ({ key, provider }) => {
      window.ipc.send('setAsrProviders', [provider]);
      const draft = JSON.parse(localStorage.getItem(key));
      draft.config = {
        ...draft.config,
        transcriptionEngine: 'cloud',
        asrProviderId: provider.id,
        model: 'whisper-1',
        aiCorrection: false,
        aiSegmentation: false,
        speakerDiarization: false,
      };
      localStorage.setItem(key, JSON.stringify(draft));
    },
    { key, provider },
  );
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '本次上传', exact: true }).click();
  await expect.poll(() => requests, { timeout: 60000 }).toBe(1);
  await expect
    .poll(
      async () => {
        const items = await page.evaluate(() =>
          window.ipc.invoke('getWorkItems'),
        );
        return items.find((item) => item.type === 'generateOnly')
          ?.pipelineFiles?.[0]?.exportSubtitle;
      },
      { timeout: 60000 },
    )
    .toBe('done');
  const items = await page.evaluate(() => window.ipc.invoke('getWorkItems'));
  const task = items.find((item) => item.pipelineFiles?.length);
  assert.ok(task?.pipelineFiles[0].srtFile);
  // Nobody touched 「保存源字幕文件」: the subtitles are the deliverable, so they sit next to
  // the video as pauses.srt (not pauses_temp.srt), and the stored snapshot says what ran.
  assert.equal(path.basename(task.pipelineFiles[0].srtFile), 'pauses.srt');
  assert.deepEqual(
    (await fs.readdir(output)).filter((name) => name.endsWith('.srt')),
    ['pauses.srt'],
  );
  assert.equal(task.configSnapshot.sourceSrtSaveOption, 'fileName');
  const srt = await fs.readFile(task.pipelineFiles[0].srtFile, 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:00,200\s+First/);
  assert.match(srt, /00:00:00,600 --> 00:00:00,800\s+I/);
  assert.match(srt, /00:00:01,200 --> 00:00:01,500\s+agree/);
  await page.screenshot({ path: path.join(output, 'completed.png') });
  console.log(
    JSON.stringify({
      output,
      requests,
      subtitle: task.pipelineFiles[0].srtFile,
      checks: [
        'fresh install: 通用均衡, no 已调整 dot, five scenarios only',
        'keyboard open: panel focused, no ring, 常用 first three groups on the first screen at 1024x700',
        'preset application',
        'expert materialization',
        'keyboard VAD tuning',
        '1024/1440 layout and 常用 starting at its top after 专家',
        'refresh recovery',
        'global isolation',
        'leaving 手动调节 for a tier drops the values it held',
        'real local ASR pipeline',
        'factory 「不保存」 delivers pauses.srt, not pauses_temp.srt, for a subtitles-only task',
        'pause-preserving SRT',
      ],
    }),
  );
} catch (error) {
  console.error(`Scenario evidence: ${output}`);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
