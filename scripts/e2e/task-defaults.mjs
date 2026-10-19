import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

/**
 * Advanced settings changed on a task page become the defaults of the next new task as they
 * are changed (the 3.8 behaviour): the task never has to be started, leaving the page right
 * after an edit does not lose it, and what belongs to a single task stays with that task.
 */
const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-task-defaults-e2e-'),
);
const subtitle = path.join(evidence, 'lesson.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:01,000\nHello SmartSub.\n\n',
);
let app;
let page;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(evidence, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  // The first visit to a page compiles it in the dev server.
  page.setDefaultTimeout(60000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }, file) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    // Acknowledge submissions without running the pipeline: only the hand-off matters.
    globalThis.submissions = [];
    ipcMain.removeHandler('submitTask');
    ipcMain.handle('submitTask', async (_event, payload) => {
      globalThis.submissions.push(payload);
      return {
        success: true,
        projectId: payload.projectId,
        requestId: payload.requestId,
        acceptedFileUuids: payload.files.map((file) => file.uuid),
        duplicate: false,
      };
    });
  }, subtitle);
  await page.getByRole('button', { name: '跳过', exact: true }).click();

  const userConfig = () =>
    page.evaluate(() => window.ipc.invoke('getUserConfig'));
  const initial = await userConfig();
  assert.equal(initial.translateRetryTimes, undefined);
  assert.equal(initial.maxConcurrentTasks, 1);

  // Open a translation task and change an advanced setting in the real UI.
  await page.evaluate(() => window.next.router.push('/zh/tasks/translate/'));
  await page.getByRole('button', { name: '导入', exact: true }).first().click();
  await expect(page).toHaveURL(/project=/);
  const projectId = new URL(page.url()).searchParams.get('project');
  await page.getByRole('button', { name: '高级选项' }).click();
  await page.getByLabel('翻译重试次数').fill('7');
  // The task is never started: the edit alone updates the defaults of the next new task.
  await expect
    .poll(async () => Number((await userConfig()).translateRetryTimes), {
      timeout: 10000,
    })
    .toBe(7);
  assert.equal(
    await app.evaluate(() => globalThis.submissions.length),
    0,
    'the task was never started',
  );
  await expect
    .poll(async () =>
      Number(
        (
          await page.evaluate(
            (id) => window.ipc.invoke('getWorkItem', id),
            projectId,
          )
        )?.taskDraft?.config?.translateRetryTimes,
      ),
    )
    .toBe(7);

  // Leaving the page straight after an edit does not lose it either. The draft may still be
  // unsaved at that moment, in which case the page asks before it lets go of it.
  await page.getByLabel('最大并发任务数').fill('3');
  await page.keyboard.press('Escape');
  await page.evaluate(
    () => void window.next.router.push('/zh/tasks/translate/').catch(() => {}),
  );
  const saveAndLeave = page.getByRole('button', {
    name: '保存并离开',
    exact: true,
  });
  await expect(async () => {
    if (await saveAndLeave.isVisible()) await saveAndLeave.click();
    await expect(page).not.toHaveURL(/project=/, { timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await expect
    .poll(async () => Number((await userConfig()).maxConcurrentTasks), {
      timeout: 10000,
    })
    .toBe(3);
  const remembered = await userConfig();
  assert.equal(Number(remembered.translateRetryTimes), 7);
  assert.equal(remembered.taskType, undefined, 'task type is per task');
  assert.equal(
    remembered.manuscriptPath,
    undefined,
    'manuscripts are per task',
  );
  assert.equal(
    await app.evaluate(() => globalThis.submissions.length),
    0,
    'no task was started',
  );

  // A brand new task starts from what the last one used.
  await page.getByRole('button', { name: '高级选项' }).click();
  await expect(page.getByLabel('翻译重试次数')).toHaveValue('7');
  await expect(page.getByLabel('最大并发任务数')).toHaveValue('3');
  // Evidence only: an occluded test window throttles the sheet's slide-in, so settle it.
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important}',
  });
  await page.screenshot({ path: path.join(evidence, 'new-task-advanced.png') });

  console.log(
    JSON.stringify({
      evidence,
      checks: [
        'an edit updates the defaults without starting the task',
        'leaving the page right after an edit keeps the edit',
        'per-task inputs are not remembered',
        'a new task inherits the advanced settings',
      ],
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(evidence, 'failure.png') })
    .catch(() => {});
  console.error('Task defaults evidence:', evidence);
  throw error;
} finally {
  await app?.close().catch(() => {});
}
