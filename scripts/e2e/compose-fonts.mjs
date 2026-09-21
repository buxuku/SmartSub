import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-fonts-e2e-'),
);
const video = path.join(output, 'fonts.mp4');
const subtitle = path.join(output, 'fonts.srt');
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
  video,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:03,000\nSmartSub Wiii 123\n字幕示例\n',
);
let app, page;
const checks = [];
const logs = [];
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
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(20000);
  page.on('console', (message) => logs.push(message.text()));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    ({ video, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(video)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { video, subtitle },
  );
  const fontSelect = page.getByRole('combobox', { name: '字体', exact: true });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  await fontSelect.click();
  const fonts = await page.evaluate(() =>
    window.ipc.invoke('subtitleMerge:listFonts'),
  );
  assert.equal(fonts.success, true);
  const sampleFontCount = () =>
    page.evaluate(
      () =>
        Array.from(document.fonts).filter((font) =>
          font.family.startsWith('SmartSub-font-'),
        ).length,
    );
  for (const font of fonts.data.filter((font) => font.available)) {
    await page
      .getByRole('combobox', { name: '搜索字体', exact: true })
      .fill(font.name);
    const sample = page.locator(`[data-font-sample="${font.name}"]`);
    await sample.scrollIntoViewIfNeeded();
    await expect(sample).toHaveAttribute('data-font-loaded', 'true');
    await expect(sample).toHaveText('SmartSub 字幕示例 123');
    assert.ok(
      (await sampleFontCount()) < 40,
      'only visible samples retain FontFace resources',
    );
  }
  await page.screenshot({ path: path.join(output, 'font-menu.png') });
  const selectName =
    process.platform === 'darwin'
      ? 'Hiragino Sans GB'
      : fonts.data.find((font) => font.available).name;
  await page
    .getByRole('combobox', { name: '搜索字体', exact: true })
    .fill(selectName);
  await page
    .getByRole('option')
    .filter({ has: page.locator(`[data-font-sample="${selectName}"]`) })
    .click();
  await expect.poll(sampleFontCount).toBe(0);
  checks.push(
    'all installed font samples load through search; retained faces remain below 40 and closing menu releases all sample faces',
  );
  const expectedFont = fonts.data.find(
    (font) => font.name === selectName,
  ).resolvedName;
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.__jassubPreview.renderer.getStyles()).at(-1).FontName,
      ),
    )
    .toBe(expectedFont);
  const readPixels = () =>
    page.evaluate(async () => {
      const video = document.querySelector('video');
      const instance = window.__jassubPreview;
      await instance.manualRender(
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
      const source = document.querySelector('canvas.JASSUB');
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d');
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const count = { white: 0, yellow: 0, pink: 0, visible: 0 };
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b, a] = pixels.slice(i, i + 4);
        if (a < 30) continue;
        count.visible++;
        if (r > 180 && g > 180 && b > 180) count.white++;
        if (r > 180 && g > 180 && b < 100) count.yellow++;
        if (r > 90 && r > g * 1.35 && b > g * 1.2) count.pink++;
      }
      return count;
    });
  await expect
    .poll(async () => (await readPixels()).white)
    .toBeGreaterThan(100);
  checks.push(
    'installed fonts render menu samples; actual family alias renders visible CJK glyphs',
  );
  if (process.platform === 'darwin') {
    await fontSelect.click();
    await page
      .getByRole('combobox', { name: '搜索字体', exact: true })
      .fill('Menlo');
    await page
      .getByRole('option')
      .filter({ has: page.locator('[data-font-sample="Menlo"]') })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.__jassubPreview.renderer.getStyles()).at(-1).FontName,
        ),
      )
      .toBe('Menlo');
    await expect
      .poll(async () => (await readPixels()).white)
      .toBeGreaterThan(100);
    checks.push(
      'Menlo discovered outside legacy candidates, selectable and rendered with visible CJK fallback',
    );
  }
  for (const [name, id, color] of [
    ['B站知识区高对比', 'bilibili', 'yellow'],
    ['Netflix 双语影视', 'netflix', 'yellow'],
    ['短视频综艺花字', 'variety', 'pink'],
    ...(process.platform === 'darwin'
      ? [['经典白字黑边', 'installed', 'white']]
      : []),
  ]) {
    await page.getByRole('button', { name, exact: false }).click();
    if (id === 'installed') {
      await fontSelect.click();
      await page
        .getByRole('combobox', { name: '搜索字体', exact: true })
        .fill('Menlo');
      await page
        .getByRole('option')
        .filter({ has: page.locator('[data-font-sample="Menlo"]') })
        .click();
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await window.__jassubPreview.renderer.getStyles()).at(-1)
                .FontName,
          ),
        )
        .toBe('Menlo');
    }
    await expect
      .poll(async () => (await readPixels())[color])
      .toBeGreaterThan(40);
    if (id === 'netflix') {
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await window.__jassubPreview.renderer.getStyles()).at(-1)
                .FontName,
          ),
        )
        .toBe('Courier New');
      const events = await page.evaluate(
        async () => await window.__jassubPreview.renderer.getEvents(),
      );
      assert.ok(
        events.some((event) => event.Text.includes('\\fnArial Unicode MS')),
        'only missing CJK glyphs use explicit fallback',
      );
    }
    const exported = path.join(output, `${id}.mp4`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exported);
    await page
      .getByRole('button', { name: '选择输出路径', exact: true })
      .click();
    await page.getByRole('button', { name: '生成视频', exact: true }).click();
    await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({
      timeout: 60000,
    });
    const pixels = execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
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
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (
        color === 'yellow'
          ? r > 160 && g > 160 && b < 100
          : color === 'white'
            ? r > 180 && g > 180 && b > 180
            : r > 70 && r > g * 1.35 && b > g * 1.2
      )
        colored++;
    }
    assert.ok(colored > 40, `${id} must have actual exported ${color} pixels`);
    const maskData = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      context.fillStyle = '#000000';
      context.fillRect(0, 0, 640, 360);
      context.drawImage(
        document.querySelector('canvas.JASSUB'),
        0,
        0,
        640,
        360,
      );
      const rgba = context.getImageData(0, 0, 640, 360).data;
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        pixels: Array.from(rgba),
      };
    });
    await fs.writeFile(
      path.join(output, `${id}-preview.png`),
      Buffer.from(maskData.png, 'base64'),
    );
    const mask = Array.from({ length: 640 * 360 }, (_, index) =>
      Math.max(...maskData.pixels.slice(index * 4, index * 4 + 3)) > 150
        ? 1
        : 0,
    );
    let overlap = 0,
      union = 0;
    for (let i = 0; i < mask.length; i++) {
      const burned =
        Math.max(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]) > 150;
      if (burned || mask[i]) union++;
      if (burned && mask[i]) overlap++;
    }
    checks.push(
      `${id}: preview/export glyph mask IoU ${(overlap / union).toFixed(3)}`,
    );
    await fs.writeFile(
      path.join(output, 'pixel-checks.json'),
      JSON.stringify(checks),
    );
    if (id !== 'variety')
      assert.ok(
        overlap / union > 0.8,
        `${id} preview/export mask IoU=${overlap / union}`,
      );
    // Synthetic italic outlines differ by 1-2 pixels between native and WASM
    // FreeType builds. Check both directions so extra/missing glyphs still fail.
    const masks = [
      Array.from(
        { length: 640 * 360 },
        (_, i) => Math.min(...maskData.pixels.slice(i * 4, i * 4 + 3)) > 180,
      ),
      Array.from(
        { length: 640 * 360 },
        (_, i) => Math.min(...pixels.subarray(i * 3, i * 3 + 3)) > 180,
      ),
    ];
    for (let side = 0; side < 2; side++) {
      let count = 0,
        nearby = 0;
      for (let i = 0; i < masks[side].length; i++) {
        if (!masks[side][i]) continue;
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
        if (matched) nearby++;
      }
      assert.ok(
        count > 100 && nearby / count > 0.98,
        `${id} glyph coverage ${side}=${nearby / count}`,
      );
      checks.push(
        `${id}: 2px glyph coverage ${side} ${(nearby / count).toFixed(3)}`,
      );
    }
    await page.screenshot({ path: path.join(output, `${id}.png`) });
    checks.push(
      `${id}: preview and actual FFmpeg export contain preset-specific color pixels`,
    );
  }
  assert.equal(
    logs.some((line) => /failed to find any fallback with glyph/.test(line)),
    false,
    'no missing glyphs in production previews',
  );
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks, logs }, null, 2),
  );
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  await fs.writeFile(path.join(output, 'logs.json'), JSON.stringify(logs));
  console.error({ output });
  throw error;
} finally {
  if (app) await app.close();
}
