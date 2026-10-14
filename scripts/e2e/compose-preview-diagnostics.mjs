/**
 * 预览黑屏诊断（诊断安装包）的端到端验证。
 *
 * 需要先 `node scripts/diag/patch-jassub.mjs` 再 `yarn build`（与诊断安装包的构建方式一致），
 * 然后：node scripts/e2e/compose-preview-diagnostics.mjs --production
 *
 * 验证四件事：
 *  A. 没有开诊断时（正式版）完全惰性：没有面板、没有日志、没有目录，行为与 3.9.0 相同；
 *  B. 开了诊断：默认开关 = 3.9.0；每个实验开关真的改变了它声称要改的东西；
 *     取证（标记 / 快照 / 追踪 / 导出）真的产出可用的文件；
 *  C. 「GPU 启动参数」写入后，下次启动真的被应用；
 *  D. JASSUB 补丁：diag 选项一路传到 worker，上下文属性被回报。
 */
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

// CI 里用 SMARTSUB_E2E_OUTPUT 指定输出目录，失败时整个现场（日志、截图、追踪）一起上传
const output = process.env.SMARTSUB_E2E_OUTPUT
  ? await fs
      .mkdir(path.resolve(process.env.SMARTSUB_E2E_OUTPUT), { recursive: true })
      .then(() => path.resolve(process.env.SMARTSUB_E2E_OUTPUT))
  : await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-preview-diag-e2e-'));
const media = path.join(output, 'diag.mp4');
const subtitle = path.join(output, 'diag.srt');
// 彩色测试图（不是黑场）：合成器层的亮度判断需要真实画面。
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=640x360:r=25:d=6',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  media,
]);
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:06,000\nSmartSub Diag 123\n',
);

const DEFAULT_FLAGS = {
  disableJassub: false,
  jassubHideCanvas: false,
  boundsReadback: true,
  jassubDesync: 'unchanged',
  jassubPower: 'unchanged',
  jassubRenderer: 'auto',
  subtitleLayer: true,
  handleMode: 'hover',
  ancestorFilter: false,
  roundedClip: false,
  noHoverScrollbar: false,
  marker: false,
};

const checks = [];
const apps = [];

async function launch({ diag, profile, firstRun = true }) {
  const env = {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  };
  delete env.SMARTSUB_PREVIEW_DIAG;
  if (diag) env.SMARTSUB_PREVIEW_DIAG = '1';
  const app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'confirm') void dialog.accept().catch(() => {});
    else if (dialog.type() !== 'beforeunload')
      void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(20000);
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog, shell }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    // 测试里不要真的去打开文件管理器
    shell.showItemInFolder = () => {};
    shell.openPath = async () => '';
  });
  // 同一个 profile 第二次启动时，新手引导已经被跳过
  if (firstRun)
    await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    ({ media, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { media, subtitle },
  );
  await expect(page.locator('[data-subtitle-drag]')).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  return { app, page };
}

/** 正常关闭；卡住就强杀，避免测试挂起。 */
async function closeApp(app) {
  const closed = app.close().then(
    () => true,
    () => true,
  );
  const timedOut = new Promise((resolve) => setTimeout(resolve, 15000, false));
  if (!(await Promise.race([closed, timedOut]))) app.process().kill('SIGKILL');
}

const diagDir = (profile) => path.join(profile, 'preview-diagnostics');

async function readEvents(profile) {
  const text = await fs
    .readFile(path.join(diagDir(profile), 'events.ndjson'), 'utf8')
    .catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: 'unparsable', line };
      }
    });
}

/** 把渲染进程缓冲的日志推到主进程，再等某个事件出现。 */
async function waitForEvent(page, profile, predicate, label) {
  let found;
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__previewDiag.flush());
        found = (await readEvents(profile)).find(predicate);
        return Boolean(found);
      },
      { message: `event: ${label}`, timeout: 15000 },
    )
    .toBe(true);
  return found;
}

async function filesIn(dir, suffix) {
  return (await fs.readdir(dir).catch(() => [])).filter((name) =>
    name.endsWith(suffix),
  );
}

