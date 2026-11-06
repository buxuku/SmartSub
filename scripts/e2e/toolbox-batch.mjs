import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-toolbox-e2e-'),
);
const fixture =
  process.env.SMARTSUB_E2E_VIDEO ||
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4';
const first = path.join(evidence, 'first.mp4');
const second = path.join(evidence, 'second.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  fixture,
  '-t',
  '2',
  '-vf',
  'scale=320:-2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  first,
]);
await fs.copyFile(first, second);
const subtitle =
  '1\n00:00:00,000 --> 00:00:01,000\nFirst line\nTranslated line\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond line\nTranslated second line\n';
const firstSub = path.join(evidence, 'first.srt');
const secondSub = path.join(evidence, 'second.srt');
await fs.writeFile(firstSub, subtitle);
await fs.writeFile(secondSub, subtitle);
const embedded = [
  path.join(evidence, 'first.mkv'),
  path.join(evidence, 'second.mkv'),
];
for (const file of embedded)
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    first,
    '-i',
    firstSub,
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    file,
  ]);

const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(evidence, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
page.on('dialog', (dialog) => {
  if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
});
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.closeDevTools();
});
const origin = new URL(page.url()).origin;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];

async function pick(paths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (paths.length > 1 && !options.properties.includes('multiSelections'))
        throw new Error('Batch picker does not enable multiSelections');
      return { canceled: false, filePaths: paths };
    };
  }, paths);
}

async function openTool(id) {
  await page.goto(`${origin}/zh/toolbox/?tool=${id}`);
  const onboarding = page.getByRole('button', { name: '跳过', exact: true });
  await expect(
    onboarding
      .or(page.getByRole('button', { name: '返回工具箱', exact: true }))
      .first(),
  ).toBeVisible();
  if (await onboarding.isVisible()) await onboarding.click();
  await expect(
    page.getByRole('button', { name: '返回工具箱', exact: true }),
  ).toBeVisible();
}

async function dropFiles(target, files) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box);
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await cdp.send('Input.dispatchDragEvent', {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data,
      });
  } finally {
    await cdp.detach();
  }
}

async function bounds(id) {
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height]) =>
        BrowserWindow.getAllWindows()
          .find(
            (window) => !window.webContents.getURL().startsWith('devtools:'),
          )
          .setSize(width, height),
      [width, height],
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({ path: path.join(evidence, `${id}-${width}.png`) });
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
      `${id}: page horizontal overflow`,
    );
    const finish = page.getByRole('button', {
      name: '打开文件夹',
      exact: true,
    });
    if (await finish.count()) {
      await finish.scrollIntoViewIfNeeded();
      await finish.click({ trial: true });
    }
  }
}

