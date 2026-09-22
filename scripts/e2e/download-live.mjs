import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage, appOrigin } from './app-page.mjs';

// Opt-in external compatibility check; uses the real application adapter and
// isolated settings. Never imports browser cookies or calls translation/TTS.
const binary = process.env.SMARTSUB_E2E_YTDLP;
const urls = JSON.parse(process.env.SMARTSUB_E2E_DOWNLOAD_URLS || '[]');
assert.ok(binary, 'Set SMARTSUB_E2E_YTDLP to an installed yt-dlp executable');
assert.ok(
  Array.isArray(urls) &&
    urls.length &&
    urls.every((url) => /^https?:\/\//.test(url)),
  'Set SMARTSUB_E2E_DOWNLOAD_URLS to a JSON array of public test URLs',
);
const version = execFileSync(binary, ['--version'], {
  encoding: 'utf8',
}).trim();
const download = process.argv.includes('--download');
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-download-live-e2e-'),
);
const results = {
  date: new Date().toISOString(),
  version,
  download,
  sites: [],
  errors: [],
};
let app;
let page;
let activeBatch;
try {
  app = await _electron.launch({
    args: [
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
  });
  let diagnostics = '';
  app.process().stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-128000);
  });
  app.process().on('exit', (code, signal) => {
    results.processExit = { code, signal };
    void fs.writeFile(path.join(output, 'electron-stderr.log'), diagnostics);
    void fs.writeFile(
      path.join(output, 'process-exit.json'),
      JSON.stringify({ code, signal }),
    );
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => results.errors.push(error.message));
  await waitForAppPage(page);
  const userData = await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    return app.getPath('userData');
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const binaryDir = path.join(userData, 'downloaders', 'yt-dlp', version);
  await fs.mkdir(binaryDir, { recursive: true });
  await fs.copyFile(binary, path.join(binaryDir, 'yt-dlp'));
  await fs.chmod(path.join(binaryDir, 'yt-dlp'), 0o755);
  await fs.writeFile(
    path.join(userData, 'downloaders', 'config.json'),
    JSON.stringify({
      engines: {
        'yt-dlp': {
          version,
          binaryName: 'yt-dlp',
          installedAt: new Date().toISOString(),
        },
      },
    }),
  );
  await page.evaluate(async (proxyUrl) => {
    const result = await window.ipc.invoke('setSettings', {
      proxyMode: proxyUrl ? 'custom' : 'none',
      proxyUrl,
      videoDownloadEngine: 'yt-dlp',
    });
    if (result?.success === false) throw new Error(JSON.stringify(result));
  }, process.env.SMARTSUB_E2E_PROXY || '');
  for (const url of urls) {
    const [preflight] = await page.evaluate(
      (url) =>
        window.ipc.invoke('videoDownload:preflight', {
          urls: [url],
          engine: 'yt-dlp',
        }),
      url,
    );
    const site = { url, preflight };
    results.sites.push(site);
    if (!preflight?.ok || !download) continue;
    assert.ok(preflight.meta?.title, 'Real site metadata has a title');
    const batch = await page.evaluate(
      ({ url, meta, savePath }) =>
        window.ipc.invoke('videoDownload:start', {
          name: 'External compatibility check',
          entries: [{ url, meta }],
          engine: 'yt-dlp',
          quality: '720p',
          writeSubs: true,
          concurrency: 1,
          savePath,
        }),
      { url, meta: preflight.meta, savePath: path.join(output, 'downloads') },
    );
    activeBatch = batch.id;
    await page.goto(`${appOrigin(page)}/zh/download/?workItem=${batch.id}`);
    await expect
      .poll(
        async () => {
          const item = await page.evaluate(
            (id) => window.ipc.invoke('getWorkItem', id),
            batch.id,
          );
          return item.downloadEntries.every((entry) =>
            ['done', 'error'].includes(entry.status),
          );
        },
        { timeout: 180000 },
      )
      .toBe(true);
    const item = await page.evaluate(
      (id) => window.ipc.invoke('getWorkItem', id),
      batch.id,
    );
    site.entries = item.downloadEntries;
    activeBatch = null;
    for (const entry of item.downloadEntries) {
      if (entry.status !== 'done') continue;
      assert.ok((await fs.stat(entry.outputPath)).size > 0);
      execFileSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          entry.outputPath,
          '-f',
          'null',
          '-',
        ],
        { timeout: 60000 },
      );
      for (const file of entry.subtitlePaths || [])
        assert.ok((await fs.stat(file)).size > 0);
      entry.decodeVerified = true;
    }
    await page.screenshot({
      path: path.join(output, `download-${results.sites.length}.png`),
    });
  }
} catch (error) {
  results.errors.push(error.stack || String(error));
} finally {
  if (activeBatch)
    await page
      ?.evaluate(
        (workItemId) =>
          window.ipc.invoke('videoDownload:cancelBatch', { workItemId }),
        activeBatch,
      )
      .catch(() => {});
  results.success =
    results.errors.length === 0 &&
    results.sites.length === urls.length &&
    results.sites.every(
      (site) =>
        site.preflight?.ok &&
        (!download ||
          site.entries?.every(
            (entry) => entry.status === 'done' && entry.decodeVerified,
          )),
    );
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify({ output, ...results }));
  await app?.close();
  if (!results.success) process.exitCode = 1;
}
