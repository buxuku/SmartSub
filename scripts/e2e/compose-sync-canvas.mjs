// 视频合成预览在 Windows 上整块变黑的规避（根因见 renderer/lib/jassub/syncCanvasGuard.ts），
// 在「真正的构建产物」上的回归：打开合成页，进到 JASSUB 的 Worker 里核对
//   1. Windows UA：守卫已装上，渲染器最终交给原生 getContext 的画布属性里没有 desynchronized: true；
//   2. 非 Windows UA：守卫不装，仍是上游的 desynchronized: true。
// 单测只能证明「守卫这段代码对」，而守卫能否被 webpack 打进 Worker 入口、
// 是否先于渲染器执行，只有跑构建产物才知道。
//
// 为了看到「交给原生 getContext 的是什么」，会临时在 Worker 入口 chunk 的最前面塞一个记录钩子
// （它比守卫更靠近原生，所以守卫改过的结果才会被记下），跑完立刻还原；Ctrl-C / kill 也会还原，
// 且只在文件仍是被我们改写过的样子时才还原，不会覆盖别的进程（比如并行的 yarn build）重写的内容。
// 被 SIGKILL 强杀时来不及还原：下次运行会清掉残留并提示，scripts/check-jassub-worker-guard.mjs
// 也会把残留的钩子报出来。
// 需要先 `yarn build`；用 `yarn test:e2e:compose-sync-canvas` 运行。
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

// 只有生产构建的 Worker chunk 才是磁盘上的静态文件。
if (!process.argv.includes('--production')) process.argv.push('--production');

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const SCENARIOS = [
  { name: 'Windows', userAgent: WINDOWS_UA, isWindows: true },
  { name: 'macOS', userAgent: MAC_UA, isWindows: false },
];

const HOOK_MARK = '/*smartsub-e2e-getContext-recorder*/';
const HOOK =
  `${HOOK_MARK};(()=>{const native=OffscreenCanvas.prototype.getContext;` +
  'globalThis.__smartsubE2eRequests=[];' +
  'OffscreenCanvas.prototype.getContext=function(type,attributes,...rest){' +
  "if(attributes&&typeof attributes==='object')" +
  'globalThis.__smartsubE2eRequests.push({type,desynchronized:attributes.desynchronized});' +
  'return native.call(this,type,attributes,...rest)}})();\n';

const chunksDir = path.resolve('app/_next/static/chunks');
const workerChunk = (await fs.readdir(chunksDir).catch(() => [])).find((name) =>
  /^jassub-worker\..+\.js$/.test(name),
);
assert.ok(
  workerChunk,
  `找不到 JASSUB Worker 的构建产物（${chunksDir}/jassub-worker.*.js），请先 yarn build`,
);
const workerChunkPath = path.join(chunksDir, workerChunk);
const onDisk = await fs.readFile(workerChunkPath, 'utf8');
// 被强杀（SIGKILL）的上一次运行可能把钩子留在 chunk 里：先剥掉，把剩下的当作原始内容。
const leftover = onDisk.startsWith(HOOK_MARK);
const pristine = leftover
  ? onDisk.replace(
      new RegExp(`^${HOOK_MARK.replace(/[*/]/g, '\\$&')}[^\\n]*\\n`),
      '',
    )
  : onDisk;
if (leftover)
  console.warn(
    '⚠ 清掉了上一次被中断的 e2e 留在 JASSUB Worker chunk 里的记录钩子',
  );

