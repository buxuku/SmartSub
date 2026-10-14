/**
 * 诊断安装包（打包后的 exe）冒烟验证：只在 CI 的 Windows 构建里跑，发给测试的人之前先自己跑一遍。
 *
 * 用法：node scripts/diag/smoke-packaged.mjs <SmartSub Diagnostic.exe> [输出目录]
 *
 * 验证的是「打包后才会出现」的那部分：
 *  - 靠文件名识别出诊断版（没有设环境变量），诊断面板自己出现；
 *  - 数据目录独立（{appData}/SmartSub Diagnostic），不碰正式版的数据；
 *  - 自动更新被关掉（否则它会把自己「更新」成正式版）；
 *  - 取证链路在真实的 Windows 上能跑通：标记 / 环境快照（含注册表）/ 导出。
 * 系统层截图、GPU 状态这类「读数」只记录，不作为通过条件：CI 的 runner 没有真显示器，
 * 读数本身就是要带回来看的信息，结果写在 smoke-result.json，现场整个复制到输出目录供上传。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { appPageUrl } from '../e2e/app-page.mjs';

const exe = process.argv[2];
assert.ok(exe, '用法：node scripts/diag/smoke-packaged.mjs <exe> [输出目录]');
const output = path.resolve(
  process.argv[3] ??
    (await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-diag-smoke-'))),
);
await fs.mkdir(output, { recursive: true });

const media = path.join(output, 'smoke.mp4');
const subtitle = path.join(output, 'smoke.srt');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=640x360:r=25:d=4',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  media,
]);
await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:04,000\nSmoke 123\n');

const result = { exe: path.basename(exe), platform: process.platform };
let app;
let page;
try {
  // 诊断包靠文件名识别：故意不设 SMARTSUB_PREVIEW_DIAG，也不给 --user-data-dir
  const env = { ...process.env };
  delete env.SMARTSUB_PREVIEW_DIAG;
  app = await _electron.launch({ executablePath: exe, args: [], env });
  page = await app.firstWindow();
  page.on('dialog', (dialog) => {
    if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(30000);
  await page.waitForURL(appPageUrl);
  await app.evaluate(({ BrowserWindow, dialog, shell }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    shell.showItemInFolder = () => {};
  });

  const info = await page.evaluate(() => window.ipc.invoke('previewDiag:info'));
  assert.equal(info.enabled, true, 'diagnostics enabled by exe name alone');
  assert.equal(info.diagnosticBuild, true);
  assert.equal(info.platform, process.platform);
  result.appVersion = info.appVersion;
  result.appliedPresetId = info.appliedPresetId;

  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  result.userData = userData;
  assert.equal(
    path.basename(userData),
    'SmartSub Diagnostic',
    'data directory is isolated from the normal app',
  );
  assert.equal(
    await page.evaluate(() => window.ipc.invoke('check-for-updates')),
    null,
    'auto-update is disabled',
  );
  assert.equal(
    (await page.evaluate(() => window.ipc.invoke('download-update'))).success,
    false,
  );

  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    ({ media, subtitle }) =>
      window.next.router.push(
        `/zh/subtitleMerge/?video=${encodeURIComponent(media)}&subtitle=${encodeURIComponent(subtitle)}`,
      ),
    { media, subtitle },
  );
  const hud = page.locator('[data-diag-hud]');
  await expect(hud).toBeVisible();
  await expect(page.locator('[data-video-canvas]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__jassubPreview)))
    .toBe(true);
  result.jassubActive = true;

  // 取证链路：先正常基线，再黑屏标记
  await page.locator('[data-video-canvas]').hover();
  await page.keyboard.press('F9');
  await expect(hud).toContainText('最近一次：正常');
  await page.getByRole('button', { name: /现在是黑屏/ }).click();
  await expect(hud).toContainText('最近一次：黑屏');
  const text = await hud.innerText();
  result.osLayer = /系统层（肉眼所见）：([^\n]*)/.exec(text)?.[1] ?? null;
  result.vizLayer = /合成器层：([^\n]*)/.exec(text)?.[1] ?? null;
  result.verdict = /初判：([^\n]*)/.exec(text)?.[1] ?? null;
  assert.ok(result.vizLayer, 'compositor-layer reading is present');

  await hud.getByRole('button', { name: '环境快照', exact: true }).click();
  await expect(hud.getByRole('status')).toContainText('环境快照已保存');
  const snapshotDir = path.join(userData, 'preview-diagnostics', 'snapshots');
  const [snapshotFile] = (await fs.readdir(snapshotDir)).filter((name) =>
    name.endsWith('.json'),
  );
  assert.ok(snapshotFile, 'snapshot file written');
  const snapshot = JSON.parse(
    await fs.readFile(path.join(snapshotDir, snapshotFile), 'utf8'),
  );
  result.snapshot = {
    electron: snapshot.versions?.electron,
    os: snapshot.os,
    gpuFeatureStatus: snapshot.gpuFeatureStatus,
    registryKeys:
      snapshot.registry && typeof snapshot.registry === 'object'
        ? Object.keys(snapshot.registry)
        : snapshot.registry,
    registryErrors:
      snapshot.registry && typeof snapshot.registry === 'object'
        ? Object.entries(snapshot.registry)
            .filter(([, value]) => value && value.error)
            .map(([key, value]) => `${key}: ${value.error}`)
        : [],
  };
  if (process.platform === 'win32')
    assert.ok(
      snapshot.registry && typeof snapshot.registry === 'object',
      'Windows registry section collected',
    );

  const zip = path.join(output, 'smoke-export.zip');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, zip);
  await hud.getByRole('button', { name: '导出诊断包', exact: true }).click();
  await expect(hud.getByRole('status')).toContainText('诊断包已导出');
  assert.ok((await fs.stat(zip)).size > 1000, 'export zip written');
  result.exportBytes = (await fs.stat(zip)).size;

  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  if (page)
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  if (result.userData)
    await fs
      .cp(
        path.join(result.userData, 'preview-diagnostics'),
        path.join(output, 'diag-data'),
        { recursive: true },
      )
      .catch(() => {});
  await fs.writeFile(
    path.join(output, 'smoke-result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (app) {
    const closed = app.close().then(
      () => true,
      () => true,
    );
    const timedOut = new Promise((resolve) =>
      setTimeout(resolve, 15000, false),
    );
    if (!(await Promise.race([closed, timedOut])))
      app.process().kill('SIGKILL');
  }
}
