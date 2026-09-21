import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-proofread-load-e2e-'),
);
const source = path.join(output, 'source.srt');
const target = path.join(output, 'target.srt');
const sidecar = path.join(output, 'sidecar.json');
const media = path.join(output, 'preview.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x234b45:s=320x180:r=24:d=6',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=16000:duration=6',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  media,
]);
const sourceBytes = '1\n00:00:01,000 --> 00:00:03,000\nOriginal subtitle.\n';
const targetBytes = '1\n00:00:01,000 --> 00:00:03,000\nTranslated subtitle.\n';
await fs.writeFile(source, sourceBytes);
await fs.writeFile(target, targetBytes);
const sidecarBytes = JSON.stringify({
  version: 2,
  cues: [
    {
      id: '1',
      startMs: 1000,
      endMs: 3000,
      source: 'Sidecar original.',
      target: 'Sidecar translation.',
      speakerIds: [1],
      primarySpeakerId: 1,
    },
  ],
  speakers: [{ id: 1, displayName: 'Speaker One', color: '#2563eb' }],
  meta: {},
});
await fs.writeFile(sidecar, sidecarBytes);
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
const enter = () =>
  page.getByRole('button', { name: '校对', exact: true }).click();
const back = () =>
  page.getByRole('button', { name: '返回列表', exact: true }).click();
const failure = () =>
  page.getByRole('alert').filter({ hasText: '字幕数据加载失败' });
const retry = () =>
  failure().getByRole('button', { name: '重新加载', exact: true }).click();
