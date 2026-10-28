const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const loader = require('./lib/load-typescript.cjs');

async function main() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-download-adapter-'),
  );
  const video = path.join(dir, 'lesson [id].mp4');
  const official = path.join(dir, 'lesson [id].en.srt');
  const stale = path.join(dir, 'lesson [id].fr.srt');
  fs.writeFileSync(video, 'fixture');
  fs.writeFileSync(official, 'official');
  fs.writeFileSync(stale, 'stale');
  let command;
  let report = true;
  const load = loader({
    './engineAdapter': {
      ffmpegLocation: () => '/ffmpeg',
      getProxyUrl: () => '',
      runProcess: async (_binary, args, { onStdout }) => {
        command = args;
        const output = `SMARTSUB-FILE;${JSON.stringify(video)}\nSMARTSUB-SUBS;${JSON.stringify(report ? { en: { filepath: official } } : null)}\n`;
        for (let i = 0; i < output.length; i += 7)
          onStdout(output.slice(i, i + 7));
        return { code: 0, stdout: output, stderr: '' };
      },
    },
  });
  const adapter = load(
    'main/helpers/videoDownload/ytDlpAdapter.ts',
  ).ytDlpAdapter;
  const options = {
    url: 'https://example.com',
    savePath: dir,
    quality: 'best',
    writeSubs: true,
    signal: new AbortController().signal,
    onProgress() {},
  };
  const result = await adapter.download('/yt-dlp', options);
  assert.deepEqual(Array.from(result.subtitlePaths), [official]);
  assert.ok(command.includes('--ignore-config'));
  assert.equal(
    command[command.indexOf('--sub-langs') + 1],
    'all,-live_chat,-rechat,-danmaku',
  );
  assert.ok(!command.includes('--write-auto-subs'));
  report = false;
  assert.equal(
    (await adapter.download('/yt-dlp', options)).subtitlePaths,
    undefined,
    'stale matching files are not official',
  );
  report = true;
  assert.equal(
    (await adapter.download('/yt-dlp', { ...options, writeSubs: false }))
      .subtitlePaths,
    undefined,
  );
  assert.ok(!command.includes('--write-subs'));
  const parsers = load('main/helpers/videoDownload/parsers.ts');
  assert.deepEqual(
    Array.from(
      parsers.parseYtDlpSubtitlePaths(
        `SMARTSUB-SUBS;${JSON.stringify({
          en: { filepath: official },
          danmaku: { filepath: path.join(dir, 'lesson [id].danmaku.srt') },
          live_chat: { filepath: path.join(dir, 'lesson [id].live_chat.srt') },
          rechat: { filepath: path.join(dir, 'lesson [id].rechat.srt') },
        })}`,
      ),
    ),
    [official],
    'comment tracks never become official pipeline input even with a subtitle extension',
  );
  for (const raw of [
    'SMARTSUB-SUBS;NA',
    'SMARTSUB-SUBS;[1]',
    'SMARTSUB-SUBS;{"en":{"filepath":2}}',
    'noise',
  ])
    assert.equal(parsers.parseYtDlpSubtitlePaths(raw).length, 0);

  const luxVideo = path.join(dir, 'lux fixture.mp4');
  const luxError = [
    'Downloading https://www.douyin.com/video/7693844311170993417 error:',
    'unexpected end of JSON input',
    'github.com/iawia002/lux/extractors/douyin.(*extractor).Extract',
    '\tgithub.com/iawia002/lux/extractors/douyin/douyin.go:103',
  ].join('\n');
  let luxFailure = false;
  const lux = loader({
    './engineAdapter': {
      async runProcess(_binary, args) {
        command = args;
        if (luxFailure) return { code: 1, stdout: luxError, stderr: '' };
        if (args.includes('-j'))
          return {
            code: 0,
            stdout: JSON.stringify([{ title: 'lux fixture', streams: {} }]),
            stderr: '',
          };
        fs.writeFileSync(luxVideo, 'fixture');
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  })('main/helpers/videoDownload/luxAdapter.ts').luxAdapter;
  for (const [input, expected] of [
    [
      'https://www.douyin.com/jingxuan?modal_id=7693844311170993417',
      'https://www.douyin.com/video/7693844311170993417',
    ],
    [
      'https://www.douyin.com/user/author?from=web&modal_id=7693844311170993417',
      'https://www.douyin.com/video/7693844311170993417',
    ],
    [
      'https://douyin.com/?modal_id=7693844311170993417',
      'https://www.douyin.com/video/7693844311170993417',
    ],
    ...[
      'https://www.douyin.com/video/7693844311170993417?from=web',
      'https://v.douyin.com/short/',
      'https://www.douyin.com/jingxuan?modal_id=not-a-video',
      'https://www.douyin.com/jingxuan?modal_id=',
      'https://www.douyin.com/user/author',
      'https://douyin.com.example.com/?modal_id=7693844311170993417',
      'https://www.bilibili.com/video/BV1?modal_id=7693844311170993417',
    ].map((url) => [url, url]),
  ]) {
    const meta = await lux.preflight('/lux', { url: input });
    assert.equal(command.at(-1), expected, `lux preflight URL: ${input}`);
    const downloaded = await lux.download('/lux', {
      ...options,
      url: input,
      meta,
    });
    assert.equal(command.at(-1), expected, `lux download URL: ${input}`);
    assert.deepEqual(Array.from(downloaded.outputPaths), [luxVideo]);
  }
  luxFailure = true;
  await assert.rejects(
    lux.preflight('/lux', { url: options.url }),
    /unexpected end of JSON input/,
    'lux preflight preserves the cause after the error header',
  );
  await assert.rejects(
    lux.download('/lux', options),
    /unexpected end of JSON input/,
    'lux download preserves the cause after the error header',
  );

  const cookieSettings = { settings: {} };
  const browserHome = path.join(dir, 'browser-home');
  const chromeRoot = path.join(
    browserHome,
    'Library/Application Support/Google/Chrome',
  );
  const chromeProfile = path.join(chromeRoot, 'Default');
  const internalStore = path.join(chromeProfile, 'Storage/ext/glic/internal');
  const inactiveProfile = path.join(chromeRoot, 'Profile 1');
  fs.mkdirSync(internalStore, { recursive: true });
  fs.mkdirSync(inactiveProfile, { recursive: true });
  fs.writeFileSync(
    path.join(chromeRoot, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Default' } }),
  );
  fs.writeFileSync(
    path.join(chromeProfile, 'Cookies'),
    'main-profile-cookie-database',
  );
  fs.writeFileSync(
    path.join(internalStore, 'Cookies'),
    'internal-cookie-database',
  );
  fs.writeFileSync(
    path.join(inactiveProfile, 'Cookies'),
    'inactive-cookie-database',
  );
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(internalStore, 'Cookies'), future, future);
  fs.utimesSync(path.join(inactiveProfile, 'Cookies'), future, future);
  let exportPath;
  let cookieProcessError;
  let exportedCookies =
    '.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tfixture\n' +
    '.example.com\tTRUE\t/\tTRUE\t0\tother_session\tfixture\n';
  const cookieLoad = loader({
    process: { platform: 'darwin', env: {} },
    os: { ...os, homedir: () => browserHome },
    electron: {
      app: { getPath: () => dir },
      safeStorage: { isEncryptionAvailable: () => false },
    },
    '../storeManager': {
      store: {
        get: (key) => cookieSettings[key],
        set: (key, value) => {
          cookieSettings[key] = value;
        },
      },
      logMessage() {},
    },
    '../downloaderManager': { getDownloaderBinaryPath: () => '/yt-dlp' },
    './engineAdapter': {
      async runProcess(_binary, args) {
        exportPath = args[args.indexOf('--cookies') + 1];
        const browserSource = args[args.indexOf('--cookies-from-browser') + 1];
        assert.ok(
          browserSource.startsWith('chrome:'),
          'Chrome import must select a profile instead of searching every Cookies file',
        );
        const stagedProfile = browserSource.slice('chrome:'.length);
        assert.equal(
          fs.readFileSync(path.join(stagedProfile, 'Cookies'), 'utf8'),
          'main-profile-cookie-database',
          'the active main database wins over newer internal and inactive stores',
        );
        assert.deepEqual(
          fs.readdirSync(stagedProfile),
          ['Cookies'],
          'the extraction source has no nested browser-internal cookie stores',
        );
        assert.ok(
          fs.existsSync(path.join(path.dirname(stagedProfile), 'Local State')),
          'Chromium decryption metadata is preserved',
        );
        assert.ok(
          args.includes('--ignore-config'),
          'personal yt-dlp configuration cannot change cookie export',
        );
        if (cookieProcessError) throw cookieProcessError;
        fs.writeFileSync(exportPath, exportedCookies);
        return {
          code: 1,
          stdout: 'Extracted 2 cookies from chrome',
          stderr:
            "ERROR: [generic] 127.0.0: Unable to download webpage: HTTPConnection(host='127.0.0.1', port=80): Connection refused",
        };
      },
    },
  });
  const cookieImport = cookieLoad('main/helpers/videoDownload/cookieImport.ts');
  const cookieStore = cookieLoad(
    'main/helpers/videoDownload/cookieProfileStore.ts',
  );
  const cookieParams = {
    id: `custom-${randomUUID()}`,
    browser: 'chrome',
    customDef: {
      name: 'Douyin',
      matchDomains: ['www.douyin.com'],
      cookieDomains: ['www.douyin.com'],
    },
  };
  const imported = await cookieImport.importCookiesFromBrowser(cookieParams);
  assert.equal(
    imported.cookieCount,
    1,
    'www import retains the parent domain login cookie',
  );
  const cookieText = cookieStore.resolveCookieTextForUrl(
    'https://www.douyin.com/video/1',
  );
  assert.match(cookieText, /sessionid/);
  assert.doesNotMatch(cookieText, /other_session|example\.com/);
  assert.equal(
    fs.existsSync(path.dirname(exportPath)),
    false,
    'full browser export is removed after import',
  );
  exportedCookies = '.example.com\tTRUE\t/\tTRUE\t0\tother_session\tfixture\n';
  await assert.rejects(
    cookieImport.importCookiesFromBrowser(cookieParams),
    (error) => {
      assert.match(
        error.message,
        /No www\.douyin\.com cookies found in chrome/,
      );
      assert.doesNotMatch(error.message, /127\.0\.0\.1|Connection refused/);
      return true;
    },
    'a site mismatch reports the cookie problem without the expected dummy URL failure',
  );
  assert.equal(
    fs.existsSync(path.dirname(exportPath)),
    false,
    'full browser export is removed after failure',
  );
  cookieProcessError = new Error('fixture extraction timeout');
  await assert.rejects(
    cookieImport.importCookiesFromBrowser(cookieParams),
    /fixture extraction timeout/,
  );
  assert.equal(
    fs.existsSync(path.dirname(exportPath)),
    false,
    'staged database and export are removed after a process error',
  );
  const { prepareBrowserCookieSource } = cookieLoad(
    'main/helpers/videoDownload/browserCookieSource.ts',
  );
  const fallbackDir = fs.mkdtempSync(path.join(dir, 'browser-fallback-'));
  fs.writeFileSync(
    path.join(chromeRoot, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Missing Profile' } }),
  );
  const fallbackSource = prepareBrowserCookieSource('chrome', fallbackDir);
  assert.equal(
    fs.readFileSync(
      path.join(fallbackSource.slice('chrome:'.length), 'Cookies'),
      'utf8',
    ),
    'inactive-cookie-database',
    'missing active profile falls back to the newest main profile database',
  );
  fs.rmSync(fallbackDir, { recursive: true });
  const networkDir = fs.mkdtempSync(path.join(dir, 'browser-network-'));
  fs.mkdirSync(path.join(chromeProfile, 'Network'), { recursive: true });
  fs.writeFileSync(
    path.join(chromeProfile, 'Network/Cookies'),
    'network-cookie-database',
  );
  fs.writeFileSync(
    path.join(chromeRoot, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Default' } }),
  );
  const networkSource = prepareBrowserCookieSource('chrome', networkDir);
  assert.equal(
    fs.readFileSync(
      path.join(networkSource.slice('chrome:'.length), 'Cookies'),
      'utf8',
    ),
    'network-cookie-database',
    'modern Network/Cookies is supported',
  );
  fs.rmSync(networkDir, { recursive: true });
  assert.equal(
    prepareBrowserCookieSource('firefox', dir),
    'firefox',
    'Firefox keeps its native extraction source',
  );
  fs.rmSync(path.join(chromeProfile, 'Cookies'));
  fs.rmSync(path.join(chromeProfile, 'Network'), { recursive: true });
  fs.rmSync(inactiveProfile, { recursive: true });
  assert.throws(
    () => prepareBrowserCookieSource('chrome', dir),
    /BROWSER_NOT_FOUND/,
    'internal-only stores must not be used when a main database is missing',
  );
  console.log(
    'Browser cookie import: parent-domain matching, site isolation, dummy-error suppression and temporary-file cleanup passed.',
  );

  function schedulerHarness({
    diskFailure = false,
    transferFailure = false,
    pending = false,
  } = {}) {
    const items = new Map();
    const writes = [];
    let handoffs = 0;
    let downloads = 0;
    let release;
    const downloadWait = new Promise((resolve) => {
      release = resolve;
    });
    const events = [];
    const stubs = {
      uuid: { v4: randomUUID },
      '../storeManager': {
        store: { get: () => ({ videoDownloadConcurrency: 1 }), set() {} },
        logMessage() {},
      },
      '../workItemStore': {
        getWorkItemById: (id) => structuredClone(items.get(id)),
        saveWorkItem(item, opts = {}) {
          if (
            diskFailure &&
            opts.durable &&
            item.downloadEntries.some((entry) => entry.status === 'done')
          )
            throw new Error('ENOSPC');
          writes.push({ item: structuredClone(item), durable: opts.durable });
          items.set(item.id, structuredClone(item));
        },
      },
      '../downloaderManager': {
        getInstalledEngines: () => ['yt-dlp', 'lux'],
        getDownloaderBinaryPath: () => '/fixture',
      },
      './engineAdapter': {
        createCookieTempFile() {},
        cleanupCookieTempFile() {},
        shutdownDownloaderProcesses() {},
        isCancelledError: (error) => error.message === 'CANCELLED',
      },
      './pipeline': {
        resolveDownloadPipeline: () => ({ version: 1 }),
        downloadPipelineKey: () => 'confirmed',
        handoffDownloadEntry() {
          handoffs++;
          throw new Error('HANDOFF_DISK_FAILURE');
        },
      },
    };
    for (const engine of ['ytDlp', 'lux'])
      stubs[`./${engine}Adapter`] = {
        [`${engine}Adapter`]: {
          async preflight() {
            return { title: 'fixture' };
          },
          async download() {
            downloads++;
            if (pending) await downloadWait;
            if (transferFailure && downloads === 1)
              throw new Error('NETWORK_FAILURE');
            return { outputPaths: [video], subtitlePaths: [official] };
          },
        },
      };
    const scheduler = loader(stubs)('main/helpers/videoDownload/scheduler.ts');
    scheduler.setVideoDownloadEmitter((...event) => events.push(event));
    const start = () =>
      scheduler.startDownloadBatch({
        name: 'Batch',
        savePath: dir,
        quality: 'best',
        engine: 'auto',
        entries: [{ url: 'https://example.com/a', meta: { title: 'fixture' } }],
        autoChain: { recipeId: 'recipe', configKey: 'confirmed' },
      });
    return {
      scheduler,
      start,
      writes,
      items,
      release,
      counts: () => ({ handoffs, downloads }),
    };
  }
  const drain = async (h) => {
    for (let i = 0; i < 30 && h.scheduler.isVideoDownloadBusy(); i++)
      await new Promise(setImmediate);
    assert.equal(h.scheduler.isVideoDownloadBusy(), false);
  };
  const success = schedulerHarness();
  const batch = success.start();
  await drain(success);
  const done = success.items.get(batch.id);
  assert.equal(done.downloadEntries[0].status, 'done');
  assert.equal(done.artifacts.length, 2);
  assert.equal(
    success.scheduler.cancelDownloadEntry(batch.id, done.downloadEntries[0].id),
    false,
  );
  assert.equal(success.scheduler.cancelDownloadBatch(batch.id), false);
  assert.equal(success.items.get(batch.id).downloadEntries[0].status, 'done');
  assert.deepEqual(
    success.counts(),
    { downloads: 1, handoffs: 1 },
    'handoff failure must not retry transfer',
  );
  const completeWrites = success.writes.filter(
    (w) => w.durable && w.item.downloadEntries[0].status === 'done',
  );
  assert.equal(completeWrites.length, 1);
  assert.equal(
    completeWrites[0].item.artifacts.length,
    2,
    'completion and artifacts commit atomically',
  );
  const failure = schedulerHarness({ diskFailure: true });
  const failed = failure.start();
  await drain(failure);
  assert.equal(
    failure.counts().downloads,
    1,
    'disk failure must not try another download engine',
  );
  assert.equal(failure.counts().handoffs, 0);
  assert.match(failure.items.get(failed.id).downloadEntries[0].error, /ENOSPC/);
  const network = schedulerHarness({ transferFailure: true });
  network.start();
  await drain(network);
  assert.equal(
    network.counts().downloads,
    2,
    'actual transfer failure still falls back',
  );
  const cancelled = schedulerHarness({ pending: true });
  const cancelItem = cancelled.start();
  cancelled.scheduler.cancelDownloadBatch(cancelItem.id);
  cancelled.release();
  await drain(cancelled);
  assert.equal(
    cancelled.counts().handoffs,
    0,
    'cancellation during transfer must never start pipeline',
  );
  assert.equal(cancelled.items.get(cancelItem.id).status, 'interrupted');
  const deleted = schedulerHarness({ pending: true });
  const removed = deleted.start();
  deleted.items.delete(removed.id);
  assert.equal(deleted.scheduler.cancelDownloadBatch(removed.id), true);
  deleted.release();
  await drain(deleted);
  assert.equal(deleted.counts().handoffs, 0);
  assert.equal(
    deleted.items.has(removed.id),
    false,
    'late transfer completion does not resurrect deleted task',
  );
  console.log(
    'Download adapter/scheduler: structured official artifacts, stale-file exclusion, split stdout, opt-out, atomic completion, storage failure, network fallback and cancellation passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
