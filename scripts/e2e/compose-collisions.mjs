import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-collisions-e2e-'),
);
const video = path.join(output, 'source.mp4');
const subtitle = path.join(output, 'centered.ass');
const exported = path.join(output, 'burned.mp4');
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
run([
  '-f',
  'lavfi',
  '-i',
  'color=0x204060:s=640x360:r=25:d=3',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=3',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  video,
]);
const style = {
  fontName: 'Arial',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 0,
  shadow: 0,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};
let app, page;
const checks = [];
const errors = [];
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }, exported) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: exported,
    });
    dialog.showMessageBoxSync = () => 0;
  }, exported);
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const preview = await page.evaluate(
    (style) =>
      window.ipc.invoke('subtitleMerge:buildPreviewAss', {
        sampleText: 'fixture',
        style,
      }),
    style,
  );
  assert.equal(preview.success, true);
  const fixture =
    preview.data.slice(0, preview.data.indexOf('Dialogue:')) +
    [
      'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\an5\\1c&H00FFFF&}FIRST YELLOW',
      'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\an5\\bord0\\shad0\\1a&H80&}SECOND TRANSLUCENT',
      'Dialogue: 2,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\an7\\pos(20,30)\\1c&H00FF00&\\p1}m 0 0 l 40 0 40 20 0 20',
    ].join('\n');
  await fs.writeFile(subtitle, fixture);
  await page.evaluate(
    ({ video, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(video)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { video, subtitle },
  );
  await page
    .getByRole('button', { name: '经典白字黑边', exact: false })
    .click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  const capture = async () =>
    page.evaluate(async () => {
      const video = document.querySelector('video');
      video.pause();
      if (video.currentTime !== 1.2)
        await new Promise((resolve) => {
          video.addEventListener('seeked', resolve, { once: true });
          video.currentTime = 1.2;
        });
      await window.__jassubPreview.manualRender(
        {
          mediaTime: 1.2,
          width: video.videoWidth,
          height: video.videoHeight,
          expectedDisplayTime: performance.now(),
        },
        true,
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const layer = document.querySelector('canvas.JASSUB');
      const rect = layer.getBoundingClientRect(),
        frame = video.getBoundingClientRect();
      const offset = (rect.top - frame.top) / frame.height;
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 640, 360);
      ctx.drawImage(layer, 0, offset * 360, 640, 360);
      const pixels = Array.from(ctx.getImageData(0, 0, 640, 360).data);
      ctx.clearRect(0, 0, 640, 360);
      ctx.drawImage(layer, 0, offset * 360, 640, 360);
      return {
        pixels,
        alpha: Array.from(ctx.getImageData(0, 0, 640, 360).data).filter(
          (_, i) => i % 4 === 3,
        ),
        offset,
        png: canvas.toDataURL().split(',')[1],
        events: await window.__jassubPreview.renderer.getEvents(),
      };
    });
  const before = await capture();
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const drag = page.locator('[data-subtitle-drag]');
  await expect(drag).toBeVisible();
  const box = await drag.boundingBox(),
    frame = await page.locator('[data-subtitle-canvas]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + box.height / 2 + frame.height * 0.1,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .locator('canvas.JASSUB')
        .evaluate((canvas) => canvas.style.transform),
    )
    .toMatch(/^translateY\(/);
  const moved = await capture();
  assert.ok(Math.abs(moved.offset - 0.1) < 0.002);
  assert.deepEqual(
    moved.events.map((event) => event.Text),
    before.events.map((event) => event.Text),
    'collision layout keeps implicit events and native positions',
  );
  const rows = (alpha) =>
    Array.from({ length: 360 }, (_, y) =>
      alpha.slice(y * 640, (y + 1) * 640).some((value) => value > 80),
    );
  const originalRows = rows(before.alpha),
    movedRows = rows(moved.alpha);
  const dy = Math.round(moved.offset * 360);
  assert.deepEqual(
    originalRows.slice(0, 360 - dy),
    movedRows.slice(dy),
    'all stacked rows translate without collapse',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('canvas.JASSUB')).toHaveCSS('transform', 'none');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('canvas.JASSUB')
        .evaluate((canvas) => canvas.style.transform),
    )
    .toMatch(/^translateY\(/);
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(drag).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, `window-${width}.png`) });
  }
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const actualPreview = await capture();
  await fs.writeFile(
    path.join(output, 'layer-preview.png'),
    Buffer.from(actualPreview.png, 'base64'),
  );
  const burned = run([
    '-ss',
    '1.2',
    '-i',
    exported,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  const mask = (pixels, stride) =>
    Array.from(
      { length: 640 * 360 },
      (_, i) => Math.max(...pixels.slice(i * stride, i * stride + 3)) > 120,
    );
  const masks = [mask(actualPreview.pixels, 4), mask(burned, 3)];
  const coverage = masks.map((values, side) => {
    let total = 0,
      covered = 0;
    values.forEach((visible, index) => {
      if (!visible) return;
      total++;
      const x = index % 640,
        y = Math.floor(index / 640);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (
            x + dx >= 0 &&
            x + dx < 640 &&
            y + dy >= 0 &&
            y + dy < 360 &&
            masks[1 - side][(y + dy) * 640 + x + dx]
          ) {
            covered++;
            return;
          }
        }
    });
    assert.ok(total > 1500, 'drawing plus both stacked lines are visible');
    return covered / total;
  });
  assert.ok(
    coverage.every((value) => value > 0.98),
    `glyph coverage ${coverage}`,
  );
  const colors = [actualPreview.pixels, burned].map((pixels, side) => {
    const stride = side ? 3 : 4;
    const counts = { yellow: 0, green: 0, translucent: 0 };
    for (let i = 0; i < pixels.length; i += stride) {
      const [r, g, b] = pixels.slice(i, i + 3);
      if (r > 190 && g > 190 && b < 70) counts.yellow++;
      if (r < 50 && g > 190 && b < 70) counts.green++;
      if (r > 125 && r < 160 && g > r + 8 && b > g + 8 && b < 195)
        counts.translucent++;
    }
    assert.ok(
      counts.yellow > 100 && counts.green > 800 && counts.translucent > 100,
      JSON.stringify(counts),
    );
    return counts;
  });
  run([
    '-ss',
    '1.2',
    '-i',
    exported,
    '-frames:v',
    '1',
    path.join(output, 'export.png'),
  ]);
  assert.deepEqual(errors, []);
  checks.push({
    coverage,
    colors,
    dy,
    action:
      'real drag preserves center collisions, native drawing, undo/redo, two window sizes and alpha/color in actual export',
  });
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  console.error({ output });
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
}