async function runTool(id, files, startName, setup) {
  await openTool(id);
  if (setup) await setup();
  await pick(files.slice(0, 1));
  if (id === 'video-to-gif')
    await page
      .getByText('点击或拖拽视频到此处截取动图', { exact: true })
      .click();
  else if (id === 'video-trimmer')
    await page
      .getByText('点击或拖拽视频文件', { exact: false })
      .first()
      .click();
  else await page.locator('.border-dashed').first().click();
  const dropTarget =
    id === 'video-to-gif' || id === 'video-trimmer'
      ? page.getByTestId('toolbox-queue').locator('..')
      : page.locator('.border-dashed').first();
  await dropFiles(dropTarget, files.slice(1));
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status]'),
  ).toHaveCount(files.length);
  const output = path.join(evidence, id);
  await fs.mkdir(output);
  await pick([output]);
  await page.getByRole('button', { name: '更改目录', exact: true }).click();
  await page.getByRole('button', { name: startName, exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(files.length, { timeout: 60000 });
  assert.equal(
    await page
      .getByTestId('toolbox-queue')
      .locator('[data-status="error"]')
      .count(),
    0,
  );
  const outputs = await fs.readdir(output);
  if (id === 'video-compressor') {
    assert.deepEqual(
      outputs,
      [],
      'small compatible videos keep their original files',
    );
    await expect(
      page.getByText('已满足体积上限，无需压缩，保留原文件', { exact: true }),
    ).toHaveCount(files.length);
    for (const file of files) assert.ok((await fs.stat(file)).size > 0);
  } else {
    assert.ok(outputs.length >= files.length, `${id}: missing output files`);
  }
  for (const file of outputs)
    assert.ok((await fs.stat(path.join(output, file))).size > 0);
  await bounds(id);
  checks.push({ id, inputs: files.length, outputs });
}

try {
  await runTool('subtitle-converter', [firstSub, secondSub], '开始批量转换');
  await runTool('subtitle-sync', [firstSub, secondSub], '应用校准并导出');
  await runTool('audio-extractor', [first, second], '开始提取音频');
  await runTool('video-compressor', [first, second], '开始批量压缩');
  await runTool('video-to-gif', [first, second], '生成高清 GIF');
  await runTool('video-trimmer', [first, second], '导出裁剪片段');
  await runTool('embedded-subtitles', embedded, '批量导出字幕');
  const partialVideo = path.join(evidence, 'partial.mkv');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    first,
    '-i',
    firstSub,
    '-map',
    '0',
    '-map',
    '1:s',
    '-map',
    '1:s',
    '-c',
    'copy',
    partialVideo,
  ]);
  const partialOutput = path.join(evidence, 'partial-output');
  await fs.mkdir(partialOutput);
  await openTool('embedded-subtitles');
  await pick([partialVideo]);
  await page.locator('.border-dashed').first().click();
  await expect(
    page.getByText('发现字幕轨: 2 条', { exact: true }),
  ).toBeVisible();
  await pick([partialOutput]);
  await page.getByRole('button', { name: '更改目录', exact: true }).click();
  await app.evaluate(({ app }, output) => {
    const fs = process.getBuiltinModule('fs');
    const open = fs.openSync;
    fs.openSync = function (file, ...args) {
      if (String(file) === `${output}/partial_track2.srt`) {
        fs.openSync = open;
        fs.chmodSync(output, 0o500);
      }
      return open(file, ...args);
    };
  }, partialOutput);
  try {
    await page
      .getByRole('button', { name: '批量导出字幕', exact: true })
      .click();
    await expect(
      page.getByTestId('toolbox-queue').locator('[data-status="error"]'),
    ).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: '合成到视频', exact: true }),
    ).toBeVisible();
    assert.deepEqual(await fs.readdir(partialOutput), ['partial_track1.srt']);
    assert.match(
      await fs.readFile(path.join(partialOutput, 'partial_track1.srt'), 'utf8'),
      /First line/,
    );
    await page.screenshot({
      path: path.join(evidence, 'embedded-partial-failure.png'),
    });
  } finally {
    await fs.chmod(partialOutput, 0o700);
  }
  await page.getByRole('button', { name: '重试此文件', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(1);
  assert.deepEqual((await fs.readdir(partialOutput)).sort(), [
    'partial_track1.srt',
    'partial_track2.srt',
  ]);
  await page.getByRole('button', { name: '合成到视频', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  checks.push({
    id: 'embedded-partial',
    checks: [
      'real permission failure after first track',
      'partial outputs stay available',
      'retry only missing tracks',
      'all outputs retained in finish bar',
    ],
  });
  await runTool(
    'bilingual-subtitles',
    [firstSub, secondSub],
    '拆分为两份单语',
    async () =>
      page.getByRole('tab', { name: '一份双语字幕拆分为单语' }).click(),
  );

  await openTool('bilingual-subtitles');
  await pick([firstSub, secondSub]);
  await page.locator('.border-dashed').nth(0).click();
  await page.locator('.border-dashed').nth(1).click();
  const pairSelectors = page.getByRole('combobox', {
    name: '选择配对的次字幕',
  });
  await expect(pairSelectors).toHaveCount(2);
  for (const [index, name] of ['first.srt', 'second.srt'].entries()) {
    await pairSelectors.nth(index).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  await page
    .getByRole('button', { name: '合并为双语字幕', exact: true })
    .click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(2);
  for (const file of ['first_bilingual.srt', 'second_bilingual.srt'])
    assert.match(
      await fs.readFile(path.join(evidence, file), 'utf8'),
      /Translated/,
    );
  checks.push({
    id: 'bilingual-merge',
    checks: ['explicit two-pair selection', 'two real outputs'],
  });

  await openTool('video-trimmer');
  await pick([first, second]);
  await page.getByText('点击或拖拽视频文件到此处', { exact: true }).click();
  const rangeInputs = page.locator('input[type="number"]');
  await expect(rangeInputs.nth(1)).toHaveValue('2');
  await rangeInputs.nth(1).fill('1.5');
  await page
    .getByTestId('toolbox-queue')
    .getByRole('button', { name: 'second.mp4', exact: true })
    .click();
  await expect(rangeInputs.nth(1)).toHaveValue('2');
  await rangeInputs.nth(0).fill('0.5');
  await page
    .getByTestId('toolbox-queue')
    .getByRole('button', { name: 'first.mp4', exact: true })
    .click();
  await expect(rangeInputs.nth(0)).toHaveValue('0');
  await expect(rangeInputs.nth(1)).toHaveValue('1.5');
  await page.getByRole('button', { name: '导出裁剪片段', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(2);
  checks.push({
    id: 'video-ranges',
    checks: [
      'independent per-file ranges',
      'range persistence across preview switching',
    ],
  });

  await openTool('video-to-gif');
  await pick([first, second]);
  await page.getByText('点击或拖拽视频到此处截取动图', { exact: true }).click();
  await page.getByRole('button', { name: '生成高清 GIF', exact: true }).click();
  await page.getByRole('button', { name: '停止队列', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="running"]'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="pending"]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: '生成高清 GIF', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(2);
  checks.push({
    id: 'cancel',
    checks: [
      'stop active GIF',
      'do not launch next file',
      'resume without overlap',
    ],
  });

  await openTool('subtitle-sync');
  const broken = path.join(evidence, 'retry.srt');
  await fs.writeFile(broken, 'Not valid subtitles');
  await pick([firstSub, broken]);
  await page.locator('.border-dashed').first().click();
  await page
    .getByRole('button', { name: '应用校准并导出', exact: true })
    .click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(1);
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="error"]'),
  ).toHaveCount(1);
  await expect(
    page.getByTestId('toolbox-queue').getByRole('alert'),
  ).toBeVisible();
  await page.getByRole('button', { name: '返回工具箱', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toContainText(
    '离开将清空当前待处理列表',
  );
  await expect(
    page.getByRole('button', { name: '保存并离开', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await fs.writeFile(broken, subtitle);
  await page.getByRole('button', { name: '重试此文件', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(2);
  checks.push({
    id: 'retry',
    checks: ['persistent error', 'query-route guard', 'independent retry'],
  });
  await page.getByRole('button', { name: '合成到视频', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '去校对字幕', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '校对', exact: true }),
  ).toHaveCount(2);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  checks.push({
    id: 'subtitle-handoff',
    checks: [
      'all subtitle outputs reach proofread batch',
      'burn-in output menu lists every output',
    ],
  });
  await openTool('audio-extractor');
  await pick([first, second]);
  await page.locator('.border-dashed').first().click();
  await page.getByRole('button', { name: '开始提取音频', exact: true }).click();
  await expect(
    page.getByTestId('toolbox-queue').locator('[data-status="done"]'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: '去做双语字幕', exact: true }).click();
  await expect(page).toHaveURL(/tasks\/new\/?\?goals=translate/);
  await expect(
    page.getByText('first.mp3', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('second.mp3', { exact: true }).first(),
  ).toBeVisible();
  checks.push({
    id: 'handoff',
    checks: ['all outputs reach wizard', 'translation enabled in route'],
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, evidence, checks }));
} catch (error) {
  await page
    .screenshot({ path: path.join(evidence, 'failure.png') })
    .catch(() => {});
  console.error('Toolbox E2E evidence:', evidence, '\nPage errors:', errors);
  throw error;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await app.close();
}
