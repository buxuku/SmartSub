// Exercise the real downloader, archive extraction and installation against local mirrors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const tar = require('tar');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-addon-install-'));
let userData;
let baseUrl;
let routes;
let requests;
let onProgress;
let downloader;
const handlers = new Map();
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const binary = Buffer.from('fixture native addon bytes');
const archive = zlib.gzipSync(binary);

require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  if (request === './storeManager') return { logMessage() {} };
  if (request === './cudaUtils') return { getEffectivePlatform: () => 'win32' };
  if (
    parent?.filename.endsWith('addonDownloader.ts') &&
    request === './download/sources'
  )
    return { resolveReleaseBaseUrl: (source) => `${baseUrl}/${source}` };
  if (parent?.filename.endsWith('ipcAddonHandlers.ts')) {
    if (request === '../automation/handlers')
      return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    if (request === './addonLoader') return { clearAddonLoadCache() {} };
    if (request === './addonVersions')
      return {
        getRemoteVersionInfo() {
          throw new Error(
            'Must not query mutable latest metadata after installing',
          );
        },
      };
    if (
      request === './crash/nativeGuard' ||
      request === './crash/cpuFeaturesService'
    )
      return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  AddonDownloader,
  getAddonDownloader,
} = require('../main/helpers/addonDownloader.ts');
const manager = require('../main/helpers/addonManager.ts');
require('../main/helpers/ipcAddonHandlers.ts').registerAddonIpcHandlers();

function manifest(
  version = '2026.11.05',
  checksum = sha(archive),
  key = 'windows-node',
) {
  return {
    '13.0.2': {
      version,
      updateNotes: 'whisper.cpp v1.9.5 + patches',
      checksum: { [key]: checksum },
    },
  };
}

function serve(
  source,
  metadata = manifest(),
  bytes = archive,
  type = 'node.gz',
) {
  routes.set(`/${source}/addon-versions.json`, metadata);
  routes.set(
    `/${source}/${type === 'node.gz' ? 'addon-windows-cuda-1302-optimized.node.gz' : 'windows-cuda-1302-optimized.tar.gz'}`,
    bytes,
  );
}

