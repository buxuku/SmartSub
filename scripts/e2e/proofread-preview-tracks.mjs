import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

/**
 * The proofread player previews the editor's in-memory document. This drives
 * the real Electron app through #505 (no preview when a file has no language
 * metadata) and #520 (the preview never followed an edit): language metadata
 * missing, partial or complete, plain subtitle files or a sidecar document,
 * real keystrokes, undo/redo, save, and a restart that reuses the profile.
 */
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-proofread-preview-e2e-'),
);
const profile = path.join(output, 'profile');
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

const timings = [
  '00:00:01.000 --> 00:00:03.000',
  '00:00:04.000 --> 00:00:05.500',
];
const srt = (texts) =>
  texts
    .map(
      (text, index) =>
        `${index + 1}\n${timings[index].replace(/\./g, ',')}\n${text}\n`,
    )
    .join('\n');
// The text on disk differs from the sidecar on purpose: a preview that read
// the SRT instead of the editor document would show the wrong words.
const disk = {
  source: ['Disk original one.', 'Disk original two.'],
  target: ['Disk translation one.', 'Disk translation two.'],
};
const sidecarDocument = {
  source: ['Sidecar original one.', 'Sidecar original two.'],
  target: ['Sidecar translation one.', 'Sidecar translation two.'],
};
const languageSets = [
  { name: 'no languages' },
  { name: 'source language only', sourceLanguage: 'en' },
  { name: 'both languages', sourceLanguage: 'en', targetLanguage: 'fr' },
];
const scenarios = languageSets.flatMap((languages) =>
  [false, true].map((sidecar) => ({
    ...languages,
    name: `${languages.name}, ${sidecar ? 'sidecar document' : 'subtitle files'}`,
    sidecar,
  })),
);

const checks = [];
const errors = [];
const consoleErrors = [];
let app;
let page;

async function launch() {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: process.argv.includes('--production')
        ? 'production'
        : 'development',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    // Count reads of the on-disk SRT-as-VTT: the preview must not need them.
    const original = ipcMain._invokeHandlers.get('getSubtitleAsVtt');
    globalThis.vttReads = 0;
    ipcMain.removeHandler('getSubtitleAsVtt');
    ipcMain.handle('getSubtitleAsVtt', (...args) => {
      globalThis.vttReads += 1;
      return original(...args);
    });
  });
  await page
    .getByRole('button', { name: '跳过', exact: true })
    .click({ timeout: 5000 })
    .catch(() => {});
}

const enter = () =>
  page.getByRole('button', { name: '校对', exact: true }).click();
const back = () =>
  page.getByRole('button', { name: '返回列表', exact: true }).click();

async function writeFixtures(scenario, index) {
  const directory = path.join(output, `scenario-${index}`);
  await fs.mkdir(directory);
  const files = {
    source: path.join(directory, 'source.srt'),
    target: path.join(directory, 'target.srt'),
    sidecar: path.join(directory, 'proofread.json'),
  };
  await fs.writeFile(files.source, srt(disk.source));
  await fs.writeFile(files.target, srt(disk.target));
  if (scenario.sidecar) {
    await fs.writeFile(
      files.sidecar,
      JSON.stringify({
        version: 2,
        cues: [
          [1000, 3000],
          [4000, 5500],
        ].map(([startMs, endMs], row) => ({
          id: String(row + 1),
          startMs,
          endMs,
          source: sidecarDocument.source[row],
          target: sidecarDocument.target[row],
          speakerIds: [1],
          primarySpeakerId: 1,
        })),
        speakers: [{ id: 1, displayName: 'Speaker One', color: '#2563eb' }],
        meta: {},
      }),
    );
  }
  return files;
}

const createTask = (scenario, files) =>
  page.evaluate(
    async (task) => {
      const result = await window.ipc.invoke('createProofreadTask', task);
      if (!result?.success) throw new Error(JSON.stringify(result));
      return result.data.id;
    },
    {
      name: `Preview: ${scenario.name}`,
      items: [
        {
          sourceSubtitlePath: files.source,
          targetSubtitlePath: files.target,
          videoPath: media,
          ...(scenario.sourceLanguage
            ? { sourceLanguage: scenario.sourceLanguage }
            : {}),
          ...(scenario.targetLanguage
            ? { targetLanguage: scenario.targetLanguage }
            : {}),
          ...(scenario.sidecar ? { proofreadDataFile: files.sidecar } : {}),
        },
      ],
    },
  );

async function openTask(id) {
  await page.evaluate(
    (workItem) =>
      window.next.router.push(`/zh/proofread/?workItem=${workItem}`),
    id,
  );
  await enter();
  await page.locator('#subtitle-0').click();
}

/** What the player really has: DOM tracks, their VTT text and parsed cues. */
const view = () =>
  page.locator('video track').evaluateAll((elements) =>
    Promise.all(
      elements.map(async (element) => {
        // The blob URL can be revoked while a newer track set replaces it.
        const text = await fetch(element.src).then(
          (response) => response.text(),
          () => '',
        );
        const track = element.track;
        return {
          label: element.label,
          language: element.srclang,
          mode: track.mode,
          rows: text
            .trim()
            .split(/\n{2,}/)
            .slice(1)
            .map((block) => {
              const [timing, ...lines] = block.split('\n');
              return [timing, lines.join('\n')];
            }),
          ...(track.mode === 'showing'
            ? {
                cues: Array.from(track.cues ?? [], (cue) => cue.text),
                active: Array.from(track.activeCues ?? [], (cue) => cue.text),
              }
            : {}),
        };
      }),
    ),
  );

