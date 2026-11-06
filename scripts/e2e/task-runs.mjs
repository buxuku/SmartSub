import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-task-runs-e2e-'),
);
const media = path.join(root, 'clip.mp4');
const subtitle = path.join(root, 'provided.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:01,000\nHello world.\n\n',
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
let app;
try {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  const invoke = (channel, payload) =>
    page.evaluate(
      ({ channel, payload }) => window.ipc.invoke(channel, payload),
      { channel, payload },
    );
  const navigate = async (url) => {
    const cancelled = await page.evaluate(async (url) => {
      try {
        await window.next.router.push(url);
        return null;
      } catch (error) {
        if (!error?.cancelled) throw error;
        return error.code || 'REDIRECTED';
      }
    }, url);
    if (cancelled === 'SMARTSUB_UNSAVED_NAVIGATION') {
      // A direct navigation may beat the 150 ms autosave; exercise Save and leave.
      await page
        .getByRole('button', { name: '保存并离开', exact: true })
        .click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
  };
  const skip = page.getByRole('button', { name: '跳过', exact: true });
  if (await skip.isVisible()) await skip.click();
  const initial = await invoke('getUserConfig');
  const file = {
    uuid: 'media',
    filePath: media,
    fileName:
      'A-very-long-video-file-name-for-checking-task-stage-layout-with-reused-results-final-version-2026',
    fileExtension: '.mp4',
    directory: root,
    providedSubtitlePath: subtitle,
  };
  const formData = {
    ...initial,
    taskType: 'generateOnly',
    translateProvider: '-1',
    aiCorrection: false,
    aiSegmentation: false,
    speakerDiarization: false,
    generateSummary: false,
    sourceSrtSaveOption: 'fileName',
    subtitleOutputFormats: ['srt'],
  };
  const projectId = 'task-runtime-e2e';
  const get = () => invoke('taskRuns:get', { projectId });
  const wait = async (predicate) => {
    for (let n = 0; n < 200; n++) {
      const run = await get();
      if (predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Run timed out: ${JSON.stringify(await get())}`);
  };
  const first = await invoke('submitTask', {
    projectId,
    requestId: 'first',
    files: [file],
    formData,
  });
  assert.equal(first.success, true, JSON.stringify(first));
  const done = await wait((run) =>
    ['succeeded', 'failed'].includes(run?.status),
  );
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  assert.equal(done.files[0].stages.prepareInput.status, 'succeeded');
  const sidecar = done.files[0].projection.proofreadDataFile;
  assert.ok(sidecar.includes('/edits/'));
  const before = await fs.readFile(sidecar, 'utf8');
  const rows = await invoke('readProofreadDataFile', {
    filePath: sidecar,
    strict: true,
  });
  rows.subtitles[0].sourceContent = 'Manually edited';
  const saved = await invoke('saveProofreadDataAndRender', {
    proofreadDataFile: sidecar,
    subtitles: rows.subtitles,
    outputs: [],
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const second = await invoke('submitTask', {
    projectId,
    requestId: 'second',
    files: [done.files[0].projection],
    formData,
  });
  assert.equal(second.success, true, JSON.stringify(second));
  const again = await wait(
    (run) =>
      run?.runId === second.runId &&
      ['succeeded', 'failed'].includes(run.status),
  );
  assert.equal(again.status, 'succeeded', JSON.stringify(again));
  assert.equal(again.files[0].stages.extractSubtitle.outcome, 'reused');
  assert.notEqual(again.files[0].projection.proofreadDataFile, sidecar);
  assert.equal(
    JSON.parse(
      await fs.readFile(again.files[0].projection.proofreadDataFile, 'utf8'),
    ).cues[0].source,
    'Hello world.',
  );
  assert.equal(
    JSON.parse(await fs.readFile(sidecar, 'utf8')).cues[0].source,
    'Manually edited',
  );
  assert.equal((await invoke('taskRuns:list', projectId)).length, 2);
  assert.equal(
    again.files[0].input.providedSubtitlePath,
    subtitle,
    'rerun restores original input binding',
  );
  await navigate(`/zh/tasks/generate/?project=${projectId}`);
  const sourceLanguage = page.getByRole('combobox', {
    name: '视频语言',
    exact: true,
  });
  await expect(sourceLanguage).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '重新处理', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('历史运行', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '编辑下一轮配置', exact: true }),
  ).toHaveCount(0);
  for (const width of [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page
      .getByTestId('task-row')
      .first()
      .evaluate((row) => {
        const name = row
          .querySelector('[data-testid="task-name"]')
          .getBoundingClientRect();
        const rail = row
          .querySelector('[data-testid="task-stage-rail"]')
          .getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return {
          filenameWidth: name.width,
          separated: name.bottom <= rail.top,
          contained: rail.left >= bounds.left && rail.right <= bounds.right,
          overflow: row.scrollWidth > row.clientWidth,
        };
      });
    assert.ok(
      geometry.filenameWidth > 160,
      JSON.stringify({ width, geometry }),
    );
    assert.equal(geometry.separated, true);
    assert.equal(geometry.contained, true);
    assert.equal(geometry.overflow, false);
    await page.screenshot({
      path: path.join(root, `compact-task-${width}.png`),
    });
  }
  const reused = page
    .locator('[data-testid="rail-chip"][data-outcome="reused"]')
    .first();
  assert.ok((await reused.getAttribute('title')).includes('已复用'));
  assert.equal((await reused.innerText()).includes('已复用'), false);
  await sourceLanguage.click();
  await page.getByRole('option', { name: '日语', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke('taskRuns:getDraft', projectId))?.config.sourceLanguage,
    )
    .toBe('ja');
  assert.equal((await get()).config.sourceLanguage, formData.sourceLanguage);
  await page.reload();
  await expect(sourceLanguage).toBeEnabled();
  await expect(sourceLanguage).toContainText('日语');
  await page.getByRole('button', { name: '重新处理', exact: true }).click();
  const edited = await wait(
    (run) =>
      run?.runId !== again.runId &&
      ['succeeded', 'failed'].includes(run.status),
  );
  assert.equal(edited.status, 'succeeded', JSON.stringify(edited));
  assert.equal(edited.config.sourceLanguage, 'ja');
  assert.equal(
    (await invoke('taskRuns:get', { projectId, runId: again.runId })).config
      .sourceLanguage,
    formData.sourceLanguage,
  );
  await expect(sourceLanguage).toBeEnabled();
  const oldEdit = await invoke('saveProofreadDataAndRender', {
    proofreadDataFile: sidecar,
    subtitles: [],
    outputs: [],
  });
  assert.ok(
    oldEdit.error?.includes('TASK_HISTORY_READ_ONLY'),
    JSON.stringify(oldEdit),
  );
  const third = await invoke('submitTask', {
    projectId,
    requestId: 'third',
    files: [file],
    formData,
  });
  await invoke('taskRuns:command', {
    projectId,
    expectedRunId: third.runId,
    requestId: 'pause',
    command: 'pause',
  });
  await wait((run) => run?.status === 'paused');
  await expect(sourceLanguage).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '更多设置', exact: true }),
  ).toBeDisabled();
  await assert.rejects(
    invoke('taskRuns:saveDraft', {
      projectId,
      expectedDraftRevision: 0,
      config: {},
      files: [],
    }),
    /TASK_CONFIG_BUSY/,
  );
  await assert.rejects(
    invoke('saveTaskProject', {
      id: projectId,
      files: [file],
      taskDraft: { config: {}, manuscripts: [] },
    }),
    /TASK_CONFIG_BUSY/,
  );
  await invoke('taskRuns:command', {
    projectId,
    expectedRunId: third.runId,
    requestId: 'cancel',
    command: 'cancel',
  });
  await wait((run) => run?.status === 'cancelled');
  await expect(sourceLanguage).toBeEnabled();
  await expect(sourceLanguage).toContainText('英语');
  await page.getByRole('tab', { name: '视频 → 双语字幕', exact: true }).click();
  await expect(page).toHaveURL(/generate-translate/);
  await expect
    .poll(
      async () =>
        (await invoke('taskRuns:getDraft', projectId))?.config.taskType,
    )
    .toBe('generateAndTranslate');
  assert.equal((await get()).config.taskType, 'generateOnly');
  await navigate(`/zh/tasks/generate/?project=${projectId}`);
  await expect(page).toHaveURL(/generate-translate/);
  await expect
    .poll(
      async () =>
        (await invoke('taskRuns:getDraft', projectId))?.config.taskType,
    )
    .toBe('generateAndTranslate');
  await page.getByRole('tab', { name: '视频 → 原文字幕', exact: true }).click();
  await expect(page).toHaveURL(/tasks\/generate\//);
  await expect(sourceLanguage).toBeEnabled();
  await sourceLanguage.click();
  await page.getByRole('option', { name: '日语', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke('taskRuns:getDraft', projectId))?.config.sourceLanguage,
    )
    .toBe('ja');
  await navigate('/zh/tasks/generate/');
  await expect(sourceLanguage).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '导入', exact: true }),
  ).toBeEnabled();
  await assert.rejects(
    invoke('taskRuns:command', {
      projectId,
      expectedRunId: first.runId,
      requestId: 'old',
      command: 'resume',
    }),
    /TASK_RUN_CONFLICT/,
  );
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  await expect(page).toHaveURL(/project=/);
  await navigate('/zh/');
  assert.equal(await invoke('deleteWorkItem', projectId), true);
  await app.close();
  app = null;
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const restartedPage = await app.firstWindow();
  await restartedPage.waitForFunction(() => Boolean(window.ipc?.invoke));
  assert.equal(
    await restartedPage.evaluate(
      (id) => window.ipc.invoke('getWorkItem', id),
      projectId,
    ),
    null,
    'deleted tasks must not resurrect after startup',
  );
  console.log(`Task run Electron acceptance passed. Evidence: ${root}`);
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}

await import('./task-runs-presentation.mjs');
await import('./task-runs-review.mjs');
await import('./task-runs-delivery.mjs');

await import('./task-stage-settings.mjs');
