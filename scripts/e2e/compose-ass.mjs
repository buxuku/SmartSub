import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const constants = { exports: {} };
const source = await fs.readFile(
  'renderer/components/subtitleMerge/constants.ts',
  'utf8',
);
new Function(
  'module',
  'exports',
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
)(constants, constants.exports);
const style = constants.exports.DEFAULT_STYLE;
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-ass-e2e-'),
);
const video = path.join(output, 'source.mp4');
const subtitle = path.join(output, 'animated.ass');
const exported = path.join(output, 'burned.mp4');
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
run([
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=25:d=3',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  video,
]);
const checks = [];
let app, page;
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
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
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
  const header = preview.data.slice(0, preview.data.indexOf('Dialogue:'));
  const fixture =
    header.replace(
      /^(Style: Default,.*)$/m,
      (line) =>
        `${line}\n${line.replace('Style: Default,', 'Style: Alternate,')}`,
    ) +
    [
      'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\an7\\pos(24,30)\\p1\\1c&HFFFFFF&}m 0 0 l 32 0 32 16 0 16{\\p0}',
      'Dialogue: 2,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\an5\\move(90,130,260,150,0,2400)\\t(0,2000,\\fscx135)\\t(0,2000,\\clip(0,0,384,288))}Animated, te{\\b1}xt',
      'Dialogue: 4,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,245)\\fnCourier New}Wiii{\\rAlternate} RESET 字幕',
    ].join('\n') +
    '\n';
  // Named resets must target an actual second style, not an unknown fallback.
  assert.match(fixture, /^Style: Alternate,/m);
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
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.__jassubPreview.renderer.getEvents()).length,
      ),
    )
    .toBe(3);
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const originalEvents = await page.evaluate(async () =>
    window.__jassubPreview.renderer.getEvents(),
  );
  const drag = page.locator('[data-subtitle-drag]');
  await expect(drag).toBeVisible();
  const box = await drag.boundingBox();
  const frame = await page.locator('[data-subtitle-canvas]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + box.height / 2 + frame.height * 0.05,
    { steps: 8 },
  );
  await page.mouse.up();
  const position = page.locator('#subtitle-position-y');
  await expect
    .poll(async () => Number(await position.inputValue()))
    .toBeCloseTo((30 / 288) * 100 + 5, 1);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const events = await window.__jassubPreview.renderer.getEvents();
        return events[0].Text;
      }),
    )
    .not.toBe(originalEvents[0].Text);
  const movedEvents = await page.evaluate(async () =>
    window.__jassubPreview.renderer.getEvents(),
  );
  const coordinates = (text, kind) =>
    new RegExp(`\\\\${kind}\\(([^)]+)\\)`).exec(text)[1].split(',').map(Number);
  const delta =
    coordinates(movedEvents[0].Text, 'pos')[1] -
    coordinates(originalEvents[0].Text, 'pos')[1];
  assert.ok(
    Math.abs(delta - 14.4) < 0.1,
    'pointer translates the group by five percent',
  );
  const beforeMove = coordinates(originalEvents[1].Text, 'move');
  const afterMove = coordinates(movedEvents[1].Text, 'move');
  assert.ok(Math.abs(afterMove[1] - beforeMove[1] - delta) < 0.01);
  assert.ok(Math.abs(afterMove[3] - beforeMove[3] - delta) < 0.01);
  assert.equal(afterMove[3] - afterMove[1], beforeMove[3] - beforeMove[1]);
  assert.ok(
    Math.abs(coordinates(movedEvents[2].Text, 'pos')[1] - 245 - delta) < 0.01,
  );
  assert.match(movedEvents[0].Text, /\\an7/);
  assert.match(movedEvents[1].Text, /\\an5/);
  assert.match(movedEvents[0].Text, /m 0 0 l 32 0 32 16 0 16/);
  checks.push({
    action:
      'pointer group translation preserves native alignments, layer spacing, drawing and movement endpoints',
    delta,
  });
  const eventTexts = () =>
    page.evaluate(async () =>
      (await window.__jassubPreview.renderer.getEvents()).map(
        (event) => event.Text,
      ),
    );
  const beforeTexts = originalEvents.map((event) => event.Text);
  const afterTexts = movedEvents.map((event) => event.Text);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(eventTexts).toEqual(beforeTexts);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(eventTexts).toEqual(afterTexts);
  await page.getByRole('button', { name: '恢复对齐位置', exact: true }).click();
  await expect.poll(eventTexts).toEqual(beforeTexts);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(eventTexts).toEqual(afterTexts);
  checks.push({
    action:
      'undo, redo, reset and undo-reset restore exact native/moved event texts',
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.__jassubPreview.renderer.getEvents()).length,
      ),
    )
    .toBe(3);
  await page.locator('#subtitle-highlight-terms').fill('text');
  await page
    .locator('input[type=text][aria-label="字体颜色"]')
    .fill('rgba( 255, 255, 255, 0.5 )');
  await expect(
    page.locator('input[type=color][aria-label="字体颜色"]'),
  ).toHaveValue('#ffffff');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const events = await window.__jassubPreview.renderer.getEvents();
        return events.some((event) =>
          event.Text.includes(
            '{\\1c&H00FFFF&\\1a&H00&}te{\\b1}{\\1c&H00FFFF&\\1a&H00&}xt',
          ),
        );
      }),
    )
    .toBe(true);
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exported);
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const hashes = [];
  for (const time of [0.24, 1.2, 2.4]) {
    const previewFrame = await page.evaluate(async (time) => {
      const video = document.querySelector('video');
      video.pause();
      await new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.currentTime = time;
      });
      await window.__jassubPreview.manualRender(
        {
          mediaTime: time,
          width: video.videoWidth,
          height: video.videoHeight,
          expectedDisplayTime: performance.now(),
        },
        true,
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      context.fillStyle = '#000';
      context.fillRect(0, 0, 640, 360);
      context.drawImage(
        document.querySelector('canvas.JASSUB'),
        0,
        0,
        640,
        360,
      );
      return {
        pixels: Array.from(context.getImageData(0, 0, 640, 360).data),
        png: canvas.toDataURL().split(',')[1],
      };
    }, time);
    const burned = run([
      '-ss',
      String(time),
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
    const masks = [
      Array.from(
        { length: 640 * 360 },
        (_, i) => Math.max(...previewFrame.pixels.slice(i * 4, i * 4 + 3)) > 95,
      ),
      Array.from(
        { length: 640 * 360 },
        (_, i) => Math.max(...burned.subarray(i * 3, i * 3 + 3)) > 95,
      ),
    ];
    const colorCounts = [previewFrame.pixels, burned].map((pixels, side) => {
      const stride = side === 0 ? 4 : 3;
      let yellow = 0;
      let translucent = 0;
      for (let i = 0; i < pixels.length; i += stride) {
        const [r, g, b] = pixels.slice(i, i + 3);
        if (r > 160 && g > 160 && b < 80) yellow++;
        if (r > 115 && r < 140 && Math.abs(r - g) < 5 && Math.abs(g - b) < 5)
          translucent++;
      }
      assert.ok(yellow > 40, `cross-tag word is highlighted at ${time}s`);
      assert.ok(
        translucent > 50,
        `RGBA half-opacity text is visible at ${time}s`,
      );
      return { yellow, translucent };
    });
    const coverage = masks.map((mask, side) => {
      let count = 0,
        matches = 0;
      mask.forEach((visible, i) => {
        if (!visible) return;
        count++;
        const x = i % 640,
          y = Math.floor(i / 640);
        let matched = false;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            if (
              x + dx >= 0 &&
              x + dx < 640 &&
              y + dy >= 0 &&
              y + dy < 360 &&
              masks[1 - side][(y + dy) * 640 + x + dx]
            )
              matched = true;
          }
        if (matched) matches++;
      });
      assert.ok(count > 200, 'actual glyphs and drawing are visible');
      return matches / count;
    });
    await fs.writeFile(
      path.join(output, `preview-${time}.png`),
      Buffer.from(previewFrame.png, 'base64'),
    );
    run([
      '-ss',
      String(time),
      '-i',
      exported,
      '-frames:v',
      '1',
      path.join(output, `export-${time}.png`),
    ]);
    assert.ok(
      coverage.every((value) => value > 0.98),
      `preview/export coverage at ${time}s: ${coverage}`,
    );
    hashes.push(createHash('sha256').update(burned).digest('hex'));
    checks.push({ time, coverage, colorCounts });
  }
  assert.equal(
    new Set(hashes).size,
    3,
    'animation advances in actual exported frames',
  );
  await page.screenshot({ path: path.join(output, 'screen.png') });
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ checks, hashes }, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      checks,
      verified:
        'native ASS animation, nested clip, drawing/layers, cross-tag highlight, RGBA opacity, named reset, inline font and CJK fallback',
    }),
  );
} catch (error) {
  console.error({ output });
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
}
