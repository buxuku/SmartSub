import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-stage-settings-e2e-'),
);
const media = path.join(root, 'clip.mp4');
const subtitle = path.join(root, 'clip.srt');
const wav = path.join(root, 'voice.wav');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:01,500\nOriginal review text.\n\n',
);
execFileSync(require('ffmpeg-static'), [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=160x90:r=10:d=2',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=16000:cl=mono',
  '-t',
  '2',
  '-c:v',
  'mpeg4',
  '-c:a',
  'aac',
  media,
]);
execFileSync(require('ffmpeg-static'), [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000',
  '-t',
  '0.6',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  wav,
]);
const audio = await fs.readFile(wav);
const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.url === '/translate') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: '用于流程设置验收的字幕。' }));
    return;
  }
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { 'Content-Type': 'audio/wav' });
  response.end(audio);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  const skip = page.getByRole('button', { name: '跳过', exact: true });
  await skip.waitFor();
  await skip.click();
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload();
  const invoke = (channel, payload) =>
    page.evaluate(
      ({ channel, payload }) => window.ipc.invoke(channel, payload),
      { channel, payload },
    );
  const initial = await invoke('getUserConfig');
  // Render a real model label without downloading a model. The supplied SRT
  // bypasses transcription, so no fake model is used by the pipeline.
  await app.evaluate(
    ({ ipcMain }, systemInfo) => {
      ipcMain.removeHandler('getSystemInfo');
      ipcMain.handle('getSystemInfo', () => ({
        ...systemInfo,
        fasterWhisperModelsInstalled: ['large-v3-turbo'],
        pythonEngineStatus: { state: 'ready' },
      }));
    },
    await invoke('getSystemInfo'),
  );
  await invoke('setTranslationProviders', {
    expectedProviders: await invoke('getTranslationProviders'),
    providers: [
      {
        id: 'local-translation',
        type: 'deeplx',
        name: '本地翻译验收服务',
        isAi: false,
        apiUrl: `http://127.0.0.1:${server.address().port}/translate`,
      },
    ],
  });
  const providers = await invoke('getTtsProviders');
  await invoke('setTtsProviders', {
    expectedProviders: providers,
    providers: [
      {
        id: 'local-fixture',
        name: 'Local TTS fixture',
        type: 'openaiCompatible',
        apiKey: 'fixture',
        apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'fixture',
        voices: 'alloy,echo',
      },
    ],
  });

  const config = {
    ...initial,
    taskType: 'generateAndTranslate',
    transcriptionEngine: 'fasterWhisper',
    model: 'large-v3-turbo',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translateProvider: 'local-translation',
    translateContent: 'sourceAndTranslate',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    subtitleOutputFormats: ['srt'],
    dub: {
      engine: { kind: 'cloud', providerId: 'local-fixture' },
      voice: 'alloy',
      globalSpeed: 1,
      language: 'en',
    },
    compose: { subtitle: 'soft' },
    gates: { subtitle: 'manual', dubbing: 'auto' },
  };
  const recipe = await invoke('recipes:save', {
    name: '配方流程验收',
    goals: { translate: true, dub: true, video: true },
    accepts: 'media',
    config,
  });
  assert.ok(recipe.id, JSON.stringify(recipe));
  await page.evaluate(
    (id) => window.next.router.push(`/zh/tasks/new/?recipe=${id}`),
    recipe.id,
  );
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: paths,
      });
    },
    [media, subtitle],
  );
  await page.getByRole('button', { name: '导入文件', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: '声音', exact: true }),
  ).toBeVisible();
  const choose = async (label, option) => {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await choose('声音', 'echo');
  await choose('语速', '1.1x');
  const subtitleGate = page.getByRole('switch', {
    name: '字幕校对',
    exact: true,
  });
  if (!(await subtitleGate.isChecked())) await subtitleGate.click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/project=/);
  const projectId = new URL(page.url()).searchParams.get('project');
  const get = () => invoke('taskRuns:get', { projectId });
  const wait = async (predicate) => {
    for (let n = 0; n < 900; n++) {
      const run = await get();
      if (run?.status === 'failed') throw new Error(JSON.stringify(run));
      if (predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${JSON.stringify(await get())}`);
  };
  const first = await wait((run) => run?.status === 'waiting_review');
  assert.equal(first.config.dub.voice, 'echo');
  assert.equal(first.config.dub.globalSpeed, 1.1);
  await expect(page.getByTestId('task-pipeline-title')).toHaveText(
    '配方流程验收',
  );
  await expect(
    page.getByRole('tab', { name: '视频 → 双语字幕', exact: true }),
  ).toHaveCount(0);
  const section = async (name) =>
    page.getByRole('tab', { name, exact: true }).click();
  const checkLayout = async (width, state) => {
    await page.setViewportSize({ width, height: 960 });
    const panel = page.getByTestId('task-config-sections');
    await expect(panel).toBeVisible();
    // Let newly mounted select values and the resized viewport finish layout.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: path.join(root, `${state}-${width}.png`),
      animations: 'disabled',
    });
    const violations = await panel.evaluate((el) => {
      const problems = [];
      if (el.scrollWidth > el.clientWidth + 1) problems.push('panel overflow');
      for (const tab of el.querySelectorAll('[role="tab"]')) {
        const bounds = tab.getBoundingClientRect();
        for (const content of tab.querySelectorAll('span, svg')) {
          const rect = content.getBoundingClientRect();
          if (
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1 ||
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1
          )
            problems.push(
              `tab content clipped: ${tab.getAttribute('aria-label')}`,
            );
        }
      }
      const toolbar =
        el.querySelector('[data-testid="task-inspector-core"]') ||
        el.querySelector('[role="tabpanel"][data-state="active"] fieldset');
      if (toolbar) {
        const rect = toolbar.getBoundingClientRect();
        const rows = new Set();
        for (const item of toolbar.children) {
          const bounds = item.getBoundingClientRect();
          rows.add(Math.round(bounds.top));
          if (bounds.width < 72)
            problems.push(`cramped field: ${item.textContent}`);
          if (bounds.width > 220)
            problems.push(`stretched field: ${item.textContent}`);
          if (bounds.left < rect.left - 1 || bounds.right > rect.right + 1)
            problems.push(`toolbar overflow: ${item.textContent}`);
          const control = item.querySelector('button, a');
          if (control) {
            const box = control.getBoundingClientRect();
            if (Math.abs(box.height - 32) > 1)
              problems.push(`inconsistent control height: ${item.textContent}`);
            if (box.left < bounds.left - 1 || box.right > bounds.right + 1)
              problems.push(`control overflow: ${item.textContent}`);
          }
        }
        const maxRows = window.innerWidth >= 1200 ? 1 : 2;
        if (rows.size > maxRows)
          problems.push(`toolbar uses ${rows.size} rows (max ${maxRows})`);
        if (toolbar.matches(':disabled')) {
          for (const link of toolbar.querySelectorAll('a')) {
            if (Number(getComputedStyle(link).opacity) > 0.5)
              problems.push(
                `locked link appears editable: ${link.textContent}`,
              );
          }
        }
        const model = toolbar.querySelector('#model');
        if (model) {
          for (const label of model.querySelectorAll('span')) {
            if (label.scrollWidth > label.clientWidth + 1)
              problems.push(`model label clipped: ${label.textContent}`);
          }
        }
      }
      return problems;
    });
    assert.deepEqual(
      violations,
      [],
      `${state} layout at ${width}; evidence: ${root}`,
    );
  };
  await checkLayout(1024, 'locked-subtitle');
  await section('配音');
  await expect(
    page.getByRole('combobox', { name: '声音', exact: true }),
  ).toBeDisabled();
  await section('视频合成');
  await expect(
    page.getByRole('combobox', { name: '字幕方式', exact: true }),
  ).toBeDisabled();
  await section('流程设置');
  await expect(
    page.getByRole('switch', { name: '字幕校对', exact: true }),
  ).toBeDisabled();
  await invoke('taskRuns:command', {
    projectId,
    expectedRunId: first.runId,
    requestId: 'cancel',
    command: 'cancel',
  });
  await wait((run) => run.status === 'cancelled');
  await expect(
    page.getByRole('button', { name: '全部放行', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '放行', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('switch', { name: '字幕校对', exact: true }),
  ).toBeEnabled();
  await page.getByRole('switch', { name: '字幕校对', exact: true }).click();
  await section('配音');
  await choose('声音', 'alloy');
  await choose('语速', '1.25x');
  await section('视频合成');
  await choose('字幕方式', '烧录进画面（推荐）');
  await choose('字幕样式', '经典白字黑边');
  await choose('导出画质', '标准');
  const getDraft = () => invoke('taskRuns:getDraft', projectId);
  await expect
    .poll(async () => (await getDraft())?.config.compose.videoQuality)
    .toBe('standard');
  const draft = await getDraft();
  assert.equal(draft.config.dub.voice, 'alloy');
  assert.equal(draft.config.dub.globalSpeed, 1.25);
  assert.equal(draft.config.gates.subtitle, 'auto');
  assert.equal((await get()).config.dub.voice, 'echo');
  assert.equal((await get()).config.compose.subtitle, 'soft');
  const unchanged = (await invoke('recipes:list')).find(
    (item) => item.id === recipe.id,
  );
  assert.deepEqual(unchanged.config, recipe.config);
  await page.reload();
  await section('配音');
  await expect(
    page.getByRole('combobox', { name: '语速', exact: true }),
  ).toContainText('1.25x');
  await section('视频合成');
  await expect(
    page.getByRole('combobox', { name: '导出画质', exact: true }),
  ).toContainText('标准');
  for (const width of [1024, 1200, 1440, 1920]) {
    for (const [name, key] of [
      ['字幕与翻译', 'subtitle'],
      ['配音', 'dubbing'],
      ['视频合成', 'compose'],
      ['流程设置', 'review'],
    ]) {
      await section(name);
      await checkLayout(width, key);
    }
  }
  await page.getByRole('button', { name: '重新处理', exact: true }).click();
  const second = await wait(
    (run) => run?.runId !== first.runId && run?.status === 'succeeded',
  );
  assert.equal(second.config.dub.voice, 'alloy');
  assert.equal(second.config.dub.globalSpeed, 1.25);
  assert.equal(second.files[0].stages.extractSubtitle.outcome, 'reused');
  assert.equal(second.files[0].stages.composeVideo.status, 'succeeded');
  assert.equal(requests.length, 1);
  await section('视频合成');
  await expect(
    page.getByRole('combobox', { name: '导出画质', exact: true }),
  ).toBeEnabled();
  await choose('导出画质', '高画质');
  await expect
    .poll(async () => (await getDraft())?.config.compose.videoQuality)
    .toBe('high');
  await page.getByRole('button', { name: '重新处理', exact: true }).click();
  const third = await wait(
    (run) => run?.runId !== second.runId && run?.status === 'succeeded',
  );
  assert.equal(third.files[0].stages.dubbing.outcome, 'reused');
  assert.equal(third.files[0].stages.composeVideo.outcome, 'executed');
  assert.equal(
    requests.length,
    1,
    'compose-only edits must not synthesize speech again',
  );
  console.log(`Task stage settings acceptance passed. Evidence: ${root}`);
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
}
