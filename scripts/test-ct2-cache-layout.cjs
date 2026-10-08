/**
 * Regression test for issue #519: pointing the faster-whisper model path at an
 * existing HuggingFace cache must never relocate the models--* folders in it.
 *
 * getFasterWhisperHubDir() used to run migrateLegacyCt2Layout() on every call,
 * renaming each <root>/models--* folder into <root>/hub/. The function is
 * reached from the model list refresh, from transcription and from downloads,
 * so a cache shared with other HuggingFace tools was rewritten as soon as the
 * path was set and the UI refreshed.
 *
 * Deleting follows the model, not who created the folder: pointing the model
 * path at a shared cache is a deliberate choice, and the user confirms every
 * delete. deleteCt2Model therefore removes that one models--<repo> folder
 * wherever SmartSub finds it (under hub/, at the root of the model path, in its
 * app-data cache). Other repos in the same cache and HuggingFace's .locks
 * folder are never touched, and an id outside the catalog never reaches the
 * file system.
 *
 * Drives the real modelCatalog.ts and fasterWhisperModelDownloader.ts together
 * with the real storagePaths, snapshot validation and faster-whisper catalog.
 * Only electron, the electron-store
 * backed storeManager and whisper.ts (a native-addon import chain that
 * modelCatalog only needs for the ggml path) are replaced. Every scenario gets
 * its own model path, so a failure never hides the rest.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let base; // temp dir holding one model path per scenario
let modelRoot; // the faster-whisper model path the stubbed settings point at
let passed = 0;
let failed = 0;

// Folder names are HuggingFace's own on-disk convention, not SmartSub's:
// models--<owner>--<repo>. Spelled out so they do not depend on the code under test.
const LARGE_V3 = 'models--Systran--faster-whisper-large-v3';
const BASE = 'models--Systran--faster-whisper-base';
const REVISION = '0123456789abcdef0123456789abcdef01234567';

require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => base } };
  if (request.endsWith('/storeManager'))
    return {
      logMessage() {},
      store: { get: () => ({ fasterWhisperModelsPath: modelRoot }) },
    };
  if (request.endsWith('/whisper')) return { getPath: () => base };
  return originalLoad.call(this, request, parent, isMain);
};

function step(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    const detail = String(error?.message ?? error)
      .trim()
      .split('\n')
      .slice(0, 6)
      .join('\n         ');
    console.log(`FAIL - ${name}\n         ${detail}`);
  }
}

function newModelRoot(name) {
  return fs.mkdtempSync(path.join(base, `${name}-`));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A complete CT2 model in the HuggingFace cache layout (refs + one snapshot). */
function makeCt2Repo(dir, name, revision = REVISION) {
  const {
    CT2_REQUIRED_CONFIG_ARRAYS,
  } = require('../main/helpers/modelImport.ts');
  const config = Object.fromEntries(
    CT2_REQUIRED_CONFIG_ARRAYS.map((key) => [key, [1, 2, 3]]),
  );
  const snapshot = path.join(dir, name, 'snapshots', revision);
  write(path.join(dir, name, 'refs', 'main'), revision);
  write(path.join(snapshot, 'model.bin'), 'weights');
  write(path.join(snapshot, 'config.json'), JSON.stringify(config));
  return snapshot;
}

/** A repo another HuggingFace tool keeps in the same cache; SmartSub has no use for it. */
function makeForeignRepo(dir, name) {
  write(path.join(dir, name, 'blobs', 'a1b2c3'), 'blob');
  write(path.join(dir, name, 'refs', 'main'), 'deadbeef');
  write(path.join(dir, name, 'snapshots', 'deadbeef', 'weights.bin'), 'blob');
}

/**
 * An existing HF_HUB_CACHE as the reporter had it: models--* straight under the
 * directory, shared with other software, plus the .locks folder HF keeps there.
 * Returns the snapshot folder of the one repo SmartSub knows about.
 */
function makeSharedHfCache(dir) {
  makeForeignRepo(dir, 'models--sentence-transformers--all-MiniLM-L6-v2');
  makeForeignRepo(dir, 'models--openai--clip-vit-base-patch32');
  write(
    path.join(dir, '.locks', 'models--openai--clip-vit-base-patch32', 'lock'),
    '',
  );
  return makeCt2Repo(dir, LARGE_V3);
}

/** Every file and folder under dir with its size, so any move shows up as a diff. */
function treeOf(dir, prefix = '') {
  const lines = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      lines.push(`${relative}/`, ...treeOf(full, relative));
    } else {
      lines.push(`${relative} (${fs.statSync(full).size} bytes)`);
    }
  }
  return lines;
}

function assertTreeUntouched(before, dir, message) {
  // A folder that was deleted outright is the clearest "removed", not an ENOENT.
  const after = fs.existsSync(dir) ? treeOf(dir) : [];
  const gone = before.filter((line) => !after.includes(line));
  const appeared = after.filter((line) => !before.includes(line));
  const show = (lines) => lines.slice(0, 3).join(', ') || '-';
  assert.ok(
    gone.length === 0 && appeared.length === 0,
    `${message}\n  moved or removed: ${show(gone)}\n  appeared: ${show(appeared)}`,
  );
}

