'use strict';
// Exercise the real installer against a local HTTP server and tiny model archive.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-parakeet-'));
const modelsRoot = path.join(temporary, 'models');
const settings = { parakeetModelsPath: modelsRoot };
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id === 'electron')
    return {
      app: {
        getPath: () => temporary,
        getAppPath: () => root,
        isPackaged: false,
      },
    };
  if (
    parent?.filename.startsWith(path.join(root, 'main')) &&
    /(?:^|\/)store(?:Manager)?$/.test(id)
  ) {
    return {
      store: { get: (key) => (key === 'settings' ? settings : undefined) },
      logMessage() {},
    };
  }
  return originalLoad.call(this, id, parent, isMain);
};
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const catalog = require('../main/helpers/parakeetModelCatalog.ts');
const {
  ParakeetModelDownloader,
} = require('../main/helpers/parakeetModelDownloader.ts');
const {
  readModelIntegrityManifest,
  verifyInstalledModelFiles,
} = require('../main/helpers/download/modelIntegrity.ts');
const spec = catalog.PARAKEET_MODELS['orukeet-v0.1.0-int8'];
const savedSource = spec.huggingFace;
const digest = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const source = path.join(temporary, spec.archiveInnerDir);
fs.mkdirSync(source);
const files = spec.requiredFiles.map((name) => {
  const bytes = Buffer.from(`fixture contents for ${name}\n`);
  fs.writeFileSync(path.join(source, name), bytes);
  return { path: name, bytes: bytes.length, sha256: digest(bytes) };
});
const archivePath = path.join(temporary, spec.archiveName);
execFileSync('tar', [
  '-cjf',
  archivePath,
  '-C',
  temporary,
  spec.archiveInnerDir,
]);
const archive = fs.readFileSync(archivePath);
const manifest = {
  archive: spec.archiveName,
  archive_bytes: archive.length,
  archive_sha256: digest(archive),
  files,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
let mode = 'valid';
let requests = 0;
let manifestStarted;
let checks = 0;
const server = http.createServer((req, res) => {
  requests++;
  const isManifest = req.url.endsWith('/manifest.json');
  if (isManifest && mode === 'hold') {
    res.writeHead(200, { 'Content-Length': manifestBytes.length });
    res.write(manifestBytes.subarray(0, 1));
    manifestStarted();
    return;
  }
  let data = isManifest ? manifestBytes : archive;
  if (
    (isManifest && mode === 'bad-manifest') ||
    (!isManifest && mode === 'bad-archive')
  ) {
    data = Buffer.from(data);
    data[0] ^= 1;
  }
  res.writeHead(200, { 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
});
const check = async (name, run) => {
  await run();
  checks++;
  console.log(`ok ${checks} - ${name}`);
};

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  spec.huggingFace = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    manifestSha256: digest(manifestBytes),
    archiveSha256: digest(archive),
  };
  const downloader = new ParakeetModelDownloader();
  const destination = path.join(modelsRoot, spec.dirName);
  const assertClean = () =>
    assert.deepEqual(
      fs
        .readdirSync(modelsRoot)
        .filter(
          (n) =>
            n.includes('.download-') ||
            n.includes('.install-') ||
            n.includes('.backup-'),
        ),
      [],
    );
  await check(
    'fresh installation verifies and retains manifest, weights, and license',
    async () => {
      assert.equal(await downloader.download(spec.id, 'ghproxy'), true);
      assert.equal(catalog.isParakeetModelInstalled(spec.id), true);
      assert.deepEqual(
        fs.readFileSync(path.join(destination, 'manifest.json')),
        manifestBytes,
      );
      await verifyInstalledModelFiles(destination, manifest);
      assertClean();
    },
  );
  await check('cached installation performs no network requests', async () => {
    const before = requests;
    assert.equal(await downloader.download(spec.id), true);
    assert.equal(requests, before);
  });
  await check(
    'corrupt manifest leaves existing incomplete directory untouched',
    async () => {
      catalog.deleteParakeetModel(spec.id);
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing');
      mode = 'bad-manifest';
      await assert.rejects(downloader.download(spec.id), /checksum mismatch/);
      assert.equal(
        fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'),
        'existing',
      );
      assert.equal(catalog.isParakeetModelInstalled(spec.id), false);
      assertClean();
    },
  );
  await check('corrupt archive cannot become an installed model', async () => {
    mode = 'bad-archive';
    await assert.rejects(downloader.download(spec.id), /checksum mismatch/);
    assert.equal(catalog.isParakeetModelInstalled(spec.id), false);
    assertClean();
  });
  await check(
    'cancellation stops a pending manifest and releases the installer',
    async () => {
      mode = 'hold';
      const started = new Promise((resolve) => {
        manifestStarted = resolve;
      });
      const run = downloader.download(spec.id);
      const rejected = assert.rejects(run, /Download cancelled/);
      await started;
      await assert.rejects(
        downloader.download(spec.id),
        /another Parakeet model download/,
      );
      await downloader.cancel();
      await rejected;
      assertClean();
    },
  );
  await check(
    'retry after cancellation installs successfully and deletes cleanly',
    async () => {
      mode = 'valid';
      assert.equal(await downloader.download(spec.id), true);
      assert.equal(fs.existsSync(path.join(destination, 'keep.txt')), false);
      catalog.deleteParakeetModel(spec.id);
      assert.equal(catalog.isParakeetModelInstalled(spec.id), false);
      assertClean();
    },
  );
  await check(
    'manifest rejects traversal, duplicates, and missing required files',
    async () => {
      const bad = [
        {
          ...manifest,
          files: [{ ...files[0], path: '../outside' }, ...files.slice(1)],
        },
        { ...manifest, files: [...files, files[0]] },
        { ...manifest, files: files.slice(1) },
      ];
      const filename = path.join(temporary, 'invalid.json');
      for (const value of bad) {
        const bytes = Buffer.from(JSON.stringify(value));
        fs.writeFileSync(filename, bytes);
        await assert.rejects(
          readModelIntegrityManifest(
            filename,
            { ...spec.huggingFace, manifestSha256: digest(bytes) },
            spec.archiveName,
            spec.requiredFiles,
          ),
          /does not match/,
        );
      }
    },
  );
  await check(
    'installed-file validation rejects modified graphs and symlinks',
    async () => {
      const file = path.join(source, files[0].path);
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.alloc(original.length, 1));
      await assert.rejects(
        verifyInstalledModelFiles(source, manifest),
        /checksum mismatch/,
      );
      fs.rmSync(file);
      fs.symlinkSync(path.join(source, files[1].path), file);
      await assert.rejects(
        verifyInstalledModelFiles(source, manifest),
        /size or type mismatch/,
      );
    },
  );
  console.log(`${checks} installer checks passed`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    spec.huggingFace = savedSource;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
