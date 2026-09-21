import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage, appOrigin } from './app-page.mjs';
import {
  summarizeCompositorTrace,
  hasCompleteSmoothWheelEvidence,
} from './compositor-trace.mjs';

const output = process.env.SMARTSUB_E2E_OUTPUT_DIR
  ? path.resolve(process.env.SMARTSUB_E2E_OUTPUT_DIR)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-keyboard-perf-e2e-'));
await fs.mkdir(output, { recursive: true });
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const complex = process.argv.includes('--complex');
const trace = process.argv.includes('--trace');
const traceCategories = [
  'devtools.timeline',
  'blink.user_timing',
  'cc',
  'benchmark',
  'viz',
  'input',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.frame',
];
assert.ok(
  !(trace && process.argv.includes('--profile')),
  'Collect compositor traces and sampling CPU profiles in separate runs',
);
const roles = path.join(output, 'five-hours.proofread.json');
const media = path.join(output, 'five-hours.flac');
const source = path.join(output, 'five-hours.en.srt');
const target = path.join(output, 'five-hours.fr.srt');
const stamp = (milliseconds) => {
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`;
};
const sentence = (prefix, index) =>
  `${prefix} ${index}. ${
    index === 9999
      ? 'Needle9999'
      : complex
        ? [
            '多语言访谈：精确时间轴与字幕校对。讲解者说明专业术语和背景。',
            '映画字幕と翻訳を確認します。長い文章と短い返事を混ぜます。',
            'مرحبا، نراجع الترجمة وتوقيت الحوار بدقة.',
            'A complete sentence with café, naïve, résumé and emoji 🎬.',
          ][index % 4] +
          (index % 7 === 0
            ? '\nA second subtitle line for varied heights.'
            : '')
        : 'A complete sentence for keyboard performance testing.'
  }`;
const srt = (prefix) =>
  Array.from(
    { length: 10000 },
    (_, index) =>
      `${index + 1}\n${stamp(index * 1800)} --> ${stamp(index * 1800 + 1600)}\n${sentence(prefix, index)}\n`,
  ).join('\n');
await fs.writeFile(source, srt('Original'));
await fs.writeFile(target, srt('Translation'));
if (complex)
  await fs.writeFile(
    roles,
    JSON.stringify({
      version: 2,
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        sourceFile: source,
        targetFile: target,
      },
      speakers: Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        displayName: `角色 Speaker ${index + 1}`,
        color: ['#2563eb', '#dc2626', '#16a34a', '#9333ea'][index % 4],
      })),
      cues: Array.from({ length: 10000 }, (_, index) => ({
        id: String(index + 1),
        startMs: index * 1800,
        endMs: index * 1800 + 1600,
        source: sentence('Original', index),
        target: sentence('Translation', index),
        speakerIds: index % 9 === 0 ? [1, 2] : [(index % 8) + 1],
        primarySpeakerId: index % 9 === 0 ? 1 : (index % 8) + 1,
      })),
    }),
  );
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=8000:duration=18000',
  '-af',
  "volume='if(lt(mod(t,10),7),0.25,0)':eval=frame",
  '-c:a',
  'flac',
  media,
]);
const launchOptions = {
  args: [
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
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
};
let app = await _electron.launch(launchOptions);
let page = await app.firstWindow();
page.setDefaultTimeout(20000);
const checks = [];
const metrics = {};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const unfocus = () => page.evaluate(() => document.activeElement?.blur());
const measureScroll = async (pixelsPerFrame) =>
  page.evaluate(async (pixelsPerFrame) => {
    const scroller =
      document.querySelector('[data-index]')?.parentElement?.parentElement;
    if (!scroller) throw new Error('Missing virtual list');
    const frames = [];
    let previous;
    let maxRows = 0;
    for (let index = 0; index < 180; index++) {
      scroller.scrollTop = index * pixelsPerFrame;
      // RAF timestamps measure callback cadence (a rendering proxy, not a
      // compositor trace). performance.now adds earlier callbacks' varying work.
      const now = await new Promise(requestAnimationFrame);
      if (previous !== undefined) frames.push(now - previous);
      previous = now;
      maxRows = Math.max(
        maxRows,
        scroller.querySelectorAll('[data-index]').length,
      );
    }
    const totalMs = frames.reduce((sum, value) => sum + value, 0);
    frames.sort((a, b) => a - b);
    return {
      maxRows,
      pixelsPerFrame,
      averageFps: (frames.length * 1000) / totalMs,
      medianMs: frames[Math.floor(frames.length / 2)],
      p95Ms: frames[Math.floor(frames.length * 0.95)],
      maxMs: frames.at(-1),
      over25Ms: frames.filter((value) => value > 25).length,
    };
  }, pixelsPerFrame);
try {
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  metrics.environment = await app.evaluate(
    async ({ app, screen, BrowserWindow }) => ({
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      display: screen.getDisplayMatching(
        BrowserWindow.getAllWindows()[0].getBounds(),
      ),
      gpuFeatures: app.getGPUFeatureStatus(),
    }),
  );
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, target, media, roles, complex }) => {
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Five hours and 10000 cues',
        items: [
          {
            videoPath: media,
            ...(complex ? { proofreadDataFile: roles } : {}),
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'fr',
          },
        ],
      });
      if (!task?.success) throw new Error(JSON.stringify(task));
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, target, media, roles, complex },
  );
  const start = performance.now();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  const timeline = page.getByRole('region', { name: '音频波形', exact: true });
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'true', {
    timeout: 120000,
  });
  metrics.mode =
    new URL(page.url()).protocol === 'app:' ? 'production' : 'development';
  metrics.loadMs = performance.now() - start;
  metrics.workload = complex
    ? '10000 multilingual multiline cues, 8 speakers with overlaps, 5h audio with silence intervals'
    : '10000 Latin cues, 5h audio with silence intervals';
  if (complex)
    await expect(
      page
        .getByRole('button', { name: '修改这条字幕的角色', exact: true })
        .first(),
    ).toBeVisible();
  if (complex) {
    const roleButton = page
      .locator('#subtitle-0')
      .getByRole('button', { name: '修改这条字幕的角色', exact: true });
    await roleButton.focus();
    await roleButton.press('Enter');
    await expect(
      page.getByRole('checkbox', {
        name: '切换 角色 Speaker 1 的字幕归属',
        exact: true,
      }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(roleButton).toBeFocused();
    await roleButton.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const secondSpeaker = page.getByRole('checkbox', {
      name: '切换 角色 Speaker 2 的字幕归属',
      exact: true,
    });
    await expect(secondSpeaker).toBeChecked();
    await secondSpeaker.locator('..').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(secondSpeaker).not.toBeChecked();
    await secondSpeaker.locator('..').click();
    await expect(secondSpeaker).toBeChecked();
    await page
      .getByRole('dialog')
      .getByText('分配角色', { exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await roleButton.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const warning = page.locator(
      '#subtitle-0 [data-cps-warning="true"] [aria-describedby]',
    );
    await warning.focus();
    await expect(page.locator('#subtitle-0 [role="tooltip"]')).toBeVisible();
    await unfocus();
    checks.push(
      'Lazy role popup preserves keyboard open/Escape focus, pointer toggle, and focusable CPS warning',
    );
  }
  assert.ok((await page.locator('[data-index]').count()) < 100);
  await page.locator('#subtitle-0').click({ position: { x: 4, y: 4 } });
  const original = await page.locator('#subtitle-src-0').inputValue();
  await page.locator('#subtitle-src-0').fill('First committed edit');
  await page.keyboard.press('Tab');
  await expect(page.locator('#subtitle-tgt-0')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#subtitle-src-0')).toBeFocused();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-src-1')).toBeFocused();
  await page.locator('#subtitle-src-1').fill('Second committed edit');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-src-2')).toBeFocused();
  await page.keyboard.press(`${modifier}+z`);
  await page.keyboard.press(`${modifier}+z`);
  await page.locator('#subtitle-0').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('#subtitle-src-0')).toHaveValue(original);
  await page.locator('#subtitle-src-0').focus();
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect(page.locator('#subtitle-src-0')).toHaveValue(
    'First committed edit',
  );
  await page.keyboard.press('Tab');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-tgt-1')).toBeFocused();
  checks.push(
    'Tab/Shift+Tab, Cmd/Ctrl+Enter source/translation focus, grouped undo and redo',
  );

  await page.locator('#subtitle-tgt-1').press('Space');
  assert.equal(
    await page.locator('audio[controls]').evaluate((audio) => audio.paused),
    true,
  );
  await unfocus();
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.locator('audio[controls]').evaluate((audio) => audio.paused),
    )
    .toBe(false);
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.locator('audio[controls]').evaluate((audio) => audio.paused),
    )
    .toBe(true);
  await page.locator('audio[controls]').evaluate((audio) => audio.play());
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.locator('audio[controls]').evaluate((audio) => audio.paused),
    )
    .toBe(true);
  checks.push(
    'Space input isolation, playback and native media state synchronization',
  );

  await page.locator('#subtitle-3').click({ position: { x: 4, y: 4 } });
  await page.locator('#subtitle-tgt-3').fill('');
  await page.locator('#subtitle-1').click({ position: { x: 4, y: 4 } });
  await page.getByRole('switch', { name: '只看失败' }).click();
  await page.locator('#subtitle-tgt-1').fill('Repaired translation');
  await page.locator('#subtitle-tgt-1').press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-tgt-3')).toBeFocused();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-tgt-3')).toBeFocused();
  await page.getByRole('switch', { name: '只看失败' }).click();
  checks.push(
    'Filtered Cmd/Ctrl+Enter after repairing pinned row, final visible row stays focused',
  );

  await page.locator('#subtitle-src-3').focus();
  await page.keyboard.press(`${modifier}+f`);
  const search = page.getByPlaceholder('输入搜索内容');
  await expect(search).toBeFocused();
  await search.pressSequentially('Needle9999');
  const searchStart = performance.now();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '下一处', exact: true }).click();
  await expect(page.locator('#subtitle-src-9999')).toBeVisible();
  metrics.searchToRowMs = performance.now() - searchStart;
  await search.fill('Native undo text');
  await search.pressSequentially('!');
  await search.press(`${modifier}+z`);
  await expect(search).not.toHaveValue('Native undo text!');
  const draftsBefore = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('smartsub_proofread_draft'))
      .map(([key, value]) => [key, value]),
  );
  await search.press(`${modifier}+s`);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith('smartsub_proofread_draft'))
        .map(([key, value]) => [key, value]),
    ),
    draftsBefore,
  );
  await search.press('Escape');
  await page.locator('#subtitle-src-9999').focus();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('#subtitle-src-9999')).toBeFocused();
  checks.push(
    'Search reaches offscreen final cue, search native undo, overlay blocks save, last-row commit',
  );

  await page.evaluate(() => {
    window.__editTimings = [];
    window.__storageTimings = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      const start = performance.now();
      try {
        return setItem.call(this, key, value);
      } finally {
        if (key.startsWith('smartsub_proofread_draft'))
          window.__storageTimings.push({
            ms: performance.now() - start,
            characters: value.length,
          });
      }
    };
    document.addEventListener(
      'input',
      (event) => {
        if (!event.target.matches('[data-subtitle-editor]')) return;
        const start = performance.now();
        requestAnimationFrame(() =>
          window.__editTimings.push(performance.now() - start),
        );
      },
      true,
    );
  });
  await page.locator('#subtitle-src-9999').press('End');
  await page
    .locator('#subtitle-src-9999')
    .pressSequentially(' thirty keyboard events measured', { delay: 35 });
  metrics.typing = await page.evaluate(() => {
    const values = window.__editTimings.sort((a, b) => a - b);
    return {
      count: values.length,
      medianMs: values[Math.floor(values.length / 2)],
      p95Ms: values[Math.floor(values.length * 0.95)],
      maxMs: values.at(-1),
      storageMaxMs: Math.max(
        ...window.__storageTimings.map((entry) => entry.ms),
      ),
      storageMaxCharacters: Math.max(
        ...window.__storageTimings.map((entry) => entry.characters),
      ),
    };
  });
  await unfocus();
  if (complex) {
    // Deterministic service boundary; exercise real batch state and row Diff UI.
    // Leave 50 reviewed results while canceling the remaining loading rows.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('getAiTranslationProviders');
      ipcMain.handle('getAiTranslationProviders', () => ({
        success: true,
        data: [
          {
            id: 'performance-ai',
            name: 'Performance fixture',
            type: 'openai',
            isAi: true,
            apiUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'fixture',
            modelName: 'fixture',
          },
        ],
      }));
      ipcMain.removeHandler('batchOptimizeSubtitles');
      ipcMain.handle(
        'batchOptimizeSubtitles',
        (event, payload) =>
          new Promise((resolve) => {
            globalThis.performanceAiResolve = resolve;
            for (const cue of payload.subtitles.slice(0, 50))
              event.sender.send('batchOptimizeResult', {
                batchId: payload.batchId,
                index: cue.index,
                status: 'success',
                optimizedTarget: `精简建议 ${cue.index} · Edited subtitle.`,
              });
          }),
      );
    });
    const toolbar = page.locator('[data-ai-toolbar]');
    await toolbar
      .getByRole('button', { name: 'AI 润色配置', exact: true })
      .click();
    await page.keyboard.press('Escape');
    const start = performance.now();
    await toolbar
      .getByRole('button', { name: '全文 AI 优化', exact: true })
      .click();
    await expect(
      toolbar.getByRole('button', { name: '取消', exact: true }),
    ).toBeVisible();
    await toolbar.getByRole('button', { name: '取消', exact: true }).click();
    await app.evaluate(() =>
      globalThis.performanceAiResolve({ success: true, data: { results: [] } }),
    );
    metrics.batchPrepareAndCancelMs = performance.now() - start;
    const scroller = page
      .locator('[data-index]')
      .first()
      .locator('..')
      .locator('..');
    await scroller.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(
      page.locator('#subtitle-0 [data-ai-review="ready"]'),
    ).toBeVisible();
    checks.push(
      '50 multilingual AI Diff rows retained after cancelling the remaining batch in a 10000-cue project',
    );
  }
  const profiler = process.argv.includes('--profile')
    ? await page.context().newCDPSession(page)
    : null;
  const input = trace ? await page.context().newCDPSession(page) : null;
  if (profiler) await profiler.send('Profiler.enable');
  const assertRowGeometry = async () => {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const rows = [...document.querySelectorAll('[data-index]')];
            return rows.every((row, index) => {
              const rect = row.getBoundingClientRect();
              const next = rows[index + 1]?.getBoundingClientRect();
              return (
                rect.height > 0 &&
                (!next || Math.abs(rect.bottom - next.top) <= 1) &&
                (row.dataset.compact !== 'true' ||
                  Math.abs(rect.height - 40) <= 1)
              );
            });
          }),
        { message: 'Measured rows are contiguous after height changes' },
      )
      .toBe(true);
  };
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((window) => /^(http:|app:)/.test(window.webContents.getURL()))
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
    await assertRowGeometry();
    await page.getByRole('button', { name: '展开全部', exact: true }).click();
    await assertRowGeometry();
    await page.getByRole('button', { name: '大', exact: true }).click();
    await assertRowGeometry();
    await page.getByRole('button', { name: '收起全部', exact: true }).click();
    await assertRowGeometry();
    await page.getByRole('button', { name: '中', exact: true }).click();
    await assertRowGeometry();
    if (trace)
      await app.evaluate(
        ({ contentTracing }, categories) =>
          contentTracing.startRecording({ included_categories: categories }),
        traceCategories,
      );
    await page.evaluate(() => performance.mark('smartsub:idle:start'));
    metrics[`idle${width}`] = await measureScroll(0);
    await page.evaluate(() => performance.mark('smartsub:idle:end'));
    if (profiler) await profiler.send('Profiler.start');
    await page.evaluate(() => performance.mark('smartsub:scroll:start'));
    metrics[`scroll${width}`] = await measureScroll(120);
    await page.evaluate(() => performance.mark('smartsub:scroll:end'));
    await page.evaluate(() => performance.mark('smartsub:stress:start'));
    metrics[`stressScroll${width}`] = await measureScroll(600);
    await page.evaluate(() => performance.mark('smartsub:stress:end'));
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      await fs.writeFile(
        path.join(output, `scroll-${width}.cpuprofile`),
        JSON.stringify(profile),
      );
    }
    if (input) {
      for (const [label, offset] of [
        ['wheelDiff', 0],
        ['wheelCompact', 50000],
      ]) {
        const point = await page.evaluate(async (offset) => {
          const scroller =
            document.querySelector('[data-index]').parentElement.parentElement;
          scroller.scrollTop = offset;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const rect = scroller.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }, offset);
        await page.evaluate(
          (label) => performance.mark(`smartsub:${label}:start`),
          label,
        );
        await input.send('Input.synthesizeScrollGesture', {
          ...point,
          yDistance: -9000,
          speed: 3000,
          gestureSourceType: 'mouse',
          preventFling: true,
        });
        await page.evaluate(
          (label) => performance.mark(`smartsub:${label}:end`),
          label,
        );
        metrics[`${label}${width}`] = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-index]')];
          const scroller = rows[0].parentElement.parentElement;
          const viewport = scroller.getBoundingClientRect();
          const rectangles = rows.map((row) => row.getBoundingClientRect());
          return {
            scrollTop: scroller.scrollTop,
            mountedRows: rows.length,
            coversViewport:
              Math.min(...rectangles.map((rect) => rect.top)) <=
                viewport.top + 1 &&
              Math.max(...rectangles.map((rect) => rect.bottom)) >=
                viewport.bottom - 1,
          };
        });
        assert.ok(
          metrics[`${label}${width}`].scrollTop >= offset + 8900,
          'native wheel reaches requested distance',
        );
        assert.ok(
          metrics[`${label}${width}`].coversViewport,
          'virtual rows cover the viewport after native scrolling',
        );
        await assertRowGeometry();
      }
    }
    if (trace) {
      await app.evaluate(
        ({ contentTracing }, file) => contentTracing.stopRecording(file),
        path.join(output, `scroll-${width}.trace.json`),
      );
      const summary = summarizeCompositorTrace(
        JSON.parse(
          await fs.readFile(
            path.join(output, `scroll-${width}.trace.json`),
            'utf8',
          ),
        ),
      );
      metrics[`compositor${width}`] = summary;
      metrics[`wheelSmooth${width}`] = ['wheelDiff', 'wheelCompact'].every(
        (phase) => hasCompleteSmoothWheelEvidence(summary, phase),
      );
      await fs.writeFile(
        path.join(output, `scroll-${width}.summary.json`),
        JSON.stringify(summary, null, 2),
      );
    }
    assert.ok(
      metrics[`scroll${width}`].maxRows < 100,
      'mounted rows remain bounded',
    );
    if (complex) {
      const widths = await page
        .locator('[data-index] > div')
        .evaluateAll((rows) =>
          rows
            .map((row) => {
              const text = row.querySelector(':scope > span.flex-1');
              return text ? text.getBoundingClientRect().width : null;
            })
            .filter((value) => value !== null),
        );
      assert.ok(
        widths.every((value) => value >= 40),
        'role badges leave room for subtitle text at the minimum window size',
      );
    }
    await page.screenshot({ path: path.join(output, `keyboard-${width}.png`) });
  }
  await page.keyboard.press(`${modifier}+b`);
  await expect(timeline).toHaveCount(0);
  await page.keyboard.press(`${modifier}+b`);
  await expect(timeline).toHaveAttribute('data-waveform-ready', 'true');
  metrics.heap = await page.evaluate(() =>
    performance.memory
      ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
        }
      : null,
  );
  checks.push(
    '10000 rows / 5-hour real media, bounded DOM, both viewports, panel remount',
  );
  const url = new URL(page.url()).pathname + new URL(page.url()).search;
  const appProcess = app.process();
  const exited = once(appProcess, 'exit');
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F']);
  else appProcess.kill('SIGKILL');
  await exited;
  app = null;
  app = await _electron.launch(launchOptions);
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  await page.evaluate((url) => window.next.router.push(url), url);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await unfocus();
  await page.keyboard.press(`${modifier}+f`);
  const recoveredSearch = page.getByPlaceholder('输入搜索内容');
  await recoveredSearch.fill('thirty keyboard events measured');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '下一处', exact: true }).click();
  await recoveredSearch.press('Escape');
  await expect(page.locator('#subtitle-src-9999')).toHaveValue(
    /thirty keyboard events measured/,
  );
  await page.locator('#subtitle-src-9999').focus();
  checks.push(
    'Whole-app SIGKILL and atomic draft recovery preserve the latest final-row keystroke',
  );
  await page.keyboard.press(`${modifier}+s`);
  await expect(
    page.getByRole('status').filter({ hasText: '已保存' }),
  ).toBeVisible();
  assert.ok(
    (await fs.readFile(source, 'utf8')).includes(
      'thirty keyboard events measured',
    ),
  );
  assert.deepEqual(errors, []);
  await page.goto('about:blank');
  metrics.blankWindow = await page.evaluate(async () => {
    const timestamps = [];
    for (let index = 0; index < 180; index++)
      timestamps.push(await new Promise(requestAnimationFrame));
    const frames = timestamps
      .slice(1)
      .map((time, index) => time - timestamps[index]);
    const averageFps =
      (frames.length * 1000) / frames.reduce((sum, value) => sum + value, 0);
    frames.sort((a, b) => a - b);
    return {
      averageFps,
      p95Ms: frames[Math.floor(frames.length * 0.95)],
      maxMs: frames.at(-1),
    };
  });
  if (trace) {
    const controlInput = await page.context().newCDPSession(page);
    for (const [width, height] of [
      [1024, 700],
      [1440, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(...size),
        [width, height],
      );
      await page.setContent(
        '<style>body{margin:0}.track{height:400000px;background:repeating-linear-gradient(#fff 0 39px,#888 39px 40px)}</style><div class="track"></div>',
      );
      await page.evaluate(async () => {
        scrollTo(0, 0);
        for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      });
      await app.evaluate(
        ({ contentTracing }, categories) =>
          contentTracing.startRecording({ included_categories: categories }),
        traceCategories,
      );
      await page.evaluate(() =>
        performance.mark('smartsub:controlWheel:start'),
      );
      await controlInput.send('Input.synthesizeScrollGesture', {
        x: width / 2,
        y: height / 2,
        yDistance: -9000,
        speed: 3000,
        gestureSourceType: 'mouse',
        preventFling: true,
      });
      await page.evaluate(() => performance.mark('smartsub:controlWheel:end'));
      assert.ok(await page.evaluate(() => scrollY >= 8900));
      const file = path.join(output, `control-${width}.trace.json`);
      await app.evaluate(
        ({ contentTracing }, file) => contentTracing.stopRecording(file),
        file,
      );
      const summary = summarizeCompositorTrace(
        JSON.parse(await fs.readFile(file, 'utf8')),
      );
      metrics[`controlCompositor${width}`] = summary;
      metrics[`controlWheelSmooth${width}`] = hasCompleteSmoothWheelEvidence(
        summary,
        'controlWheel',
      );
      await fs.writeFile(
        path.join(output, `control-${width}.summary.json`),
        JSON.stringify(summary, null, 2),
      );
    }
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ checks, metrics }, null, 2),
  );
  console.log(JSON.stringify({ success: true, output, checks, metrics }));
} catch (error) {
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        checks,
        metrics,
        errors,
        failure: error.stack || String(error),
      },
      null,
      2,
    ),
  );
  console.error(JSON.stringify({ output, checks, metrics, errors }));
  console.error(
    'Row geometry',
    await page
      .locator('[data-index]')
      .evaluateAll((rows) =>
        rows.map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            index: row.dataset.index,
            compact: row.dataset.compact,
            top: rect.top,
            height: rect.height,
            transform: row.style.transform,
          };
        }),
      )
      .catch(() => []),
  );
  console.error(error);
  console.error(
    (
      await page
        .locator('body')
        .innerText()
        .catch(() => 'Renderer unavailable')
    ).slice(-5000),
  );
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
}