/**
 * The entry points that reach getFasterWhisperHubDir(): the model list the UI
 * refreshes (getSystemInfo), the lookups transcription runs, the download target.
 */
function lookUp(catalog, modelId) {
  return {
    installed: catalog.getFasterWhisperModelsInstalled(),
    snapshotDir: catalog.resolveCt2ModelSnapshotDir(modelId),
    cacheDir: catalog.getCt2ModelCacheDir(modelId),
  };
}

function run() {
  const catalog = require('../main/helpers/modelCatalog.ts');
  const downloader = require('../main/helpers/fasterWhisperModelDownloader.ts');

  step('a shared HuggingFace cache is left exactly as it was', () => {
    modelRoot = newModelRoot('shared');
    makeSharedHfCache(modelRoot);
    const before = treeOf(modelRoot);

    lookUp(catalog, 'large-v3');

    assertTreeUntouched(
      before,
      modelRoot,
      'models--* folders must stay where the other tools expect them',
    );
  });

  step('a model in a shared cache is used where it is', () => {
    modelRoot = newModelRoot('in-place');
    const snapshot = makeSharedHfCache(modelRoot);

    const found = lookUp(catalog, 'large-v3');

    assert.deepEqual(found.installed, ['large-v3']);
    assert.equal(
      found.snapshotDir,
      snapshot,
      'the snapshot at the top of the cache is the one handed to the engine',
    );
  });

  step('looking models up does not create a hub folder', () => {
    modelRoot = newModelRoot('empty');

    lookUp(catalog, 'large-v3');

    assert.deepEqual(
      treeOf(modelRoot),
      [],
      'hub/ should only appear once SmartSub downloads something into it',
    );
  });

  step(
    'models SmartSub put under hub/ are still found and stay the download target',
    () => {
      modelRoot = newModelRoot('hub');
      const hub = path.join(modelRoot, 'hub');
      const snapshot = makeCt2Repo(hub, LARGE_V3);
      const before = treeOf(modelRoot);

      const found = lookUp(catalog, 'large-v3');

      assert.deepEqual(found.installed, ['large-v3']);
      assert.equal(found.snapshotDir, snapshot);
      assert.equal(
        found.cacheDir,
        path.join(hub, LARGE_V3),
        'new downloads keep landing under hub/',
      );
      assertTreeUntouched(before, modelRoot, 'nothing under hub/ is rewritten');
    },
  );

  step(
    'models at the root and under hub/ are both listed and neither is moved',
    () => {
      modelRoot = newModelRoot('both');
      // The folder the model import wrote at the root before it targeted hub/.
      const rootSnapshot = makeCt2Repo(modelRoot, LARGE_V3, 'imported');
      const hubSnapshot = makeCt2Repo(path.join(modelRoot, 'hub'), BASE);
      const before = treeOf(modelRoot);

      assert.deepEqual(catalog.getFasterWhisperModelsInstalled(), [
        'base',
        'large-v3',
      ]);
      assert.equal(
        catalog.resolveCt2ModelSnapshotDir('large-v3'),
        rootSnapshot,
      );
      assert.equal(catalog.resolveCt2ModelSnapshotDir('base'), hubSnapshot);
      assertTreeUntouched(before, modelRoot, 'neither layout is rewritten');
    },
  );

  step(
    'deleting a model in a shared HuggingFace cache removes that model only',
    () => {
      modelRoot = newModelRoot('delete-shared');
      makeSharedHfCache(modelRoot);
      const neighbours = [
        'models--sentence-transformers--all-MiniLM-L6-v2',
        'models--openai--clip-vit-base-patch32',
        '.locks',
      ].map((name) => [name, treeOf(path.join(modelRoot, name))]);

      downloader.deleteCt2Model('large-v3');

      assert.equal(
        fs.existsSync(path.join(modelRoot, LARGE_V3)),
        false,
        'the user chose this folder and confirmed the delete, so the model goes',
      );
      for (const [name, before] of neighbours) {
        assertTreeUntouched(
          before,
          path.join(modelRoot, name),
          `${name} belongs to another tool and stays`,
        );
      }
      assert.deepEqual(
        catalog.getFasterWhisperModelsInstalled(),
        [],
        'the model list stops reporting a model that was deleted',
      );
    },
  );

  step(
    'deleting removes every copy of the model, under hub/ and at the root',
    () => {
      modelRoot = newModelRoot('delete-both');
      const hub = path.join(modelRoot, 'hub');
      // Same model twice: the root one is what the import used to write.
      makeCt2Repo(modelRoot, LARGE_V3, 'imported');
      makeCt2Repo(hub, LARGE_V3);
      makeCt2Repo(hub, BASE);
      const otherModel = treeOf(path.join(hub, BASE));

      downloader.deleteCt2Model('large-v3');

      assert.equal(fs.existsSync(path.join(hub, LARGE_V3)), false);
      assert.equal(
        fs.existsSync(path.join(modelRoot, LARGE_V3)),
        false,
        'a copy left behind would keep the model listed as installed',
      );
      assertTreeUntouched(
        otherModel,
        path.join(hub, BASE),
        'other models stay',
      );
      assert.deepEqual(catalog.getFasterWhisperModelsInstalled(), ['base']);
    },
  );

  step('an id outside the model catalog never reaches the file system', () => {
    modelRoot = newModelRoot('delete-unknown');
    makeSharedHfCache(modelRoot);
    const before = treeOf(modelRoot);

    // Includes the exact folder name of another tool's repo: only catalog ids
    // map to a folder, so naming the folder instead of the model deletes nothing.
    for (const id of [
      '../hub',
      'models--openai--clip-vit-base-patch32',
      'openai/clip-vit-base-patch32',
      '',
    ]) {
      for (const call of ['getCt2DeleteTargets', 'deleteCt2Model']) {
        assert.throws(
          () => downloader[call](id),
          /Unknown faster-whisper model/,
          `${call}(${JSON.stringify(id)})`,
        );
      }
    }
    assertTreeUntouched(before, modelRoot, 'a made-up id removes nothing');
  });

  step(
    'the folders shown before a delete are exactly the ones it removes',
    () => {
      modelRoot = newModelRoot('targets');
      const hub = path.join(modelRoot, 'hub');
      const engineCache = path.join(base, 'py-engine-cache');
      fs.rmSync(engineCache, { recursive: true, force: true });
      makeCt2Repo(hub, LARGE_V3);
      makeCt2Repo(modelRoot, LARGE_V3, 'imported');
      makeCt2Repo(path.join(engineCache, 'hub'), LARGE_V3);
      makeCt2Repo(engineCache, LARGE_V3);
      makeCt2Repo(hub, BASE); // another model: not part of this delete
      const before = treeOf(modelRoot);

      const targets = downloader.getCt2DeleteTargets('large-v3');

      assert.deepEqual(targets, [
        path.join(hub, LARGE_V3),
        path.join(modelRoot, LARGE_V3),
        path.join(engineCache, 'hub', LARGE_V3),
        path.join(engineCache, LARGE_V3),
      ]);
      assertTreeUntouched(before, modelRoot, 'listing is read-only');

      downloader.deleteCt2Model('large-v3');

      for (const dir of targets) {
        assert.equal(fs.existsSync(dir), false, `${dir} should be gone`);
      }
      assert.deepEqual(downloader.getCt2DeleteTargets('large-v3'), []);
      assert.ok(
        fs.existsSync(path.join(hub, BASE)),
        'a model that was not asked for is not listed and not deleted',
      );
      fs.rmSync(engineCache, { recursive: true, force: true });
    },
  );

  step(
    'listing the folders of a model that is not on disk creates nothing',
    () => {
      modelRoot = newModelRoot('targets-empty');
      fs.rmSync(path.join(base, 'py-engine-cache'), {
        recursive: true,
        force: true,
      });

      assert.deepEqual(downloader.getCt2DeleteTargets('large-v3'), []);
      assert.deepEqual(
        treeOf(modelRoot),
        [],
        'a preview must not create hub/ in the user\u2019s folder',
      );
    },
  );

  step(
    'deleting still cleans the engine cache SmartSub keeps in app data',
    () => {
      modelRoot = newModelRoot('delete-app-data');
      // The stubbed userData is `base`; this is where the engine cached models
      // before SmartSub had its own downloader.
      const engineCache = path.join(base, 'py-engine-cache');
      fs.rmSync(engineCache, { recursive: true, force: true });
      makeCt2Repo(path.join(engineCache, 'hub'), LARGE_V3);
      makeCt2Repo(engineCache, LARGE_V3);
      makeCt2Repo(engineCache, BASE);

      downloader.deleteCt2Model('large-v3');

      assert.equal(
        fs.existsSync(path.join(engineCache, 'hub', LARGE_V3)),
        false,
      );
      assert.equal(fs.existsSync(path.join(engineCache, LARGE_V3)), false);
      assert.ok(
        fs.existsSync(path.join(engineCache, BASE)),
        'only the model that was asked for goes',
      );
      fs.rmSync(engineCache, { recursive: true, force: true });
    },
  );
}

base = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-ct2-layout-'));
try {
  run();
  if (failed) {
    console.error(`CT2 cache layout: ${failed} failed, ${passed} passed`);
    process.exitCode = 1;
  } else {
    console.log(`CT2 cache layout: ${passed} checks passed`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  Module._load = originalLoad;
  if (originalTs) require.extensions['.ts'] = originalTs;
  else delete require.extensions['.ts'];
  fs.rmSync(base, { recursive: true, force: true });
}