async function create(useSidecar) {
  return page.evaluate(
    async ({ source, target, sidecar, media }) => {
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Load recovery',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            videoPath: media,
            ...(sidecar ? { proofreadDataFile: sidecar } : {}),
          },
        ],
      });
      if (!task?.success) throw new Error(JSON.stringify(task));
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
      return task.data.id;
    },
    { source, target, sidecar: useSidecar ? sidecar : undefined, media },
  );
}
async function assertBlocked() {
  await expect(failure()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '保存字幕', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-subtitle-editor]')).toHaveCount(0);
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Meta+Enter');
  await expect(failure()).toBeVisible();
  assert.equal(await fs.readFile(source, 'utf8'), sourceBytes);
}
try {
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  for (const [format, valid, empty, damaged] of [
    ['srt', sourceBytes, '', `${sourceBytes}\nInvalid block`],
    [
      'vtt',
      'WEBVTT\n\nNOTE metadata\n\n00:01.000 --> 00:03.000 align:start\nCaption\n',
      'WEBVTT\n\n',
      'WEBVTT\n\n00:01.000 --> 00:03.000\nCaption\n\nBad block',
    ],
    [
      'ass',
      '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:03.00,Caption',
      '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Start, End, Text\n',
      '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:03.00,Caption\nDialogue: 0:00:05.00',
    ],
    [
      'lrc',
      '[ar:Artist]\n[00:01.00]Caption\n',
      '[ar:Artist]\n',
      '[00:01.00]Caption\nInvalid lyric line',
    ],
  ]) {
    const filePath = path.join(output, `format.${format}`);
    const read = () =>
      page.evaluate(async (filePath) => {
        try {
          return {
            rows: await window.ipc.invoke('readSubtitleFile', {
              filePath,
              strict: true,
            }),
          };
        } catch (error) {
          return { error: String(error) };
        }
      }, filePath);
    await fs.writeFile(filePath, valid);
    assert.equal((await read()).rows.length, 1);
    await fs.writeFile(filePath, empty);
    assert.deepEqual((await read()).rows, []);
    await fs.writeFile(filePath, damaged);
    assert.ok((await read()).error);
    assert.equal(await fs.readFile(filePath, 'utf8'), damaged);
  }
  checks.push(
    'Real strict IPC accepts all four formats and valid empty files, rejects partially damaged files without changing bytes',
  );
  await create(false);
  await fs.rename(target, `${target}.moved`);
  await enter();
  await assertBlocked();
  await failure().locator('summary').click();
  await expect(failure()).toContainText('File not found');
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
    assert.deepEqual(
      await page.evaluate(() => {
        const bottom = document
          .querySelector('footer')
          .getBoundingClientRect().top;
        return [...document.querySelectorAll('aside a')]
          .filter((link) => {
            const rect = link.getBoundingClientRect();
            const centerTarget = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return (
              rect.top < 0 ||
              rect.bottom > bottom ||
              !link.contains(centerTarget)
            );
          })
          .map((link) => link.getAttribute('aria-label'));
      }),
      [],
      'Every sidebar destination must be visible and unobstructed',
    );
    await page.screenshot({
      path: path.join(output, `load-error-${width}.png`),
    });
  }
  await fs.rename(`${target}.moved`, target);
  await retry();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Translated subtitle.',
  );
  checks.push(
    'Missing translation blocks all edits/saves, permanent error details, real restore/retry, both viewports',
  );
  await back();

  if (process.platform !== 'win32') {
    await fs.chmod(source, 0);
    await enter();
    await expect(failure()).toBeVisible();
    await failure().locator('summary').click();
    await expect(failure()).toContainText('EACCES');
    await fs.chmod(source, 0o600);
    await retry();
    await expect(page.locator('#subtitle-0')).toBeVisible();
    await back();
    checks.push('Real chmod read denial and explicit permission-repair retry');
  }
  await fs.writeFile(target, 'Corrupted non-subtitle bytes');
  await enter();
  await assertBlocked();
  await fs.writeFile(target, targetBytes);
  await retry();
  await back();
  checks.push('Nonempty unparseable subtitle is not an empty translation');

  await fs.writeFile(
    target,
    `${targetBytes}\n2\nCorrupted timing\nLost translation\n`,
  );
  await enter();
  await assertBlocked();
  assert.match(await fs.readFile(target, 'utf8'), /Lost translation/);
  await fs.writeFile(target, targetBytes);
  await retry();
  await back();
  checks.push(
    'Partially malformed subtitles cannot be silently truncated by a later save',
  );
  const duplicateSource = `${sourceBytes}\n${sourceBytes.replace('Original subtitle.', 'Second original.')}`;
  const duplicateTarget = `${targetBytes}\n${targetBytes.replace('Translated subtitle.', 'Second translation.')}`;
  await fs.writeFile(target, duplicateTarget);
  await enter();
  await assertBlocked();
  assert.equal(await fs.readFile(target, 'utf8'), duplicateTarget);
  await fs.writeFile(source, duplicateSource);
  await retry();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Translated subtitle.',
  );
  await page.locator('#subtitle-1').click();
  await expect(page.locator('#subtitle-tgt-1')).toHaveValue(
    'Second translation.',
  );
  await page.locator('#subtitle-tgt-1').fill('Second translation edited.');
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  const duplicateSaved = await fs.readFile(target, 'utf8');
  assert.match(duplicateSaved, /Translated subtitle\./);
  assert.match(duplicateSaved, /Second translation edited\./);
  await back();
  await fs.writeFile(source, sourceBytes);
  await fs.writeFile(target, targetBytes);
  checks.push(
    'Unmatched extra translations block loading; duplicate timestamps preserve distinct translations through real save',
  );
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();

  await create(true);
  await fs.writeFile(sidecar, '{"version":2,');
  await enter();
  await assertBlocked();
  assert.equal(await fs.readFile(sidecar, 'utf8'), '{"version":2,');
  await fs.writeFile(
    sidecar,
    sidecarBytes.replace('"startMs":1000', '"startMs":"corrupt"'),
  );
  await retry();
  await assertBlocked();
  await fs.writeFile(sidecar, sidecarBytes);
  await retry();
  await page.locator('#subtitle-0').click();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Sidecar translation.',
  );
  await expect(
    page.getByText('Speaker One', { exact: true }).first(),
  ).toBeVisible();
  await back();
  checks.push(
    'Malformed JSON and corrupt sidecar fields never fall back or normalize into data loss; repair restores translation and roster',
  );

  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('getSubtitleAsVtt');
    globalThis.previewFault = true;
    globalThis.previewFaultCalls = 0;
    ipcMain.removeHandler('getSubtitleAsVtt');
    ipcMain.handle('getSubtitleAsVtt', (...args) => {
      if (globalThis.previewFault) {
        globalThis.previewFaultCalls++;
        return { error: 'Injected VTT failure' };
      }
      return original(...args);
    });
  });
  await enter();
  const previewFailure = page
    .getByRole('alert')
    .filter({ hasText: '播放器字幕预览不可用' });
  await expect(previewFailure).toBeVisible();
  assert.ok(await app.evaluate(() => globalThis.previewFaultCalls > 0));
  await page.locator('#subtitle-0').click();
  await page
    .locator('#subtitle-src-0')
    .fill('Edit preserved through preview retry');
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.readyState))
    .toBeGreaterThan(0);
  await page.locator('video').evaluate((video) => {
    window.__previewVideo = video;
    video.currentTime = 1;
  });
  await previewFailure.locator('summary').click();
  await page.screenshot({ path: path.join(output, 'preview-error.png') });
  await app.evaluate(() => {
    globalThis.previewFault = false;
  });
  await previewFailure
    .getByRole('button', { name: '重试字幕预览', exact: true })
    .click();
  await expect(previewFailure).toHaveCount(0);
  await expect(page.locator('video track')).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator('video track')
        .evaluateAll((tracks) => tracks.map((track) => track.track.mode)),
    )
    .toEqual(['disabled', 'showing']);
  await expect
    .poll(() =>
      page.locator('video track[default]').evaluate((track) => ({
        state: track.readyState,
        text: track.track.cues?.[0]?.text,
        mode: track.track.mode,
      })),
    )
    .toEqual({ state: 2, text: 'Translated subtitle.', mode: 'showing' });
  assert.equal(
    await page
      .locator('video')
      .evaluate((video) => video === window.__previewVideo),
    true,
  );
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.currentTime))
    .toBe(1);
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Edit preserved through preview retry',
  );
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: path.join(output, 'preview-recovered.png') });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('saveProofreadDataAndRender');
    globalThis.saveFault = true;
    ipcMain.removeHandler('saveProofreadDataAndRender');
    ipcMain.handle('saveProofreadDataAndRender', (...args) =>
      globalThis.saveFault
        ? { success: false, error: 'Injected output write failure' }
        : original(...args),
    );
  });
  await page.getByRole('button', { name: '保存字幕', exact: true }).click();
  const saveFailure = page.getByRole('alert').filter({ hasText: '保存失败' });
  await expect(saveFailure).toBeVisible();
  await saveFailure.locator('summary').click();
  await expect(saveFailure).toContainText('Injected output write failure');
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'Edit preserved through preview retry',
  );
  assert.equal(await fs.readFile(sidecar, 'utf8'), sidecarBytes);
  await page.screenshot({ path: path.join(output, 'save-error.png') });
  await app.evaluate(() => {
    globalThis.saveFault = false;
  });
  await saveFailure
    .getByRole('button', { name: '重试保存', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  assert.match(
    await fs.readFile(source, 'utf8'),
    /Edit preserved through preview retry/,
  );
  assert.match(
    await fs.readFile(sidecar, 'utf8'),
    /Edit preserved through preview retry/,
  );
  checks.push(
    'Optional VTT failure banner retries independently and preserves dirty text plus real sidecar save',
    'Preview retry updates real video tracks without remounting the player or resetting its playhead',
    'Save failure retains dirty data with permanent details and explicit retry commits to disk',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error({ output, checks, errors });
  console.error((await page.locator('body').innerText()).slice(-5000));
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await fs.chmod(source, 0o600).catch(() => {});
  await app.close();
}