/**
 * 读取 zip（诊断包由 yazl 写出，只会有 stored / deflate 条目）。
 * 纯 Node 实现：Windows 的 git-bash 里没有可靠的 unzip，也不该依赖它。
 */
function readZip(file) {
  const buffer = fsSync.readFileSync(file);
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const hudText = (page) => page.locator('[data-diag-hud]').innerText();

try {
  // ───────────────────────── A. 正式版：诊断完全惰性 ─────────────────────────
  {
    const profile = path.join(output, 'profile-normal');
    const { app, page } = await launch({ diag: false, profile });
    const canvas = page.locator('[data-video-canvas]');
    await expect(canvas).toBeVisible();
    await canvas.hover();
    await page.mouse.move(40, 300);
    assert.equal(await page.locator('[data-diag-hud]').count(), 0);
    assert.equal(
      await page.evaluate(() => typeof window.__previewDiag),
      'undefined',
    );
    assert.deepEqual(
      await page.evaluate(() => window.ipc.invoke('previewDiag:info')),
      { enabled: false },
    );
    assert.equal(
      await page.evaluate(() =>
        window.ipc.invoke('previewDiag:log', [{ type: 'x' }]),
      ),
      false,
    );
    for (const channel of [
      'previewDiag:snapshot',
      'previewDiag:export',
      'previewDiag:setPreset',
    ]) {
      const result = await page.evaluate(
        (name) => window.ipc.invoke(name, 'default'),
        channel,
      );
      assert.equal(result?.ok, false, `${channel} must refuse when disabled`);
    }
    assert.ok(
      !((await canvas.getAttribute('class')) ?? '').includes('rounded-lg'),
      'default container is not rounded (3.9.0)',
    );
    assert.ok(!/filter/.test((await canvas.getAttribute('style')) ?? ''));
    assert.equal(await page.locator('html.diag-no-hover-scrollbar').count(), 0);
    assert.equal(await page.locator('[data-diag-marker]').count(), 0);
    await expect(page.locator('[data-video-canvas] canvas')).toBeVisible();
    await assert.rejects(
      fs.access(diagDir(profile)),
      'normal build must not create the diagnostics directory',
    );
    await closeApp(app);
    apps.pop();
    checks.push(
      'A: normal build is inert (no HUD, no window hook, IPC refuses, no files) and keeps 3.9.0 structure',
    );
  }

  // ───────────────────────── B. 诊断模式 ─────────────────────────
  const profile = path.join(output, 'profile-diag');
  {
    const { app, page } = await launch({ diag: true, profile });
    const hud = page.locator('[data-diag-hud]');
    const canvas = page.locator('[data-video-canvas]');
    const drag = page.locator('[data-subtitle-drag]');
    const flag = (name) => page.locator(`[data-diag-flag="${name}"]`);
    const jassubCanvas = page.locator('[data-video-canvas] canvas');
    const getFlags = () => page.evaluate(() => window.__previewDiag.getFlags());

    await expect(hud).toBeVisible();
    await expect(hud).toContainText('预览黑屏诊断');
    assert.deepEqual(await getFlags(), DEFAULT_FLAGS);
    assert.ok(
      !((await canvas.getAttribute('class')) ?? '').includes('rounded-lg'),
    );
    assert.ok(!/filter/.test((await canvas.getAttribute('style')) ?? ''));
    await expect(jassubCanvas).toBeVisible();
    checks.push('B1: HUD shows; default flags equal 3.9.0 structure');

    // 指针区域转换被记录
    await canvas.hover();
    await page.getByRole('button', { name: '高级设置', exact: true }).hover();
    await hud.hover();
    await waitForEvent(
      page,
      profile,
      (event) => event.type === 'pointer' && event.to === 'inspector',
      'pointer → inspector',
    );
    await waitForEvent(
      page,
      profile,
      (event) => event.type === 'pointer' && event.to === 'hud',
      'pointer → hud',
    );
    await waitForEvent(
      page,
      profile,
      (event) => event.type === 'video-attach',
      'video attach',
    );
    await waitForEvent(
      page,
      profile,
      (event) => event.type === 'jassub' && event.ev === 'context',
      'jassub context report',
    );
    checks.push(
      'B2: pointer-region transitions, video attach and JASSUB context report are logged',
    );

    // 取证：先记录「正常」基线，再记录「黑屏」
    await canvas.hover();
    await page.keyboard.press('F9');
    await expect(hud).toContainText('最近一次：正常');
    await page.getByRole('button', { name: /现在是黑屏/ }).click();
    await expect(hud).toContainText('最近一次：黑屏');
    const text = await hudText(page);
    assert.match(text, /合成器层：暗像素 \d+%，平均亮度 \d+/);
    assert.match(text, /初判：/);
    const osLine = /系统层（肉眼所见）：([^\n]*)/.exec(text)?.[1] ?? '';
    if (process.platform === 'win32') {
      // CI 的 runner 没有真显示器：系统层能不能取到本身就是要记录的信息，不作为通过条件
      checks.push(`B3-os: system-layer capture on win32 → ${osLine}`);
    } else {
      assert.match(osLine, /未取到/);
    }
    const captures = await filesIn(
      path.join(diagDir(profile), 'captures'),
      '.png',
    );
    assert.ok(captures.some((name) => name.endsWith('-black-viz.png')));
    assert.ok(captures.some((name) => name.endsWith('-normal-viz.png')));
    const png = await fs.readFile(
      path.join(diagDir(profile), 'captures', captures[0]),
    );
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 2000, 'capture is a real image');
    const probe = await waitForEvent(
      page,
      profile,
      (event) => event.type === 'probe' && event.label === 'black',
      'probe event',
    );
    assert.ok(
      probe.viz.ok && probe.viz.video.mean > 15,
      'viz saw real content',
    );
    assert.ok(probe.baseline, 'baseline from the normal reading was applied');
    await waitForEvent(page, profile, (event) => event.type === 'mark', 'mark');
    checks.push(
      `B3: F9 baseline + black mark produce probe, PNG captures and verdict (viz mean=${probe.viz.video.mean}, dark=${probe.viz.video.darkRatio})`,
    );

    // 实验开关：每一个都要真的改变它声称要改的东西
    await flag('ancestorFilter').check();
    await expect(canvas).toHaveCSS('filter', 'opacity(0.999)');
    await flag('ancestorFilter').uncheck();
    assert.ok(!/filter/.test((await canvas.getAttribute('style')) ?? ''));

    await flag('roundedClip').check();
    await expect(canvas).toHaveClass(/rounded-lg/);
    await flag('roundedClip').uncheck();
    await expect(canvas).not.toHaveClass(/rounded-lg/);

    await flag('noHoverScrollbar').check();
    await expect(page.locator('html.diag-no-hover-scrollbar')).toHaveCount(1);
    await flag('noHoverScrollbar').uncheck();
    await expect(page.locator('html.diag-no-hover-scrollbar')).toHaveCount(0);

    await flag('marker').check();
    await expect(page.locator('[data-diag-marker]')).toBeVisible();
    const first = await page.locator('[data-diag-marker]').innerText();
    await expect
      .poll(() => page.locator('[data-diag-marker]').innerText())
      .not.toBe(first);
    await flag('marker').uncheck();
    await expect(page.locator('[data-diag-marker]')).toHaveCount(0);

    // 手柄：hover(默认)只在悬停时出现；pinned 常显；hidden 不渲染
    await hud.hover();
    await expect(drag).toHaveCSS('opacity', '0');
    await flag('handleMode').selectOption('pinned');
    await expect(drag).toHaveCSS('opacity', '1');
    await flag('handleMode').selectOption('hidden');
    await expect(drag).toHaveCount(0);
    await flag('handleMode').selectOption('hover');
    await expect(drag).toHaveCount(1);

    // 字幕层整个不挂载
    await flag('subtitleLayer').uncheck();
    await expect(drag).toHaveCount(0);
    await flag('subtitleLayer').check();
    await expect(drag).toHaveCount(1);

    // 隐藏 JASSUB 画布（引擎仍在运行）
    await flag('jassubHideCanvas').check();
    await expect(jassubCanvas).toHaveCSS('display', 'none');
    assert.equal(
      await page.evaluate(() => Boolean(window.__jassubPreview)),
      true,
      'engine keeps running while its canvas is hidden',
    );
    await flag('jassubHideCanvas').uncheck();
    await expect(jassubCanvas).not.toHaveCSS('display', 'none');

    // 完全不使用 JASSUB
    await flag('disableJassub').check();
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(false);
    await expect(jassubCanvas).toHaveCount(0);
    await flag('disableJassub').uncheck();
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    await expect(jassubCanvas).toBeVisible();
    checks.push(
      'B4: filter / rounded clip / hover-scrollbar / marker / handle modes / subtitle layer / hide canvas / disable JASSUB all take effect and revert',
    );

    // 回读开关：统计 getImageData 调用次数（回读循环每 ≥100ms 一次）
    await page.evaluate(() => {
      const proto = CanvasRenderingContext2D.prototype;
      if (!proto.__diagWrapped) {
        const original = proto.getImageData;
        window.__readbacks = 0;
        proto.getImageData = function (...args) {
          window.__readbacks += 1;
          return original.apply(this, args);
        };
        proto.__diagWrapped = true;
      }
      window.__readbacks = 0;
    });
    await expect
      .poll(() => page.evaluate(() => window.__readbacks), { timeout: 5000 })
      .toBeGreaterThan(3);
    await flag('boundsReadback').uncheck();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__readbacks = 0;
    });
    await page.waitForTimeout(1500);
    assert.equal(
      await page.evaluate(() => window.__readbacks),
      0,
      'no GPU→CPU readback while the flag is off',
    );
    await flag('boundsReadback').check();
    await expect
      .poll(() => page.evaluate(() => window.__readbacks), { timeout: 5000 })
      .toBeGreaterThan(3);
    checks.push('B5: bounds-readback flag really stops/starts getImageData');

    // JASSUB 补丁：diag 选项一路传到 worker，真实上下文属性被回报
    const contextEvents = async () =>
      (await readEvents(profile)).filter(
        (event) => event.type === 'jassub' && event.ev === 'context',
      );
    const before = (await contextEvents()).length;
    await flag('jassubDesync').selectOption('false');
    const desync = await waitForEvent(
      page,
      profile,
      (event) =>
        event.type === 'jassub' &&
        event.ev === 'context' &&
        event.requested?.desynchronized === false,
      'context with desynchronized:false requested',
    );
    assert.ok((await contextEvents()).length > before, 'JASSUB was rebuilt');
    assert.ok(desync.attributes, 'real context attributes are reported');
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    await flag('jassubDesync').selectOption('unchanged');

    await flag('jassubRenderer').selectOption('2d');
    const twoD = await waitForEvent(
      page,
      profile,
      (event) =>
        event.type === 'jassub' &&
        event.ev === 'context' &&
        event.requested?.renderer === '2d',
      'context with 2d renderer requested',
    );
    assert.equal(twoD.backend, '2d');
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    await flag('jassubRenderer').selectOption('webgl1');
    const gl1 = await waitForEvent(
      page,
      profile,
      (event) =>
        event.type === 'jassub' &&
        event.ev === 'context' &&
        event.requested?.renderer === 'webgl1',
      'context with webgl1 requested',
    );
    assert.equal(gl1.backend, 'webgl1');
    await flag('jassubRenderer').selectOption('auto');

    await flag('jassubPower').selectOption('low-power');
    await waitForEvent(
      page,
      profile,
      (event) =>
        event.type === 'jassub' &&
        event.ev === 'context' &&
        event.requested?.powerPreference === 'low-power',
      'context with low-power requested',
    );
    await flag('jassubPower').selectOption('unchanged');
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    // 回到默认后，请求里不再带任何 diag 选项
    const lastContext = (await contextEvents()).at(-1);
    await expect
      .poll(async () => (await contextEvents()).at(-1)?.requested)
      .toEqual({});
    assert.ok(lastContext);
    checks.push(
      `B6: diag options reach the JASSUB worker (desync/power/renderer), backend reported (${gl1.backend}/${twoD.backend}), defaults send nothing`,
    );

    // 全部缓解 / 还原默认
    await page.getByRole('button', { name: '全部缓解', exact: true }).click();
    await expect(canvas).toHaveCSS('filter', 'opacity(0.999)');
    await expect(canvas).toHaveClass(/rounded-lg/);
    await expect(drag).toHaveCount(0);
    await expect(page.locator('html.diag-no-hover-scrollbar')).toHaveCount(1);
    assert.equal((await getFlags()).boundsReadback, false);
    assert.equal((await getFlags()).jassubDesync, 'false');
    await page.getByRole('button', { name: '还原默认', exact: true }).click();
    assert.deepEqual(await getFlags(), DEFAULT_FLAGS);
    await expect(drag).toHaveCount(1);
    await expect(canvas).not.toHaveClass(/rounded-lg/);
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
      .toBe(true);
    const flagEvents = (
      await (async () => {
        await page.evaluate(() => window.__previewDiag.flush());
        return readEvents(profile);
      })()
    ).filter((event) => event.type === 'flags');
    assert.ok(flagEvents.some((event) => event.reason === 'mitigate-all'));
    checks.push(
      'B7: mitigate-all flips every suspect at once; reset restores 3.9.0',
    );

    // 环境快照
    await page.getByRole('button', { name: '环境快照', exact: true }).click();
    await expect(hud.getByRole('status')).toContainText('环境快照已保存');
    const snapshotFiles = await filesIn(
      path.join(diagDir(profile), 'snapshots'),
      '.json',
    );
    assert.equal(snapshotFiles.length, 1);
    const snapshot = JSON.parse(
      await fs.readFile(
        path.join(diagDir(profile), 'snapshots', snapshotFiles[0]),
        'utf8',
      ),
    );
    assert.ok(snapshot.versions?.electron);
    assert.ok(
      snapshot.gpuFeatureStatus &&
        typeof snapshot.gpuFeatureStatus === 'object',
    );
    assert.ok(snapshot.hardware || snapshot.os, 'hardware/os sections present');
    assert.ok(Array.isArray(snapshot.displays), 'displays listed');
    assert.ok(snapshot.commandLine?.switches, 'watched switches recorded');
    checks.push('B8: environment snapshot is written and parseable');

    // 6 秒追踪：期间移动鼠标产生 pointer 标记，追踪里要能找到页面里打的 user timing 标记
    await page.getByRole('button', { name: /录制 6 秒追踪/ }).click();
    await expect(hud.getByRole('status')).toContainText('追踪录制中');
    for (let i = 0; i < 5; i += 1) {
      await canvas.hover();
      await hud.hover();
      await page.waitForTimeout(450);
    }
    await expect(hud.getByRole('status')).toContainText('追踪已保存', {
      timeout: 20000,
    });
    const traceFiles = await filesIn(
      path.join(diagDir(profile), 'traces'),
      '.json.gz',
    );
    assert.equal(traceFiles.length, 1);
    const trace = JSON.parse(
      zlib
        .gunzipSync(
          await fs.readFile(
            path.join(diagDir(profile), 'traces', traceFiles[0]),
          ),
        )
        .toString('utf8'),
    );
    const traceEvents = Array.isArray(trace) ? trace : trace.traceEvents;
    assert.ok(traceEvents.length > 1000, 'trace has content');
    assert.ok(
      traceEvents.some((event) => event.name === 'smartsub:trace:start'),
      'page user-timing mark is aligned into the trace',
    );
    assert.ok(
      traceEvents.some((event) => /^smartsub:pointer:/.test(event.name)),
      'pointer-region marks are in the trace',
    );
    checks.push(
      `B9: 6s trace saved (${traceEvents.length} events) and contains smartsub:* marks`,
    );

    // 导出诊断包
    const zip = path.join(output, 'diag-export.zip');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
      });
    }, zip);
    await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
    await expect(hud.getByRole('status')).toContainText('诊断包已导出');
    const zipEntries = readZip(zip);
    const entries = [...zipEntries.keys()];
    for (const wanted of ['README.txt', 'events.ndjson'])
      assert.ok(entries.includes(wanted), `zip has ${wanted}`);
    assert.ok(entries.some((name) => /^snapshots\/.+\.json$/.test(name)));
    assert.ok(entries.some((name) => /^captures\/.+\.png$/.test(name)));
    assert.ok(entries.some((name) => /^traces\/.+\.json\.gz$/.test(name)));
    const exportedEvents = zipEntries.get('events.ndjson').toString('utf8');
    assert.ok(exportedEvents.includes('"type":"probe"'));
    // 用户目录、媒体文件名都不能出现在导出的日志里
    for (const secret of [os.homedir(), 'diag.mp4', 'diag.srt']) {
      assert.ok(
        !exportedEvents.includes(secret),
        `exported events must not contain ${secret}`,
      );
    }
    checks.push(
      `B10: export zip has README/events/snapshots/captures/traces (${entries.length} entries) and is redacted`,
    );

    // GPU 启动参数：写文件、不真的重启
    await app.evaluate(({ app }) => {
      globalThis.__originalAppMethods = {
        relaunch: app.relaunch,
        quit: app.quit,
      };
      app.relaunch = () => {};
      app.quit = () => {};
    });
    await page.locator('[data-diag-preset]').selectOption('no-gpu-compositing');
    await page.getByRole('button', { name: '应用并重启', exact: true }).click();
    await expect(hud.getByRole('status')).toContainText('正在重启');
    const presetFile = JSON.parse(
      await fs.readFile(path.join(diagDir(profile), 'gpu-preset.json'), 'utf8'),
    );
    assert.equal(presetFile.presetId, 'no-gpu-compositing');
    assert.equal(
      (await page.evaluate(() => window.ipc.invoke('previewDiag:info')))
        .pendingPresetId,
      'no-gpu-compositing',
    );
    await app.evaluate(({ app }) => {
      // 还原，否则 Playwright 的 app.close() 会因为 quit 被换成空函数而卡住
      app.relaunch = globalThis.__originalAppMethods.relaunch;
      app.quit = globalThis.__originalAppMethods.quit;
    });
    checks.push('B11: GPU preset is persisted for the next launch');

    await closeApp(app);
    apps.pop();
  }

  // ───────────────────────── C. 下次启动应用 GPU 预设 ─────────────────────────
  {
    const { app, page } = await launch({
      diag: true,
      profile,
      firstRun: false,
    });
    const info = await page.evaluate(() =>
      window.ipc.invoke('previewDiag:info'),
    );
    assert.equal(info.appliedPresetId, 'no-gpu-compositing');
    assert.equal(
      await app.evaluate(({ app }) =>
        app.commandLine.hasSwitch('disable-gpu-compositing'),
      ),
      true,
    );
    await expect(page.locator('[data-video-canvas] canvas')).toBeVisible();
    await expect(page.locator('[data-diag-hud]')).toContainText(
      '当前：软件合成',
    );
    const events = await readEvents(profile);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'session-start' &&
          event.presetId === 'no-gpu-compositing',
      ),
    );
    await closeApp(app);
    apps.pop();

    // list 型开关要与已有取值合并，而不是覆盖
    await fs.writeFile(
      path.join(diagDir(profile), 'gpu-preset.json'),
      JSON.stringify({ presetId: 'no-sw-overlays' }),
    );
    const second = await launch({ diag: true, profile, firstRun: false });
    const features = await second.app.evaluate(({ app }) =>
      app.commandLine.getSwitchValue('disable-features'),
    );
    assert.match(features, /DirectCompositionSoftwareOverlays/);
    assert.equal(
      await second.app.evaluate(({ app }) =>
        app.commandLine.hasSwitch('disable-gpu-compositing'),
      ),
      false,
      'a previous preset does not leak into the next one',
    );
    await closeApp(second.app);
    apps.pop();
    checks.push(
      'C: GPU preset applies on next launch (switch present), list switches merge, presets do not leak, app still renders',
    );
  }

  console.log(JSON.stringify({ success: true, output, checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ output, checks }, null, 2));
  for (const app of apps) {
    const page = app.windows()[0];
    if (!page) continue;
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(-4000),
    );
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  await Promise.all(apps.map((app) => closeApp(app)));
}