// 只在文件仍是被我们改写过的样子时才还原：别的进程（比如并行的 yarn build）已经重写过它，就不去覆盖。
function restoreWorkerChunk() {
  try {
    if (readFileSync(workerChunkPath, 'utf8').startsWith(HOOK_MARK))
      writeFileSync(workerChunkPath, pristine);
  } catch {
    // 文件不在了（正在重新构建）：没有什么可还原的。
  }
}
// 临时目录（视频、字幕和 Electron 的 profile），建好之后才赋值。
let output;
// 'exit' 里只能同步干活；被信号打断时 finally 不会执行，所以临时目录也在这里一并清掉。
function cleanUpOnExit() {
  restoreWorkerChunk();
  if (!output) return;
  try {
    rmSync(output, { recursive: true, force: true });
  } catch {
    // 尽力而为：Electron 可能还没被 Playwright 的 exit 钩子杀掉，还在往里写。
  }
}
// Ctrl-C / kill 要显式走到 exit，否则 Node 直接退出，exit 钩子不会执行；
// Electron 由 Playwright 自己的 exit 钩子杀掉。
// 先登记再写钩子，这样钩子写进去之后的任何时刻被打断都能还原。
process.once('exit', cleanUpOnExit);
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
])
  process.once(signal, () => process.exit(code));

output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-compose-sync-canvas-e2e-'),
);
const media = path.join(output, 'sync-canvas.mp4');
const subtitle = path.join(output, 'sync-canvas.srt');
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
  '1\n00:00:00,000 --> 00:00:03,000\nSmartSub Sync Canvas 123\n',
);

async function probeJassubWorker({ name, userAgent }) {
  const app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, `profile-${name}`)}`,
    ],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  try {
    const page = await app.firstWindow();
    page.on('dialog', (dialog) => {
      if (dialog.type() !== 'beforeunload')
        void dialog.dismiss().catch(() => {});
    });
    page.setDefaultTimeout(30000);
    await waitForAppPage(page);
    await page.getByRole('button', { name: '跳过', exact: true }).click();
    // 先于 Worker 的创建覆盖 UA（Worker 继承创建它的页面的 UA）。
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride', { userAgent });
    await page.evaluate(
      ({ media, subtitle }) =>
        window.next.router.push(
          `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`,
        ),
      { media, subtitle },
    );
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)), {
        timeout: 120000,
      })
      .toBe(true);
    const worker = page.workers().find((w) => /jassub-worker/.test(w.url()));
    assert.ok(
      worker,
      `没有找到 JASSUB Worker：${page.workers().map((w) => w.url())}`,
    );
    return await worker.evaluate(() => ({
      windowsUserAgent: /Windows/.test(navigator.userAgent),
      guardInstalled: Boolean(
        OffscreenCanvas.prototype.getContext[
          Symbol.for('smartsub.syncCanvasGuard')
        ],
      ),
      requests: globalThis.__smartsubE2eRequests ?? [],
    }));
  } finally {
    await app.close().catch(() => {});
  }
}

const results = [];
try {
  await fs.writeFile(workerChunkPath, HOOK + pristine);
  for (const scenario of SCENARIOS) {
    const probe = await probeJassubWorker(scenario);
    results.push({ scenario: scenario.name, ...probe });
    const label = `[${scenario.name}] ${JSON.stringify(probe)}`;
    assert.equal(
      probe.windowsUserAgent,
      scenario.isWindows,
      `UA 覆盖没有到达 Worker：${label}`,
    );
    assert.equal(
      probe.guardInstalled,
      scenario.isWindows,
      `守卫${scenario.isWindows ? '没有' : '不该'}装进 JASSUB Worker：${label}`,
    );
    assert.ok(
      probe.requests.length > 0,
      `没有记录到任何 getContext 调用（记录钩子或 Worker 入口变了？）：${label}`,
    );
    if (scenario.isWindows) {
      assert.deepEqual(
        probe.requests.filter((request) => request.desynchronized),
        [],
        `Windows 下仍有渲染器向原生请求 desynchronized: true：${label}`,
      );
    } else {
      assert.ok(
        probe.requests.some((request) => request.desynchronized === true),
        `非 Windows 下上游本应请求 desynchronized: true（上游变了？）：${label}`,
      );
    }
  }
  console.log(
    'compose sync-canvas e2e passed:',
    JSON.stringify(results, null, 2),
  );
} finally {
  restoreWorkerChunk();
  await fs.rm(output, { recursive: true, force: true });
}
