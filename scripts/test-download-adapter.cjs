const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');

function loader(stubs) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        structuredClone,
        console,
        AbortController,
        URL,
        require(request) {
          if (stubs[request]) return stubs[request];
          if (request.startsWith('.'))
            return load(path.resolve(path.dirname(filename), `${request}.ts`));
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  }
  return load;
}

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
  assert.ok(command.includes('all,-live_chat'));
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
  for (const raw of [
    'SMARTSUB-SUBS;NA',
    'SMARTSUB-SUBS;[1]',
    'SMARTSUB-SUBS;{"en":{"filepath":2}}',
    'noise',
  ])
    assert.equal(parsers.parseYtDlpSubtitlePaths(raw).length, 0);

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
