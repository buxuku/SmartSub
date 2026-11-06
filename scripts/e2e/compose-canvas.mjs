import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-canvas-e2e-'),
);
const media = path.join(output, 'canvas.mp4');
const subtitle = path.join(output, 'canvas.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=25:d=3',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  media,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:03,000\nSmartSub Canvas 123\n',
);
let app, page;
const checks = [];
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: process.argv.includes('--production')
        ? 'production'
        : 'development',
    },
  });
  page = await app.firstWindow();
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(20000);
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    ({ media, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { media, subtitle },
  );
  const canvas = page.locator('[data-video-canvas]');
  const drag = page.locator('[data-subtitle-drag]');
  await expect(drag).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await canvas.hover();
  await expect(drag).toBeVisible();
  const bounds = await canvas.boundingBox();
  const box = await drag.boundingBox();
  const distance = bounds.height * 0.25;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + box.height / 2 - distance,
    { steps: 16 },
  );
  await page.mouse.up();
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const yInput = page.getByRole('spinbutton', {
    name: '垂直位置 (%)',
    exact: true,
  });
  await expect
    .poll(async () => Number(await yInput.inputValue()))
    .toBeCloseTo(68.056, 1);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview.renderer.getEvents()),
      ),
    )
    .toContain('196');
  await yInput.fill('50');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview.renderer.getEvents()),
      ),
    )
    .toContain('144');
  await drag.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => Number(await yInput.inputValue()))
    .toBeCloseTo(50 - 100 / bounds.height, 2);
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(async () => Number(await yInput.inputValue()))
    .toBeCloseTo(50 + 900 / bounds.height, 2);
  await yInput.fill('50');
  const beforeCancel = await drag.boundingBox();
  await page.mouse.move(
    beforeCancel.x + beforeCancel.width / 2,
    beforeCancel.y + beforeCancel.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    beforeCancel.x + beforeCancel.width / 2,
    beforeCancel.y - 30,
    { steps: 8 },
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(yInput).toHaveValue('50');
  // Real file failure, not a mocked IPC result: no sample or stale rendered track.
  await fs.rename(subtitle, `${subtitle}.backup`);
  await yInput.fill('51');
  await expect(page.locator('[data-preview-error]')).toBeVisible();
  await expect(drag).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(false);
  await page.screenshot({ path: path.join(output, 'preview-error.png') });
  await fs.rename(`${subtitle}.backup`, subtitle);
  await page.getByRole('button', { name: '重试预览', exact: true }).click();
  await expect(page.locator('[data-preview-error]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await yInput.fill('50');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview.renderer.getEvents()),
      ),
    )
    .toContain('144');
  checks.push(
    'real pointer drag, arrow/Shift nudge, Esc cancellation, file ENOENT banner and retry, JASSUB track recovery',
  );
  const safeArea = page.getByRole('combobox', {
    name: '安全区参考',
    exact: true,
  });
  await safeArea.click();
  await page
    .getByRole('option', { name: '影视 80% / 90%', exact: true })
    .click();
  await expect(page.locator('[data-safe-area="80"]')).toBeVisible();
  await expect(page.locator('[data-safe-area="90"]')).toBeVisible();
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((window) => /^(app:|http:)/.test(window.webContents.getURL()))
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
    await canvas.hover();
    await page.screenshot({ path: path.join(output, `canvas-${width}.png`) });
  }
  await safeArea.click();
  await page
    .getByRole('option', { name: '抖音 / TikTok', exact: true })
    .click();
  await expect(page.locator('[data-safe-area="actions"]')).toBeVisible();
  await expect(page.locator('[data-safe-area="caption"]')).toBeVisible();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const hard = path.join(output, 'canvas_subtitled.mp4');
  const pixels = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    hard,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
  const rows = Array.from(pixels.entries())
    .filter(([, value]) => value > 210)
    .map(([i]) => Math.floor(i / 640));
  assert.ok(rows.length > 100);
  assert.ok(
    Math.max(...rows) < 190 && Math.min(...rows) > 120,
    'burned subtitle is at dragged/numeric midpoint, not original bottom',
  );
  checks.push(
    'broadcast/short-video masks, 1024/1440 layout, actual FFmpeg hard export pixel position',
  );
  await page.getByRole('button', { name: '封装软字幕', exact: true }).click();
  await expect(drag).toHaveCount(0);
  await expect(yInput).toBeDisabled();
  await expect(
    page.getByRole('status').filter({ hasText: '软字幕效果' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const soft = path.join(output, 'canvas_subtitled.mkv');
  const softPixels = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    soft,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
  assert.equal(
    softPixels.some((pixel) => pixel > 40),
    false,
    'soft export leaves video unburned',
  );
  const track = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    soft,
    '-map',
    '0:s:0',
    '-f',
    'srt',
    'pipe:1',
  ]).toString();
  assert.match(track, /SmartSub Canvas 123/);
  checks.push(
    'soft mode disables styling/drag, real subtitle track present, video pixels remain unchanged',
  );
  await page.getByRole('combobox', { name: '软字幕容器', exact: true }).click();
  await page.getByRole('option', { name: 'MP4', exact: true }).click();
  const softMp4 = path.join(output, 'canvas-soft.mp4');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, softMp4);
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const packetHash = (file) =>
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-f',
      'hash',
      '-hash',
      'sha256',
      'pipe:1',
    ])
      .toString()
      .trim();
  assert.equal(
    packetHash(softMp4),
    packetHash(media),
    'MP4 video packets are bit-identical to input',
  );
  const mp4Track = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    softMp4,
    '-map',
    '0:s:0',
    '-f',
    'srt',
    'pipe:1',
  ]).toString();
  assert.match(mp4Track, /00:00:00,000 --> 00:00:03,000/);
  assert.match(mp4Track, /SmartSub Canvas 123/);
  checks.push(
    'MP4 mov_text soft export: exact video packet SHA-256, independently extractable subtitle text and timing',
  );
  const portrait = path.join(output, 'portrait.mp4');
  const ass = path.join(output, 'portrait.ass');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=black:s=360x640:r=25:d=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    portrait,
  ]);
  await fs.writeFile(
    ass,
    `[Script Info]
ScriptType: v4.00+
PlayResX: 360
PlayResY: 640
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\pos(90,480)\\fs36}ASS
`,
  );
  await page.getByRole('button', { name: '烧录硬字幕', exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, portrait);
  await page.getByTitle(media, { exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, ass);
  await page.getByTitle(subtitle, { exact: true }).click();
  await page.getByRole('button', { name: '恢复对齐位置', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview?.renderer.getEvents()),
      ),
    )
    .toContain('pos(90,480)');
  await expect
    .poll(async () => {
      const box = await canvas.boundingBox();
      return box.width / box.height;
    })
    .toBeCloseTo(360 / 640, 2);
  const portraitBounds = await canvas.boundingBox();
  await expect
    .poll(async () => {
      const box = await drag.boundingBox();
      return (box.x + box.width / 2 - portraitBounds.x) / portraitBounds.width;
    })
    .toBeCloseTo(0.25, 1);
  const assBox = await drag.boundingBox();
  await page.mouse.move(
    assBox.x + assBox.width / 2,
    assBox.y + assBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    assBox.x + assBox.width / 2,
    assBox.y + assBox.height / 2 - portraitBounds.height * 0.2,
    { steps: 16 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await yInput.inputValue()))
    .toBeCloseTo(55, 1);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview.renderer.getEvents()),
      ),
    )
    .toContain('pos(90,352)');
  await page.screenshot({ path: path.join(output, 'portrait-ass.png') });
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const portraitPixels = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path.join(output, 'portrait_subtitled.mp4'),
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
  const portraitPoints = Array.from(portraitPixels.entries())
    .filter(([, value]) => value > 210)
    .map(([i]) => ({ x: i % 360, y: Math.floor(i / 360) }));
  assert.ok(portraitPoints.length > 100);
  assert.ok(
    Math.abs(
      (Math.min(...portraitPoints.map((p) => p.x)) +
        Math.max(...portraitPoints.map((p) => p.x))) /
        2 -
        90,
    ) < 5,
  );
  assert.ok(
    Math.max(...portraitPoints.map((p) => p.y)) < 355 &&
      Math.min(...portraitPoints.map((p) => p.y)) > 310,
  );
  checks.push(
    'portrait ASS native positioned glyph bounds, no initial Y jump, X preserved, real burned pixels',
  );
  await page.locator('video').evaluate((video) => video.play());
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.currentTime))
    .toBeGreaterThan(0.3);
  await page.locator('video').evaluate((video) => video.pause());
  const broken = path.join(output, 'broken.mp4');
  await fs.writeFile(broken, 'invalid video');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, broken);
  await page.getByTitle(portrait, { exact: true }).click();
  await expect(page.locator('[data-preview-error]')).toContainText(
    '视频无法播放',
  );
  await fs.copyFile(portrait, broken);
  await page.getByRole('button', { name: '重试预览', exact: true }).click();
  await expect(page.locator('[data-preview-error]')).toHaveCount(0);
  await page.locator('video').evaluate((video) => video.play());
  await expect
    .poll(async () => {
      const box = await canvas.boundingBox();
      return box.width / box.height;
    })
    .toBeCloseTo(360 / 640, 2);
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.currentTime))
    .toBeGreaterThan(0.3);
  await page.locator('video').evaluate((video) => video.pause());
  checks.push(
    'actual video playback advances; corrupted media has persistent error and recovers after file repair/retry',
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error(JSON.stringify({ output, checks }));
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-5000));
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
}
