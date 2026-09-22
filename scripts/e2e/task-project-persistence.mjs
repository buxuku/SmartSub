import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-task-project-e2e-'),
);
const profile = path.join(evidence, 'profile');
let app;
let page;
let locked;
let configPath;
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
  const initial = await page.evaluate(() => window.ipc.invoke('getUserConfig'));
  const defaults = {
    ...initial,
    scenarioPreset: 'balanced',
    subtitleOutcome: 'balanced',
    sourceSrtSaveOption: 'fileName',
    taskType: 'generateOnly',
  };
  await page.evaluate(
    (config) => window.ipc.send('setUserConfig', config),
    defaults,
  );
  await page.evaluate(() => window.next.router.push('/zh/tasks/generate/'));
  const choosePreset = async (current, next) => {
    await page.getByRole('button', { name: current, exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`^${next}`) }).click();
  };
  await choosePreset(/^(通用均衡|专家自定义)$/, '影视');
  await expect(page).toHaveURL(/project=/);
  const id = new URL(page.url()).searchParams.get('project');
  const item = () =>
    page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  await expect
    .poll(async () => (await item())?.taskDraft?.config?.scenarioPreset)
    .toBe('movie');
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getUserConfig')),
    defaults,
    'ordinary task edits never mutate defaults',
  );
  const movieName = await page
    .getByRole('button', { name: /^影视/ })
    .innerText();
  for (const directory of [profile, `${profile}-dev`]) {
    const candidate = path.join(directory, 'config.json');
    const data = await fs.readFile(candidate, 'utf8').catch(() => null);
    if (data && JSON.parse(data).workItems?.some((item) => item.id === id))
      configPath = candidate;
  }
  assert.ok(configPath, 'configuration-only draft persisted on disk');
  await page.reload();
  await expect(
    page.getByRole('button', { name: movieName, exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.next.router.push('/zh/tasks/generate/'));
  await expect(
    page.getByRole('button', { name: /^(通用均衡|专家自定义)$/, exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (id) => window.next.router.push(`/zh/tasks/generate/?project=${id}`),
    id,
  );
  await expect(
    page.getByRole('button', { name: movieName, exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '视频 → 双语字幕', exact: true }).click();
  await expect(page).toHaveURL(/generate-translate/);
  assert.equal(
    new URL(page.url()).searchParams.get('project'),
    id,
    'compatible mode keeps configuration-only project',
  );
  await expect
    .poll(async () => (await item()).taskDraft.config.taskType)
    .toBe('generateAndTranslate');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [
        '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
      ],
    });
  });
  await page.getByRole('button', { name: '导入', exact: true }).first().click();
  await expect.poll(async () => (await item()).pipelineFiles.length).toBe(1);
  assert.equal(
    (await item()).taskDraft.config.scenarioPreset,
    'movie',
    'file import retains project settings',
  );
  if (process.platform !== 'win32') {
    locked = path.dirname(configPath);
    await fs.chmod(locked, 0o500);
    await choosePreset(movieName, '网课');
    await expect(
      page.getByRole('alert').filter({ hasText: '任务草稿保存失败' }),
    ).toBeVisible();
    assert.equal((await item()).taskDraft.config.scenarioPreset, 'movie');
    await page.getByRole('link', { name: '启动台', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page).toHaveURL(/tasks\/generate-translate/);
    await page.getByRole('button', { name: '留在当前页', exact: true }).click();
    await page.screenshot({
      path: path.join(evidence, 'failed-save-guard.png'),
    });
    await fs.chmod(locked, 0o700);
    locked = undefined;
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect
      .poll(async () => (await item()).taskDraft.config.scenarioPreset)
      .toBe('lecture');
    await expect(
      page.getByRole('alert').filter({ hasText: '任务草稿保存失败' }),
    ).toHaveCount(0);
  }
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
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'no page-level horizontal overflow',
    );
    await page.screenshot({
      path: path.join(evidence, `restored-${width}.png`),
    });
  }
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getUserConfig')),
    defaults,
  );
  const saved = JSON.parse(
    await fs.readFile(configPath, 'utf8'),
  ).workItems.find((item) => item.id === id);
  assert.equal(saved.pipelineFiles.length, 1);
  assert.equal(
    saved.taskDraft.config.scenarioPreset,
    process.platform === 'win32' ? 'movie' : 'lecture',
  );
  const child = app.process();
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exit;
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
  await page.evaluate(
    (id) =>
      window.next.router.push(`/zh/tasks/generate-translate/?project=${id}`),
    id,
  );
  assert.equal(
    (await item()).taskDraft.config.scenarioPreset,
    saved.taskDraft.config.scenarioPreset,
  );
  await expect(
    page.getByRole('button', {
      name: process.platform === 'win32' ? movieName : '网课演讲 / 教程',
      exact: true,
    }),
  ).toBeVisible();
  const longProviderName =
    'International Production Translation Service With An Extraordinarily Long Name';
  const longModelName =
    'enterprise-transcription-multilingual-large-model-production-version';
  await page.evaluate(
    async ({ id, longProviderName, longModelName }) => {
      window.ipc.send('setAsrProviders', [
        {
          id: 'long-asr',
          name: longProviderName,
          type: 'openaiCompatible',
          apiUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'test',
          models: [longModelName],
        },
      ]);
      window.ipc.send('setTranslationProviders', [
        {
          id: 'long-ai',
          name: longProviderName,
          type: 'openai',
          isAi: true,
          apiUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'test',
          modelName: 'test',
        },
      ]);
      const item = await window.ipc.invoke('getWorkItem', id);
      await window.ipc.invoke('saveTaskProject', {
        id,
        taskType: 'generateAndTranslate',
        files: item.pipelineFiles,
        taskDraft: {
          ...item.taskDraft,
          config: {
            ...item.taskDraft.config,
            transcriptionEngine: 'cloud',
            asrProviderId: 'long-asr',
            model: longModelName,
            translateProvider: 'long-ai',
          },
        },
        preserveTaskProgress: true,
      });
    },
    { id, longProviderName, longModelName },
  );
  await page.goto(
    `${new URL(page.url()).origin}/en/tasks/generate-translate/?project=${id}`,
  );
  const inspector = page.getByTestId('task-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText(longProviderName);
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
    const clipping = await inspector.evaluate((element) =>
      Array.from(element.querySelectorAll('button'))
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return (
            rect.x < 0 ||
            rect.right > innerWidth ||
            !hit ||
            !button.contains(hit)
          );
        })
        .map((button) => button.textContent),
    );
    assert.deepEqual(
      clipping,
      [],
      'every English inspector control stays in bounds and hit-testable',
    );
    const coreTops = await page
      .getByTestId('task-inspector-core')
      .locator('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
    assert.equal(new Set(coreTops).size, 1, 'core controls stay on one row');
    for (const tab of await page.getByRole('tab').all()) {
      await tab.click({ trial: true });
      assert.equal(
        await tab.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          let parent = element.parentElement;
          while (parent) {
            if (/(hidden|clip)/.test(getComputedStyle(parent).overflowX)) {
              const box = parent.getBoundingClientRect();
              if (rect.left < box.left || rect.right > box.right) return false;
            }
            parent = parent.parentElement;
          }
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
        true,
        'mode tab is completely visible inside clipping ancestors',
      );
    }
    await page.screenshot({
      path: path.join(evidence, `english-long-labels-${width}.png`),
    });
  }
  console.log(
    JSON.stringify({
      evidence,
      checks: [
        'configuration-only persistence',
        'reload recovery',
        'new project reset',
        'project return recovery',
        'mode switch',
        'import preserves config',
        'real disk failure and navigation guard',
        'retry',
        'default isolation',
        '1024 and 1440 layout',
        'SIGKILL and restart',
        'English long labels: per-control bounds and hit tests at 1024/1440',
      ],
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(evidence, 'failure.png') })
    .catch(() => {});
  console.error('Task project evidence:', evidence);
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  await app?.close().catch(() => {});
}
