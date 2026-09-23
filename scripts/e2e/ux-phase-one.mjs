import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-ux-phase-one-'),
);
const profile = path.join(output, 'profile');
const subtitle = path.join(output, 'review.srt');
const video = path.join(output, 'sample.mp4');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:01,000\nHello SmartSub.\n\n2\n00:00:01,100 --> 00:00:02,000\nSecond line.\n',
);
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=blue:s=320x180:r=25:d=2',
  '-c:v',
  'libx264',
  video,
]);
let app;
let page;
let lockedDirectory;
const errors = [];
const checks = [];
const translationRequests = [];
const translator = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    translationRequests.push(body.text);
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({
          data: body.text.includes('Hello') ? '你好妙幕。' : '第二行。',
        }),
      );
  });
});
await new Promise((resolve) => translator.listen(0, '127.0.0.1', resolve));
async function launch() {
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
  page.on('pageerror', (error) => errors.push(String(error)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
}
async function route(url) {
  await page.evaluate((url) => window.next.router.push(url), url);
}
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const defaults = await page.evaluate(() =>
    window.ipc.invoke('getUserConfig'),
  );
  assert.equal(defaults.translateProvider, 'autoFree');
  assert.equal(defaults.translateContent, 'sourceAndTranslate');
  await route('/zh/tasks/generate-translate/');
  await expect(
    page.getByRole('button', { name: '字幕输出格式' }),
  ).toContainText('双语 · 原文在上');
  await expect(page.getByRole('combobox', { name: '翻译服务' })).toContainText(
    '自动免费翻译',
  );
  await page.screenshot({
    path: path.join(output, 'bilingual-default.png'),
    scale: 'css',
  });
  checks.push(
    'new bilingual tasks use visible bilingual output and configured free translation',
  );

  await route('/zh/translation/');
  await page.getByText('深度求索', { exact: true }).first().click();
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getUserConfig')))
      .translateProvider,
    'autoFree',
  );
  await expect(
    page.getByRole('button', { name: '设为新任务默认', exact: true }),
  ).toBeDisabled();
  await page.getByText('谷歌免费翻译', { exact: true }).first().click();
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getUserConfig')))
      .translateProvider,
    'autoFree',
  );
  await page
    .getByRole('button', { name: '设为新任务默认', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '当前新任务默认', exact: true }),
  ).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('getUserConfig')))
      .translateProvider,
    'googleFree',
  );
  await page.screenshot({
    path: path.join(output, 'explicit-provider-default.png'),
    scale: 'css',
  });
  checks.push(
    'browsing services leaves defaults unchanged; explicit default action persists',
  );

  const bilingual = await page.evaluate(
    async ({ video, subtitle, defaults, url }) => {
      const providers = await window.ipc.invoke('getTranslationProviders');
      window.ipc.send(
        'setTranslationProviders',
        providers.map((provider) =>
          provider.id === 'deeplx'
            ? { ...provider, apiUrl: url, requestInterval: 0 }
            : provider,
        ),
      );
      await window.ipc.invoke('getTranslationProviders');
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: [video],
        taskType: 'media',
      });
      files[0].providedSubtitlePath = subtitle;
      return window.ipc.invoke('submitTask', {
        projectId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        files,
        formData: {
          ...defaults,
          taskType: 'generateAndTranslate',
          translateProvider: 'deeplx',
        },
      });
    },
    {
      video,
      subtitle,
      defaults,
      url: `http://127.0.0.1:${translator.address().port}/translate`,
    },
  );
  assert.equal(bilingual.success, true, JSON.stringify(bilingual));
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (id) => window.ipc.invoke('getWorkItem', id),
            bilingual.projectId,
          )
        )?.status,
      { timeout: 30000 },
    )
    .toBe('done');
  const bilingualItem = await page.evaluate(
    (id) => window.ipc.invoke('getWorkItem', id),
    bilingual.projectId,
  );
  const bilingualText = await fs.readFile(
    bilingualItem.pipelineFiles[0].translatedSrtFile,
    'utf8',
  );
  assert.match(bilingualText, /Hello SmartSub\.\s+你好妙幕。/);
  assert.match(bilingualText, /Second line\.\s+第二行。/);
  assert.equal(translationRequests.length, 2);
  checks.push(
    'real bilingual SRT contains source and translation using paired subtitles and a local translation fixture',
  );

  await route(`/zh/proofread/?file=${encodeURIComponent(subtitle)}`);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page
    .getByRole('textbox', { name: '原文字幕 1', exact: true })
    .fill('Saved UX revision.');
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '字幕文件已保存' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /建议检查/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '字幕文件已保存' }),
  ).toBeVisible();
  if (process.platform !== 'win32') {
    for (const directory of [profile, `${profile}-dev`]) {
      const config = await fs
        .readFile(path.join(directory, 'config.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (config?.workItems?.some((item) => item.type === 'proofread'))
        lockedDirectory = directory;
    }
    assert.ok(
      lockedDirectory,
      'locate the real work-item store before injecting a write failure',
    );
    await fs.chmod(lockedDirectory, 0o500);
    await page.getByRole('button', { name: '完成并返回', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'EACCES' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '完成并返回', exact: true }),
    ).toBeEnabled();
    const tasks = await page.evaluate(
      async () => (await window.ipc.invoke('getProofreadTasks')).data,
    );
    assert.notEqual(tasks[0].items[0].status, 'completed');
    await page.screenshot({
      path: path.join(output, 'completion-save-failure.png'),
      scale: 'css',
    });
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    checks.push(
      'failed completion write retains the editor and uncompleted batch; retry succeeds',
    );
  }
  await page.getByRole('button', { name: '完成并返回', exact: true }).click();
  await page.getByRole('link', { name: '启动台', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  assert.match(await fs.readFile(subtitle, 'utf8'), /Saved UX revision/);
  checks.push(
    'subtitle save survives view changes; completing persists the batch before navigation',
  );

  await route('/zh/toolbox/?tool=subtitle-converter');
  const converted = await page.evaluate(
    (filePath) =>
      window.ipc.invoke('toolbox:convertSubtitleFile', {
        filePath,
        targetFormat: 'vtt',
      }),
    subtitle,
  );
  assert.equal(converted.success, true, JSON.stringify(converted));
  const compressed = await page.evaluate(
    (videoPath) =>
      window.ipc.invoke('toolbox:compressVideo', {
        config: { videoPath, preset: 'wechat_25mb' },
        jobId: 'ux-small',
      }),
    video,
  );
  assert.equal(compressed.skipped, true, JSON.stringify(compressed));
  assert.equal(compressed.outputPath, video);
  const composed = await page.evaluate(
    (config) => window.ipc.invoke('subtitleMerge:startMerge', config),
    {
      videoPath: video,
      subtitlePath: subtitle,
      outputMode: 'softmux',
      outputPath: path.join(output, 'composed.mp4'),
      requestId: 'ux-compose',
    },
  );
  assert.equal(composed.success, true, JSON.stringify(composed));
  let items = await page.evaluate(() => window.ipc.invoke('getWorkItems'));
  const composeItem = items.find((item) => item.type === 'compose');
  assert.equal(composeItem.status, 'done');
  assert.equal(composeItem.artifacts[0].path, composed.data);
  assert.equal(items.filter((item) => item.type === 'toolbox').length, 2);
  await route(`/zh/processing-result/?workItem=${composeItem.id}`);
  await expect(page.getByText(composed.data, { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.join(output, 'compose-history.png'),
    scale: 'css',
  });
  checks.push(
    'real conversion, skipped small compression and composition persist input/output records',
  );
  await app.close();
  await launch();
  items = await page.evaluate(() => window.ipc.invoke('getWorkItems'));
  assert.equal(items.find((item) => item.id === composeItem.id).status, 'done');
  await route('/zh/recent-tasks/');
  const historyButton = page
    .getByRole('button', { name: composeItem.name, exact: true })
    .first();
  await historyButton.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/processing-result/);
  await expect(page.getByText(composed.data, { exact: true })).toBeVisible();
  await fs.unlink(composed.data);
  await page
    .getByRole('button', { name: '打开所在文件夹', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文件已移动或删除' }),
  ).toBeVisible();
  checks.push(
    'completed composition and toolbox history survive an Electron restart',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  console.error({ output });
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(-4500),
    );
  }
  throw error;
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  await app?.close().catch(() => {});
  translator.closeAllConnections();
  await new Promise((resolve) => translator.close(resolve));
}
