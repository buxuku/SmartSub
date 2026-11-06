import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-waveform-e2e-'),
);
const media = path.join(output, 'waveform.mp4');
const source = path.join(output, 'waveform.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/demo.mp4',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=8000:duration=8',
  '-map',
  '0:v:0',
  '-map',
  '1:a:0',
  '-t',
  '8',
  '-vf',
  'scale=640:-2',
  '-af',
  "volume=0:enable='between(t,1,2)'",
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  media,
]);
await fs.writeFile(
  source,
  '1\n00:00:00,200 --> 00:00:02,800\nFirst waveform subtitle.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond waveform subtitle.\n',
);
const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${path.join(output, 'profile')}`,
  ],
  env: { ...process.env, NODE_ENV: 'development' },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
await page.waitForURL(/^http:\/\/localhost:\d+/);
await app.evaluate(({ BrowserWindow, dialog }) => {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.closeDevTools();
  dialog.showMessageBoxSync = () => 0;
});
const checks = [];
async function save() {
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  return page.evaluate(
    (filePath) => window.ipc.invoke('readSubtitleFile', { filePath }),
    source,
  );
}
try {
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    (url) => window.next.router.push(url),
    `/zh/proofread/?file=${encodeURIComponent(media)}`,
  );
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  const timeline = page.getByRole('region', { name: '音频波形', exact: true });
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'true');
  await expect(timeline.locator('[data-cue-index="0"]')).toBeVisible();
  const waveform = await page.evaluate(
    async (filePath) =>
      window.ipc.invoke('proofread:waveform', {
        requestId: 'test-envelope',
        filePath,
      }),
    media,
  );
  assert.equal(waveform.success, true);
  assert.ok(waveform.data.peaks.length > 300);
  const pixels = await timeline
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
      return painted;
    });
  assert.ok(pixels > 100, 'real waveform canvas has painted pixels');
  checks.push('real FFmpeg peaks and nonblank WaveSurfer canvas');
  const wrapper = timeline.locator('[part="wrapper"]');
  const originalWidth = await wrapper.evaluate(
    (element) => element.clientWidth,
  );
  await page.getByRole('button', { name: '放大波形', exact: true }).click();
  await expect
    .poll(() => wrapper.evaluate((element) => element.clientWidth))
    .toBeGreaterThan(originalWidth);
  await page.getByRole('button', { name: '缩小波形', exact: true }).click();
  const bounds = await wrapper.boundingBox();
  const handle = timeline.locator(
    '[data-cue-index="0"] [part*="region-handle-right"]',
  );
  const box = await handle.boundingBox();
  assert.ok(bounds && box);
  const edge = waveform.data.silenceEdges.find(
    (time) => Math.abs(time - 2) < 0.2,
  );
  assert.ok(edge);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + ((edge + 0.04) / waveform.data.duration) * bounds.width,
    box.y + box.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  let saved = await save();
  assert.match(
    saved[0].startEndTime,
    new RegExp(
      `00:00:0${Math.floor(edge)},${String(Math.round((edge % 1) * 1000)).padStart(3, '0')}$`,
    ),
  );
  checks.push('zoom and real pointer resize snap to measured silence and save');
  await page.keyboard.press('Meta+z');
  saved = await save();
  assert.ok(saved[0].startEndTime.endsWith('00:00:02,800'));
  await page.keyboard.press('Meta+Shift+z');
  saved = await save();
  assert.equal(saved.length, 2);
  const cue = await timeline.locator('[data-cue-index="0"]').boundingBox();
  await page.mouse.click(cue.x + cue.width / 2, cue.y + cue.height / 2);
  await page.keyboard.press('c');
  saved = await save();
  assert.equal(saved.length, 3);
  assert.equal(
    saved[0].content.join('') + saved[1].content.join(''),
    'First waveform subtitle.',
  );
  await page.mouse.click(cue.x + 5, cue.y + cue.height / 2);
  await page.keyboard.press('x');
  saved = await save();
  assert.equal(saved.length, 2);
  await page.keyboard.press('Meta+z');
  saved = await save();
  assert.equal(saved.length, 3);
  checks.push(
    'C split at playhead, X merge, undo/redo and actual disk persistence',
  );
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
    await expect(timeline).toBeVisible();
    await page.screenshot({ path: path.join(output, `waveform-${width}.png`) });
  }
  await page.keyboard.press('Meta+b');
  await expect(timeline).toHaveCount(0);
  await page.keyboard.press('Meta+b');
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'true');
  checks.push('1024/1440 viewport and panel collapse/remount');
  await page.getByText('First wavefo', { exact: true }).click();
  const editor = page.locator('textarea').first();
  await editor.fill('cx input stays text');
  await editor.press('c');
  await editor.press('x');
  saved = await save();
  assert.equal(saved.length, 3, 'C/X never split or merge while typing');
  assert.ok(saved[0].content.join('').includes('cx input stays text'));
  await page.keyboard.press('Meta+b');
  await fs.rename(media, `${media}.moved`);
  await page.keyboard.press('Meta+b');
  await expect(timeline.getByRole('alert')).toBeVisible();
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'false');
  await fs.rename(`${media}.moved`, media);
  await timeline.getByRole('button', { name: '重试', exact: true }).click();
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'true');
  await expect(timeline.getByRole('alert')).toHaveCount(0);
  checks.push(
    'input hotkey isolation, persistent read failure and real retry after restoring media',
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error(JSON.stringify({ output, checks }));
  console.error((await page.locator('body').innerText()).slice(-6000));
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