function previousInstall() {
  const dir = manager.getAddonVersionDir('13.0.2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'addon.node'), 'working old addon');
  fs.writeFileSync(path.join(dir, 'cudart64_13.dll'), 'old runtime');
  manager.registerInstalledAddon('13.0.2', '2026.10.21', 'old-checksum');
  return dir;
}

async function reset() {
  userData = fs.mkdtempSync(path.join(root, 'case-'));
  routes = new Map();
  requests = [];
  onProgress = () => {};
  downloader = new AddonDownloader({
    isDestroyed: () => false,
    webContents: { send: (_event, progress) => onProgress(progress) },
  });
}

let passed = 0;
async function test(name, fn) {
  await reset();
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL - ${name}`, error);
  }
}

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const value = routes.get(req.url);
  if (typeof value === 'function') return value(req, res);
  if (value === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value));
  res.writeHead(200, { 'Content-Length': bytes.length });
  res.end(bytes);
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await test('checksum mismatch preserves the working installation and its registration', async () => {
    const dir = previousInstall();
    serve('github', manifest('2026.11.05', '0'.repeat(64)));
    await assert.rejects(downloader.download('github', '13.0.2', 'node.gz'));
    assert.equal(
      fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
      'working old addon',
    );
    assert.equal(
      manager.getAddonConfig().installed['13.0.2'].remoteVersion,
      '2026.10.21',
    );
  });

  await test('verified installation records the package and extracted binary identities', async () => {
    serve('github', manifest('2026.11.05', sha(archive).toUpperCase()));
    const { directory, provenance } = await downloader.download(
      'github',
      '13.0.2',
      'node.gz',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(directory, 'addon.node')),
      binary,
    );
    assert.equal(provenance.source, 'github');
    assert.equal(provenance.releaseVersion, '2026.11.05');
    assert.equal(provenance.packageSha256, sha(archive));
    assert.equal(provenance.expectedSha256, sha(archive));
    assert.equal(provenance.addonSha256, sha(binary));
    assert.equal(
      provenance.packageUrl,
      `${baseUrl}/github/addon-windows-cuda-1302-optimized.node.gz`,
    );
    assert.equal(
      provenance.manifestUrl,
      `${baseUrl}/github/addon-versions.json`,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'addon-install.json'))),
      provenance,
    );
    assert.deepEqual(
      manager.getInstalledAddons()[0].info.provenance,
      provenance,
    );
  });

  await test('fallback uses the successful mirror manifest and does not report an intermediate failure', async () => {
    serve('github', manifest('2026.11.05', '0'.repeat(64)));
    serve('gitcode', manifest('2026.10.21'));
    const statuses = [];
    onProgress = (p) => statuses.push(p.status);
    const { provenance } = await downloader.download(
      'github',
      '13.0.2',
      'node.gz',
    );
    assert.equal(provenance.source, 'gitcode');
    assert.equal(provenance.releaseVersion, '2026.10.21');
    assert.ok(!statuses.includes('error'));
    assert.ok(statuses.includes('verifying'));
  });

  await test('missing or invalid checksums reject before downloading any binary', async () => {
    serve('github', manifest('2026.11.05', ''));
    serve('gitcode', manifest('2026.11.05', 'not-a-sha256'));
    serve('ghproxy', { '13.0.2': { version: '2026.11.05' } });
    await assert.rejects(
      downloader.download('github', '13.0.2', 'node.gz'),
      /checksum/i,
    );
    assert.ok(requests.every((url) => url.endsWith('addon-versions.json')));
    assert.equal(manager.isAddonInstalled('13.0.2'), false);
  });

  await test('a completed resumed download still passes checksum verification', async () => {
    const dir = previousInstall();
    serve('github', manifest('2026.11.05', '0'.repeat(64)));
    const tempPath = path.join(userData, 'addons', 'temp-1302');
    fs.writeFileSync(tempPath, archive);
    fs.writeFileSync(
      path.join(userData, 'addon-download-state.json'),
      JSON.stringify({
        url: `${baseUrl}/github/addon-windows-cuda-1302-optimized.node.gz`,
        tempPath,
        total: archive.length,
        expectedChecksum: '0'.repeat(64),
      }),
    );
    await assert.rejects(downloader.download('github', '13.0.2', 'node.gz'));
    assert.equal(
      fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
      'working old addon',
    );
  });

  await test('a valid completed download is verified and installed without downloading it again', async () => {
    serve('github');
    const tempPath = path.join(userData, 'addons', 'temp-1302');
    fs.mkdirSync(path.dirname(tempPath));
    fs.writeFileSync(tempPath, archive);
    fs.writeFileSync(
      path.join(userData, 'addon-download-state.json'),
      JSON.stringify({
        url: `${baseUrl}/github/addon-windows-cuda-1302-optimized.node.gz`,
        tempPath,
        total: archive.length,
        expectedChecksum: sha(archive),
      }),
    );
    const result = await downloader.download('github', '13.0.2', 'node.gz');
    assert.equal(result.provenance.packageSha256, sha(archive));
    assert.deepEqual(requests, ['/github/addon-versions.json']);
  });

  await test('a changed latest artifact invalidates old partial bytes instead of mixing releases', async () => {
    serve('github');
    const tempPath = path.join(userData, 'addons', 'temp-1302');
    fs.mkdirSync(path.dirname(tempPath));
    fs.writeFileSync(tempPath, archive.subarray(0, 10));
    fs.writeFileSync(
      path.join(userData, 'addon-download-state.json'),
      JSON.stringify({
        url: `${baseUrl}/github/addon-windows-cuda-1302-optimized.node.gz`,
        tempPath,
        total: archive.length,
        expectedChecksum: '0'.repeat(64),
      }),
    );
    routes.set(
      '/github/addon-windows-cuda-1302-optimized.node.gz',
      (req, res) => {
        assert.equal(req.headers.range, undefined);
        res.end(archive);
      },
    );
    const result = await downloader.download('github', '13.0.2', 'node.gz');
    assert.equal(result.provenance.addonSha256, sha(binary));
  });

  await test('archive extraction errors preserve the working addon and runtime', async () => {
    const dir = previousInstall();
    const broken = Buffer.from('not a gzip archive');
    serve('github', manifest('2026.11.05', sha(broken)), broken);
    await assert.rejects(downloader.download('github', '13.0.2', 'node.gz'));
    assert.equal(
      fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
      'working old addon',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'cudart64_13.dll'), 'utf8'),
      'old runtime',
    );
  });

  await test('full packages verify the archive checksum and replace the entire runtime directory', async () => {
    const dir = previousInstall();
    const fixture = path.join(userData, 'fixture');
    fs.mkdirSync(fixture);
    fs.writeFileSync(
      path.join(fixture, 'addon-windows-cuda-1302-optimized.node'),
      binary,
    );
    fs.writeFileSync(path.join(fixture, 'cudart64_13.dll'), 'new runtime');
    await tar.create(
      { gzip: true, file: path.join(userData, 'fixture.tar.gz'), cwd: fixture },
      fs.readdirSync(fixture),
    );
    const full = fs.readFileSync(path.join(userData, 'fixture.tar.gz'));
    serve(
      'github',
      manifest('2026.11.05', sha(full), 'windows-tar'),
      full,
      'tar.gz',
    );
    const { provenance } = await downloader.download(
      'github',
      '13.0.2',
      'tar.gz',
    );
    assert.deepEqual(fs.readFileSync(path.join(dir, 'addon.node')), binary);
    assert.equal(
      fs.readFileSync(path.join(dir, 'cudart64_13.dll'), 'utf8'),
      'new runtime',
    );
    assert.equal(provenance.packageSha256, sha(full));
    assert.equal(provenance.addonSha256, sha(binary));
  });

  await test('cancellation while fetching metadata does not fall back or change the installation', async () => {
    const dir = previousInstall();
    routes.set('/github/addon-versions.json', (_req, res) => {
      downloader.cancel();
      res.end(JSON.stringify(manifest()));
    });
    await assert.rejects(
      downloader.download('github', '13.0.2', 'node.gz'),
      /cancelled/i,
    );
    assert.deepEqual(requests, ['/github/addon-versions.json']);
    assert.equal(
      fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
      'working old addon',
    );
  });

  await test('cancellation during verification preserves the installation and stops mirror fallback', async () => {
    const dir = previousInstall();
    serve('github');
    onProgress = (progress) => {
      if (progress.status === 'verifying') downloader.cancel();
    };
    await assert.rejects(
      downloader.download('github', '13.0.2', 'node.gz'),
      /cancelled/i,
    );
    assert.ok(requests.every((url) => url.startsWith('/github/')));
    assert.equal(
      fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
      'working old addon',
    );
  });

  await test('a failed directory replacement restores the previous plugin and its DLLs', async () => {
    const dir = previousInstall();
    serve('github');
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (
        String(from).includes('-staging-') &&
        !String(from).endsWith('-backup') &&
        to === dir
      )
        throw Object.assign(new Error('simulated locked directory'), {
          code: 'EPERM',
        });
      return rename(from, to);
    };
    try {
      await assert.rejects(downloader.download('github', '13.0.2', 'node.gz'));
      assert.equal(
        fs.readFileSync(path.join(dir, 'addon.node'), 'utf8'),
        'working old addon',
      );
      assert.equal(
        fs.readFileSync(path.join(dir, 'cudart64_13.dll'), 'utf8'),
        'old runtime',
      );
      assert.ok(
        !fs
          .readdirSync(path.dirname(dir))
          .some((name) => name.includes('-staging-')),
      );
    } finally {
      fs.promises.rename = rename;
    }
  });

  await test('Vulkan packages use their own manifest checksum and preserve the manifest snapshot', async () => {
    const metadata = {
      vulkan: {
        version: '2026.10.21',
        checksum: { 'windows-node': sha(archive) },
      },
    };
    routes.set('/github/addon-versions.json', metadata);
    routes.set('/github/addon-windows-vulkan.node.gz', (_req, res) => {
      metadata.vulkan.version = '2026.11.05';
      res.end(archive);
    });
    const { provenance } = await downloader.download(
      'github',
      'vulkan',
      'node.gz',
    );
    assert.equal(provenance.releaseVersion, '2026.10.21');
    assert.equal(provenance.packageSha256, sha(archive));
    assert.equal(manager.getInstalledAddons()[0].version, 'vulkan');
  });

  await test('download endpoint credentials are excluded from persisted installation records', async () => {
    serve('github');
    const originalBase = baseUrl;
    baseUrl = baseUrl.replace('http://', 'http://fixture-user:fixture-secret@');
    try {
      const result = await downloader.download('github', '13.0.2', 'node.gz');
      assert.ok(!JSON.stringify(result.provenance).includes('fixture-secret'));
      assert.equal(
        result.provenance.manifestUrl,
        `${originalBase}/github/addon-versions.json`,
      );
    } finally {
      baseUrl = originalBase;
    }
  });

  await test('existing installations remain usable without invented verification records', () => {
    previousInstall();
    assert.equal(manager.getInstalledAddons()[0].info.provenance, undefined);
  });

  await test('IPC rejects a retry while cancellation is pending and allows retry after it settles', async () => {
    const activeDownloader = getAddonDownloader();
    serve('github');
    let waitingResponse;
    let requestStarted;
    const entered = new Promise((resolve) => {
      requestStarted = resolve;
    });
    routes.set(
      '/github/addon-windows-cuda-1302-optimized.node.gz',
      (_req, res) => {
        waitingResponse = res;
        requestStarted();
      },
    );
    const pending = activeDownloader.download('github', '13.0.2', 'node.gz');
    await entered;
    await handlers.get('cancel-addon-download')({});
    try {
      const result = await handlers.get('start-addon-download')(
        {},
        {
          source: 'github',
          variant: '13.0.2',
          type: 'node.gz',
        },
      );
      assert.equal(result.success, false);
      assert.match(result.error, /already running/i);
      assert.equal(requests.length, 2);
    } finally {
      waitingResponse.end(archive);
      await assert.rejects(pending, /cancelled/i);
    }
    serve('github');
    const retried = await activeDownloader.download(
      'github',
      '13.0.2',
      'node.gz',
    );
    assert.equal(retried.provenance.addonSha256, sha(binary));
  });

  await test('IPC registration uses the verified download record instead of querying latest again', async () => {
    serve('github');
    const completed = new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('installation did not complete')),
        3000,
      );
      handlers
        .get('start-addon-download')(
          {},
          { source: 'github', variant: '13.0.2', type: 'node.gz' },
        )
        .then(() => {
          const poll = () => {
            const info = manager.getAddonConfig().installed['13.0.2'];
            if (info?.provenance) {
              clearTimeout(deadline);
              resolve(info);
            } else if (process.exitCode !== 1) setTimeout(poll, 10).unref();
          };
          poll();
        }, reject);
    });
    const info = await completed;
    assert.equal(info.remoteVersion, '2026.11.05');
    assert.equal(info.checksum, sha(archive));
    assert.equal(info.provenance.addonSha256, sha(binary));
  });

  console.log(`${passed} addon installation checks passed`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise((resolve) => server.close(resolve));
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
    fs.rmSync(root, { recursive: true, force: true });
  });
