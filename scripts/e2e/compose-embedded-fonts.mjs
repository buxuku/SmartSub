import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import {
  embeddedFontFixture,
  fontSection,
} from '../compose/embedded-font-fixture.mjs';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-embedded-e2e-'),
);
const video = path.join(output, 'source.mp4');
const subtitle = path.join(output, 'embedded.ass');
const exported = path.join(output, 'burned.mp4');
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
run([
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=25:d=2',
  '-c:v',
  'libx264',
  video,
]);
const font = embeddedFontFixture();
const glyphs = '\uea60\uea61\uea62';
const style = {
  fontName: 'Arial',
  fontSize: 42,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 0,
  shadow: 0,
  alignment: 5,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};
let app, page;
const checks = [];
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
  const fixture =
    preview.data.slice(0, preview.data.indexOf('Dialogue:')) +
    `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\fncodicon}${glyphs}{\\r} EMBEDDED\n` +
    fontSection(font) +
    '\n[Aegisub Extradata]\nData: 0,extension,metadata\n';
  await fs.writeFile(subtitle, fixture);
  await page.evaluate(
    ({ video, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(video)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { video, subtitle },
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.stringify(await window.__jassubPreview.renderer.getEvents()),
      ),
    )
    .toContain('fncodicon');
  const fontSelect = page.getByRole('combobox', { name: '字体', exact: true });
  await fontSelect.click();
  await page
    .getByRole('combobox', { name: '搜索字体', exact: true })
    .fill('codicon');
  const option = page.getByRole('option').filter({ hasText: /^codicon/ });
  await expect(option).toBeEnabled();
  await option.scrollIntoViewIfNeeded();
  await expect(option.locator('[data-font-sample]')).toHaveAttribute(
    'data-font-loaded',
    'true',
  );
  await option.scrollIntoViewIfNeeded();
  const menu = page.getByRole('listbox');
  await expect(menu).toHaveCSS('opacity', '1');
  const menuSurface = await menu.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, opacity: style.opacity };
  });
  assert.match(menuSurface.background, /^rgb\(/, 'font menu must be opaque');
  checks.push({ action: 'font menu is opaque after opening', ...menuSurface });
  await page.screenshot({ path: path.join(output, 'embedded-menu.png') });
  await option.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Array.from(document.fonts).filter((font) =>
            font.family.startsWith('SmartSub-font-'),
          ).length,
      ),
    )
    .toBe(0);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.__jassubPreview.renderer.getStyles()).at(-1).FontName,
      ),
    )
    .toBe('codicon');
  const selected = await page.evaluate(
    ({ subtitlePath, style }) =>
      window.ipc.invoke('subtitleMerge:buildPreviewAss', {
        subtitlePath,
        style,
      }),
    { subtitlePath: subtitle, style: { ...style, fontName: 'codicon' } },
  );
  assert.equal(selected.success, true);
  assert.equal(selected.fontSubstituted, false);
  assert.equal(selected.fontName, 'codicon');
  // The real document's default remains selectable even though the OS does not install it.
  const rendered = await page.evaluate(async () => {
    const video = document.querySelector('video');
    await window.__jassubPreview.manualRender(
      {
        mediaTime: 0,
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
    context.drawImage(document.querySelector('canvas.JASSUB'), 0, 0, 640, 360);
    return {
      pixels: Array.from(context.getImageData(0, 0, 640, 360).data),
      png: canvas.toDataURL().split(',')[1],
    };
  });
  await fs.writeFile(
    path.join(output, 'preview.png'),
    Buffer.from(rendered.png, 'base64'),
  );
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const burned = run([
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
  run(['-i', exported, '-frames:v', '1', path.join(output, 'export.png')]);
  const masks = [
    Array.from({ length: 640 * 360 }, (_, i) => rendered.pixels[i * 4] > 150),
    Array.from({ length: 640 * 360 }, (_, i) => burned[i * 3] > 150),
  ];
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
        for (let dx = -2; dx <= 2; dx++)
          if (
            x + dx >= 0 &&
            x + dx < 640 &&
            y + dy >= 0 &&
            y + dy < 360 &&
            masks[1 - side][(y + dy) * 640 + x + dx]
          )
            matched = true;
      if (matched) matches++;
    });
    assert.ok(count > 200);
    return matches / count;
  });
  assert.ok(
    coverage.every((value) => value > 0.98),
    `embedded font preview/export mismatch: ${coverage}`,
  );
  checks.push({
    action:
      'uninstalled embedded font selectable, sample rendered, inline/default private glyphs preserved, real export matches preview',
    coverage,
  });
  const color = page.locator('input[type=text][aria-label="字体颜色"]');
  await fs.writeFile(
    subtitle,
    fixture.slice(0, fixture.indexOf('[Fonts]')) +
      '[Fonts]\nfontname: broken.ttf\n!\n',
  );
  await color.fill('#FFFF00');
  await expect(
    page.getByRole('alert').filter({ hasText: /预览/ }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(false);
  await fs.writeFile(subtitle, fixture);
  await color.fill('#FFFFFF');
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.__jassubPreview.renderer.getStyles()).at(-1).FontName,
      ),
    )
    .toBe('codicon');
  checks.push({
    action:
      'malformed attachment cannot silently substitute or retain old preview; repaired file/style recovers',
  });
  await fs.writeFile(subtitle, fixture.slice(0, fixture.indexOf('[Fonts]')));
  await color.fill('#FFFF00');
  await expect(
    page.getByRole('alert').filter({ hasText: /预览/ }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(false);
  const noEmbedded = await page.evaluate(
    (subtitlePath) =>
      window.ipc.invoke('subtitleMerge:listFonts', { subtitlePath }),
    subtitle,
  );
  assert.equal(
    noEmbedded.data.some((font) => font.name === 'codicon' && font.available),
    false,
  );
  await fs.writeFile(subtitle, fixture);
  await color.fill('#FFFFFF');
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  checks.push({
    action:
      'removed attachment is not resurrected from preview/global font cache; restoration works',
  });
  await page.screenshot({ path: path.join(output, 'screen.png') });
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
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
