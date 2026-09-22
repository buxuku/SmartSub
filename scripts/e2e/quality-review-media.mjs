import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';
const require = createRequire(import.meta.url);
const audioOnly = process.argv.includes('--audio');
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-quality-media-'),
);
const source = path.join(output, 'speech.en.srt'),
  media = path.join(output, audioOnly ? 'speech.m4a' : 'speech.mp4'),
  sidecar = path.join(output, 'speech.json');
const ffmpeg = spawnSync(
  require('ffmpeg-static'),
  audioOnly
    ? [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=300:duration=12',
        '-c:a',
        'aac',
        media,
      ]
    : [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=640x360:d=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=300:duration=12',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        media,
      ],
  { stdio: 'ignore' },
);
assert.equal(ffmpeg.status, 0);
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:03,000\nOriginal words.\n',
);
await fs.writeFile(
  sidecar,
  JSON.stringify({
    version: 2,
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceFile: source,
      sourceLanguage: 'en',
    },
    speakers: [],
    cues: [
      {
        id: '1',
        startMs: 1000,
        endMs: 3000,
        source: 'Original words.',
        target: '',
      },
    ],
    missedSpeechWarnings: [
      {
        id: 'w1',
        startMs: 1000,
        endMs: 3000,
        level: 'high',
        signals: ['speechReview', 'textMismatch'],
        cueIds: ['1'],
        originalText: 'Original words.',
        suggestedText: 'Correct words.',
      },
      {
        id: 'w2',
        startMs: 6000,
        endMs: 8000,
        level: 'high',
        signals: ['speechReview'],
        cueIds: [],
        suggestedText: 'Missing words.',
      },
    ],
  }),
);
let app, page;
const errors = [];
try {
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await waitForAppPage(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, media, sidecar }) => {
      localStorage.setItem('proofread:videoCollapsed', '1');
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Speech review',
        items: [
          {
            sourceSubtitlePath: source,
            proofreadDataFile: sidecar,
            videoPath: media,
            sourceLanguage: 'en',
          },
        ],
      });
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, media, sidecar },
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByRole('tab', { name: /建议检查/ }).click();
  await expect(page.locator('[data-quality-detail]')).toContainText(
    '文字可能不匹配',
  );
  const list = page.getByLabel('问题列表', { exact: true });
  if (!(await list.isVisible()))
    await page.getByRole('button', { name: /问题列表/ }).click();
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.locator('[data-quality-panel] [aria-current=true]'),
  ).toContainText('00:00:06');
  await list.focus();
  await page.keyboard.press('ArrowUp');
  if (
    !(await page
      .getByRole('button', { name: '试听片段', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: '返回当前问题', exact: true })
      .click();
  await page.getByRole('button', { name: '试听片段', exact: true }).click();
  const player = page.locator(audioOnly ? 'audio[controls]' : 'video');
  await expect
    .poll(() => player.evaluate((v) => v.currentTime))
    .toBeGreaterThan(1);
  await expect
    .poll(() => player.evaluate((v) => v.paused), {
      timeout: 8000,
    })
    .toBe(true);
  const time = await player.evaluate((v) => v.currentTime);
  assert.ok(time >= 4 && time < 4.5, `range end ${time}`);
  await page.getByLabel('循环', { exact: true }).check();
  await page.getByRole('button', { name: '试听片段', exact: true }).click();
  await expect
    .poll(() => player.evaluate((v) => v.currentTime))
    .toBeGreaterThan(3);
  await expect
    .poll(() => player.evaluate((v) => v.currentTime))
    .toBeLessThan(1);
  await page.getByLabel('循环', { exact: true }).uncheck();
  await expect
    .poll(() => player.evaluate((v) => v.paused), { timeout: 8000 })
    .toBe(true);
  await page.getByRole('button', { name: '查看复核建议', exact: true }).click();
  await expect(page.locator('[data-ai-review]')).toContainText(
    'Correct words.',
  );
  await page.locator('[data-ai-review]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#subtitle-src-0')).toHaveValue('Correct words.');
  await expect(
    page
      .locator('[data-quality-panel]')
      .getByText('正在检查…', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '标记已修复', exact: true }).click();
  await expect(page.locator('[data-quality-detail]')).toContainText('已修复');
  await page.getByRole('button', { name: '下一处', exact: true }).click();
  await page.getByRole('button', { name: '补一句字幕', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '补充原文', exact: true }),
  ).toHaveValue('Missing words.');
  await page
    .getByRole('textbox', { name: '补充原文', exact: true })
    .fill('Missing words, edited.');
  await page.getByRole('tab', { name: '全部字幕', exact: true }).click();
  await page.getByRole('tab', { name: /建议检查/ }).click();
  await expect(
    page.getByRole('textbox', { name: '补充原文', exact: true }),
  ).toHaveValue('Missing words, edited.');
  await page.getByRole('button', { name: '插入字幕', exact: true }).click();
  await expect(page.locator('#subtitle-src-1')).toHaveValue(
    'Missing words, edited.',
  );
  await expect(
    page
      .locator('[data-quality-panel]')
      .getByText('正在检查…', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-quality-detail]')).toContainText('已修复');
  await expect(
    page
      .locator('[data-quality-detail]')
      .getByRole('button', { name: '标记已修复', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-quality-detail]')
      .getByRole('button', { name: '恢复待检查', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(page.getByText('已保存', { exact: true }).first()).toBeVisible();
  assert.match(await fs.readFile(source, 'utf8'), /Missing words/);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, 'video-1024-dark.png') });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.screenshot({ path: path.join(output, 'video-1024-light.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    JSON.stringify({
      output,
      audioOnly,
      checks: [
        'real ffmpeg video',
        'clip playback and stop',
        'speech diff acceptance',
        'gap insertion',
        'save sidecar and SRT',
        '1024 themes',
      ],
      time,
      errors,
    }),
  );
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    await fs.writeFile(
      path.join(output, 'failure.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  console.error(output);
  throw error;
} finally {
  await app?.close();
}
