import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-batch-load-e2e-'),
);
const sourceA = path.join(output, 'A', 'source.en.srt');
const sourceB = path.join(output, 'B', 'source.en.srt');
const bytes = '1\n00:00:01,000 --> 00:00:03,000\nBatch load recovery.\n';
for (const file of [sourceA, sourceB]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(output, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const checks = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const navigate = (url) =>
  page.evaluate(async (url) => {
    await window.next.router.push(url);
  }, url);
const failure = () =>
  page.getByRole('alert').filter({ hasText: '校对项目加载失败' });
const loaded = (name) =>
  expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
const retry = () =>
  failure().getByRole('button', { name: '重新加载', exact: true }).click();
try {
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  assert.equal(
    await app.evaluate(({ ipcMain }) =>
      [
        'getSystemInfo',
        'selectFiles',
        'selectDirectory',
        'getProofreadTaskById',
        'subtitleMerge:getVideoInfo',
        'get-engine-status',
      ].every((channel) => ipcMain._invokeHandlers.has(channel)),
    ),
    true,
  );
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    globalThis.batchFaults = {};
    globalThis.batchHeld = {};
    globalThis.batchReleased = {};
    globalThis.batchSelection = [];
    globalThis.batchPickerCalls = 0;
    ipcMain.removeHandler('selectFiles');
    ipcMain.handle('selectFiles', () => {
      globalThis.batchPickerCalls++;
      return { canceled: false, filePaths: globalThis.batchSelection };
    });
    ipcMain.removeHandler('selectDirectory');
    ipcMain.handle('selectDirectory', () => ({
      canceled: false,
      directoryPath: globalThis.batchSelection[0],
    }));
    for (const channel of [
      'getProofreadTaskById',
      'scanDirectorySubtitles',
      'updateProofreadTask',
    ]) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const fault = globalThis.batchFaults[channel];
        if (!fault) return original(...args);
        if (fault.mode === 'fail')
          return { success: false, error: 'Injected batch read failure' };
        if (fault.mode === 'malformed')
          return {
            success: true,
            data: { id: 'wrong-project', name: 'Wrong', items: [] },
          };
        const result = await original(...args);
        globalThis.batchFaults[channel] = null;
        await new Promise((resolve) => {
          globalThis.batchHeld[channel] = resolve;
        });
        globalThis.batchReleased[channel] = true;
        return result;
      });
    }
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const ids = await page.evaluate(
    async ({ sourceA, sourceB }) => {
      const ids = [];
      for (const [name, file] of [
        ['Batch A', sourceA],
        ['Batch B', sourceB],
      ]) {
        const response = await window.ipc.invoke('createProofreadTask', {
          name,
          items: [
            {
              sourceSubtitlePath: file,
              sourceLanguage: 'en',
              status: 'in_progress',
            },
          ],
        });
        if (!response?.success) throw new Error(JSON.stringify(response));
        ids.push(response.data.id);
      }
      return ids;
    },
    { sourceA, sourceB },
  );
  const taskUrl = (id) => `/zh/proofread/?workItem=${id}`;
  const setFault = (channel, mode) =>
    app.evaluate(
      (_electron, { channel, mode }) => {
        globalThis.batchFaults[channel] = mode ? { mode } : null;
      },
      { channel, mode },
    );
  const release = (channel) =>
    app.evaluate((_electron, channel) => {
      const resolve = globalThis.batchHeld[channel];
      if (!resolve) throw new Error(`No held request: ${channel}`);
      delete globalThis.batchHeld[channel];
      resolve();
    }, channel);
  await navigate(taskUrl('missing-task'));
  await expect(failure()).toBeVisible();
  await failure().locator('summary').click();
  await expect(failure()).toContainText('此校对项目已不存在');
  await expect(
    page.getByRole('button', { name: '保存任务', exact: true }),
  ).toHaveCount(0);
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith('http:'))
          .setContentSize(...size),
      [width, height],
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({ path: path.join(output, `missing-${width}.png`) });
  }
  await page.getByRole('button', { name: '返回导入', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '导入字幕', exact: true }),
  ).toBeVisible();
  checks.push(
    'Missing task blocks editing, explains error and returns to clean import; both viewports fit',
  );

  await setFault('getProofreadTaskById', 'fail');
  await navigate(taskUrl(ids[0]));
  await expect(failure()).toBeVisible();
  await failure().locator('summary').click();
  await expect(failure()).toContainText('Injected batch read failure');
  await setFault('getProofreadTaskById', 'malformed');
  await retry();
  await expect(failure()).toContainText('INVALID_PROOFREAD_TASK_RESPONSE');
  await setFault('getProofreadTaskById', null);
  await retry();
  await loaded('Batch A');
  await expect(page.getByText('校对中', { exact: true })).toBeVisible();
  checks.push(
    'Explicit failure and wrong-identity success both stay blocked; retry restores the real task and in-progress status',
  );

  await navigate('/zh/proofread/');
  if (process.platform !== 'win32') {
    await fs.chmod(path.dirname(sourceA), 0);
    const scanFailures = await page.evaluate(
      async (directoryPath) =>
        Promise.all([
          window.ipc.invoke('scanDirectorySubtitles', {
            directoryPath,
            strict: true,
          }),
          window.ipc.invoke('smartScanDirectory', {
            directoryPath,
            strict: true,
          }),
          window.ipc.invoke('detectSubtitles', {
            videoPath: `${directoryPath}/source.mp4`,
            strict: true,
          }),
        ]),
      path.dirname(sourceA),
    );
    assert.ok(
      scanFailures.every(
        (result) => result.success === false && result.error.includes('EACCES'),
      ),
    );
    await navigate(taskUrl(ids[0]));
    await expect(failure()).toBeVisible();
    await failure().locator('summary').click();
    await expect(failure()).toContainText('EACCES');
    await fs.chmod(path.dirname(sourceA), 0o700);
    await retry();
    await loaded('Batch A');
    checks.push(
      'Real directory permission denial propagates through nested subtitle scan and recovers explicitly',
    );
  }

  await navigate('/zh/proofread/');
  await setFault('scanDirectorySubtitles', 'hold');
  await navigate(taskUrl(ids[0]));
  await expect
    .poll(() =>
      app.evaluate(() => !!globalThis.batchHeld.scanDirectorySubtitles),
    )
    .toBe(true);
  await expect(
    page.getByRole('status', { name: '正在加载校对项目' }),
  ).toBeVisible();
  await navigate(taskUrl(ids[1]));
  await loaded('Batch B');
  await release('scanDirectorySubtitles');
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.batchReleased.scanDirectorySubtitles),
    )
    .toBe(true);
  await loaded('Batch B');
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Batch load recovery.',
  );
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  checks.push(
    'Late child scan from A cannot replace B, and B remains editable',
  );

  await setFault('updateProofreadTask', 'hold');
  await page.getByRole('heading', { name: 'Batch B', exact: true }).click();
  await page.getByPlaceholder('输入任务名称').fill('Batch B saved');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => !!globalThis.batchHeld.updateProofreadTask))
    .toBe(true);
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/home\//);
  await navigate(taskUrl(ids[0]));
  await loaded('Batch A');
  await release('updateProofreadTask');
  await loaded('Batch A');
  const savedB = await page.evaluate(
    async (id) =>
      (await window.ipc.invoke('getProofreadTaskById', { id })).data,
    ids[1],
  );
  assert.equal(savedB.name, 'Batch B saved');
  checks.push(
    'Save accepted before navigation retains its disk result but late acknowledgement cannot mutate the new project',
  );

  const missing = path.join(output, 'missing.srt');
  await navigate(`/zh/proofread/?file=${encodeURIComponent(missing)}`);
  await expect(failure()).toBeVisible();
  await fs.writeFile(missing, bytes);
  await retry();
  await loaded('missing');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await navigate(
    `/zh/proofread/?workItem=${ids[0]}&file=${encodeURIComponent(missing)}`,
  );
  await expect(failure()).toBeVisible();
  await failure().locator('summary').click();
  await expect(failure()).toContainText('链接中的项目参数无效或相互冲突');
  checks.push(
    'Missing direct file link recovers after real file restoration; conflicting targets cannot race',
  );

  await page.getByRole('button', { name: '返回导入', exact: true }).click();
  const imported = path.join(output, 'import.fr.srt');
  const selected = (paths) =>
    app.evaluate((_electron, paths) => {
      globalThis.batchSelection = paths;
    }, paths);
  const pickerCalls = () => app.evaluate(() => globalThis.batchPickerCalls);
  const importFailure = () =>
    page.getByRole('alert').filter({ hasText: '所选文件读取失败' });
  await selected([imported]);
  await page.getByRole('button', { name: '导入字幕', exact: true }).click();
  await expect(importFailure()).toBeVisible();
  await importFailure().locator('summary').click();
  await expect(importFailure()).toContainText('File not found');
  assert.equal(await pickerCalls(), 1);
  await fs.writeFile(imported, bytes);
  await importFailure()
    .getByRole('button', { name: '重试读取文件', exact: true })
    .click();
  await loaded('import.fr');
  await expect(page.locator('tbody tr')).toContainText('无翻译');
  assert.equal(await pickerCalls(), 1);

  const appended = path.join(output, 'append.fr.srt');
  await selected([appended]);
  await page.getByRole('button', { name: '追加字幕', exact: true }).click();
  await expect(importFailure()).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await fs.writeFile(
    appended,
    bytes.replace('Batch load recovery.', 'Appended French source.'),
  );
  await importFailure()
    .getByRole('button', { name: '重试读取文件', exact: true })
    .click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  assert.equal(await pickerCalls(), 2);
  const appendedRow = page.locator('tbody tr').filter({ hasText: 'append.fr' });
  await expect(appendedRow).toContainText('无翻译');

  const replacement = path.join(output, 'replacement.en.srt');
  await selected([replacement]);
  await appendedRow.getByTitle('上传字幕').last().click();
  await expect(importFailure()).toBeVisible();
  await expect(appendedRow).toContainText('无翻译');
  await fs.writeFile(
    replacement,
    bytes.replace('Batch load recovery.', 'Replacement translation.'),
  );
  await importFailure()
    .getByRole('button', { name: '重试读取文件', exact: true })
    .click();
  await expect(appendedRow).toContainText('replacement.en.srt');
  assert.equal(await pickerCalls(), 3);
  const extraDirectory = path.join(output, 'append-many');
  await fs.mkdir(extraDirectory);
  const extras = ['take-two.de.srt', 'take-three.es.srt'].map((name) =>
    path.join(extraDirectory, name),
  );
  for (const extra of extras) await fs.writeFile(extra, bytes);
  await selected(extras);
  await page.getByRole('button', { name: '追加字幕', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  for (const extra of extras)
    await expect(page.locator('tbody')).toContainText(path.basename(extra));
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await appendedRow.getByRole('button', { name: '校对', exact: true }).click();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Appended French source.',
  );
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Replacement translation.',
  );
  await page.screenshot({
    path: path.join(output, 'import-retry-completed.png'),
  });
  checks.push(
    'Import, append and manual subtitle selection retain chosen paths across real missing-file recovery; no partial append or self-translation',
  );

  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await navigate('/zh/home/');
  await navigate('/zh/proofread/');
  const folder = path.join(output, 'standalone');
  const frenchOnly = path.join(folder, 'standalone.fr.srt');
  await fs.mkdir(folder);
  await fs.writeFile(frenchOnly, bytes);
  await selected([folder]);
  await page.getByRole('button', { name: '导入文件夹', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('standalone.fr.srt');
  await expect(page.locator('tbody tr')).toContainText('无翻译');
  await selected([frenchOnly]);
  await page.getByTitle('上传字幕').last().click();
  await expect(
    page.getByRole('alert').filter({ hasText: '原文和译文不能使用同一个文件' }),
  ).toBeVisible();
  await expect(page.locator('tbody tr')).toContainText('无翻译');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  checks.push(
    'A standalone French subtitle survives folder import; manual selection cannot alias source and translation',
  );
  for (const language of ['en', 'fr', 'ja'])
    await fs.writeFile(path.join(folder, `movie.${language}.srt`), bytes);
  await navigate('/zh/home/');
  await navigate('/zh/proofread/');
  await selected([folder]);
  await page.getByRole('button', { name: '导入文件夹', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  for (const name of [
    'standalone.fr.srt',
    'movie.en.srt',
    'movie.fr.srt',
    'movie.ja.srt',
  ])
    await expect(page.locator('tbody')).toContainText(name);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  checks.push(
    'Multi-select append retains every input; folder import keeps the third language as a separate item',
  );

  const sidecar = path.join(output, 'prior-proofread.json');
  const sidecarBytes = JSON.stringify({
    version: 2,
    cues: [
      {
        id: '1',
        startMs: 1000,
        endMs: 3000,
        source: 'Prior proofreading.',
        target: 'Prior translation.',
      },
    ],
    speakers: [],
  });
  await fs.writeFile(sidecar, sidecarBytes);
  const replacementTask = await page.evaluate(
    async ({ frenchOnly, sidecar }) => {
      const response = await window.ipc.invoke('createProofreadTask', {
        name: 'Replacement confirmation',
        items: [
          {
            sourceSubtitlePath: frenchOnly,
            proofreadDataFile: sidecar,
            status: 'completed',
          },
        ],
      });
      if (!response.success) throw new Error(JSON.stringify(response));
      return response.data.id;
    },
    { frenchOnly, sidecar },
  );
  await navigate(taskUrl(replacementTask));
  await loaded('Replacement confirmation');
  await selected([replacement]);
  await page.getByTitle('上传字幕').last().click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('替换已校对项目的字幕');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '查看', exact: true }).click();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Prior proofreading.',
  );
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByTitle('上传字幕').last().click();
  await expect(confirmation).toBeVisible();
  await page.screenshot({
    path: path.join(output, 'replace-confirmation.png'),
  });
  await confirmation
    .getByRole('button', { name: '替换字幕', exact: true })
    .click();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Batch load recovery.',
  );
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Replacement translation.',
  );
  assert.equal(await fs.readFile(sidecar, 'utf8'), sidecarBytes);
  checks.push(
    'Canceling subtitle replacement retains authoritative proofreading; explicit confirmation reloads new subtitles without changing the original record',
  );
  assert.equal(await fs.readFile(sourceA, 'utf8'), bytes);
  assert.equal(await fs.readFile(sourceB, 'utf8'), bytes);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error({ output, checks, errors });
  console.error((await page.locator('body').innerText()).slice(-4500));
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await fs.chmod(path.dirname(sourceA), 0o700).catch(() => {});
  await app.close();
}