const rowsOf = (texts) => texts.map((text, index) => [timings[index], text]);
/** Source track first (disabled), translation second (default, showing). */
const expectedView = (scenario, doc) => [
  {
    label: scenario.sourceLanguage ? `(${scenario.sourceLanguage})` : 'source',
    language: scenario.sourceLanguage ?? 'und',
    mode: 'disabled',
    rows: rowsOf(doc.source),
  },
  {
    label: scenario.targetLanguage ? `(${scenario.targetLanguage})` : 'target',
    language: scenario.targetLanguage ?? 'und',
    mode: 'showing',
    rows: rowsOf(doc.target),
    cues: doc.target,
    active: [doc.target[0]],
  },
];
const expectPreview = (scenario, doc) =>
  expect.poll(view, { timeout: 15000 }).toEqual(expectedView(scenario, doc));

async function seekIntoFirstCue() {
  const video = page.locator('video');
  await expect
    .poll(() => video.evaluate((element) => element.readyState), {
      timeout: 15000,
    })
    .toBeGreaterThan(0);
  await video.evaluate((element) => {
    element.pause();
    element.currentTime = 1.5;
  });
  await expect.poll(() => video.evaluate((e) => e.currentTime)).toBe(1.5);
}

const tasks = [];
try {
  await launch();

  for (const [index, scenario] of scenarios.entries()) {
    const files = await writeFixtures(scenario, index);
    const id = await createTask(scenario, files);
    const original = scenario.sidecar ? sidecarDocument : disk;
    await openTask(id);
    await seekIntoFirstCue();

    // #505: tracks exist although the language metadata is missing or partial,
    // and they show exactly what the editor shows (sidecar text, not the SRT).
    // #520 starts here: with complete metadata the old tracks existed but were
    // a snapshot, which the keystrokes below must no longer leave behind.
    await expectPreview(scenario, original);
    await expect(page.locator('#subtitle-src-0')).toHaveValue(
      original.source[0],
    );
    await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
      original.target[0],
    );

    // #520: real keystrokes reach the player without remounting it. Clicking
    // a row seeks the player to its start, so park the playhead only after
    // that and check that typing alone leaves it where it is.
    const typed = [`${original.target[0]} + typed live`, original.target[1]];
    await page.locator('#subtitle-tgt-0').click();
    await page.keyboard.press('End');
    await seekIntoFirstCue();
    await page.locator('video').evaluate((element) => {
      window.__previewVideo = element;
    });
    await page.keyboard.type(' + typed live', { delay: 15 });
    await expect(page.locator('#subtitle-tgt-0')).toHaveValue(typed[0]);
    await expectPreview(scenario, { ...original, target: typed });
    assert.equal(
      await page
        .locator('video')
        .evaluate((element) => element === window.__previewVideo),
      true,
      'The player must not be remounted while the preview follows edits',
    );
    assert.equal(
      await page.locator('video').evaluate((element) => element.currentTime),
      1.5,
      'The playhead must stay where it was while the preview follows edits',
    );

    // Undo and redo drive the same document, so they drive the preview.
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
      original.target[0],
    );
    await expectPreview(scenario, original);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.locator('#subtitle-tgt-0')).toHaveValue(typed[0]);
    await expectPreview(scenario, { ...original, target: typed });

    // The source track is not shown but follows its own edits too.
    const edited = {
      source: [`${original.source[0]} (edited)`, original.source[1]],
      target: typed,
    };
    await page.locator('#subtitle-src-0').fill(edited.source[0]);
    await expectPreview(scenario, edited);
    await page.screenshot({
      path: path.join(output, `preview-edited-${index}.png`),
    });

    // Saving neither loses nor changes the preview, and reaches the disk.
    await page.getByRole('button', { name: '保存字幕', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存' }),
    ).toBeVisible();
    assert.ok(
      (await fs.readFile(files.source, 'utf8')).includes(edited.source[0]),
    );
    assert.ok(
      (await fs.readFile(files.target, 'utf8')).includes(edited.target[0]),
    );
    await expectPreview(scenario, edited);
    assert.equal(
      await page
        .locator('video')
        .evaluate((element) => element === window.__previewVideo),
      true,
      'Saving must not remount the player',
    );
    await back();
    tasks.push({ id, scenario, saved: edited });
  }
  assert.equal(
    await app.evaluate(() => globalThis.vttReads),
    0,
    'The preview must not read the SRT from disk',
  );
  checks.push(
    'Player tracks exist and match the editor for missing, partial and complete language metadata, with plain subtitle files and with a sidecar document',
    'Real keystrokes, undo, redo and source edits reach the real <track> cues and the active cue at the playhead without remounting the player or moving the playhead',
    'Saving keeps the preview, and the preview never reads the SRT through getSubtitleAsVtt',
  );

  // The reported flow: reopen the saved work after the app restarted.
  await app.close();
  await launch();
  for (const [index, { id, scenario, saved }] of tasks.entries()) {
    await openTask(id);
    await seekIntoFirstCue();
    await expectPreview(scenario, saved);
    await expect(page.locator('#subtitle-src-0')).toHaveValue(saved.source[0]);
    await expect(page.locator('#subtitle-tgt-0')).toHaveValue(saved.target[0]);
    await page.screenshot({
      path: path.join(output, `preview-restarted-${index}.png`),
    });
    await back();
  }
  assert.equal(await app.evaluate(() => globalThis.vttReads), 0);
  checks.push(
    'After restarting the app on the same profile every saved task still previews its saved subtitles',
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(
    consoleErrors.filter((message) => message.includes('[proofread]')),
    [],
  );
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks }));
} catch (error) {
  console.error({ output, checks, errors, consoleErrors });
  console.error((await page?.locator('body').innerText())?.slice(-5000));
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
}
