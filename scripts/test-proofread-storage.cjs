/*
 * Offline checks for where the proofread sidecar lives (openspec change
 * manage-proofread-data-storage). New sidecars are written to a managed folder
 * the host injects (userData/proofread-data). A host that never injects one
 * keeps the old neighbour path, and sidecars that already exist keep working
 * where they are.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const logs = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const normalized = String(request).replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: { getVersion: () => 'test', getPath: () => repoRoot },
      ipcMain: { handle: () => undefined, on: () => undefined },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (normalized.endsWith('/storeManager')) {
    return {
      logMessage: (message, type) =>
        logs.push({ message: String(message), type }),
      store: { get: () => ({}) },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  });
  module._compile(output.outputText, filename);
};

const {
  getProofreadDataPath,
  readProofreadDataFile,
  updateProofreadDataOutputs,
  writeProofreadDataFromFiles,
} = require('../main/helpers/proofreadData.ts');
const storage = require('../main/helpers/proofreadDataStorage.ts');

let passed = 0;
let failed = 0;
function ok(value, message) {
  if (value) passed += 1;
  else {
    failed += 1;
    console.error(`\u2717 ${message}`);
  }
}
function same(actual, expected, message) {
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  ok(matches, message);
  if (!matches) {
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}
async function attempt(task) {
  try {
    return { value: await task() };
  } catch (error) {
    return { error };
  }
}
function errorText(error) {
  return error ? String(error.message || error) : '';
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
}
function srt(cues) {
  return cues
    .map(
      ([start, end, text], index) =>
        `${index + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${text}\n`,
    )
    .join('\n');
}

function fileFor(directory, uuid, name = 'movie') {
  return {
    uuid,
    filePath: path.join(directory, `${name}.mp4`),
    fileName: `${name}.mp4`,
    fileExtension: '.mp4',
    directory,
  };
}
async function writeSubtitle(directory, name = 'movie') {
  await fs.promises.mkdir(directory, { recursive: true });
  const sourceFile = path.join(directory, `${name}.srt`);
  await fs.promises.writeFile(
    sourceFile,
    srt([
      [0, 1000, 'hello'],
      [1500, 2500, 'world'],
    ]),
    'utf8',
  );
  return sourceFile;
}
function listDir(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function testWithoutManagedFolder(tmp) {
  storage.setProofreadDataRoot(undefined);
  same(
    storage.getProofreadDataRoot(),
    undefined,
    'there is no managed folder until the host injects one',
  );
  same(
    storage.LEGACY_PROOFREAD_DIR,
    '.smartsub-proofread',
    'the old neighbour folder name is defined once',
  );
  const videoDir = path.join(tmp, 'plain');
  same(
    getProofreadDataPath(fileFor(videoDir, 'u1')),
    path.join(videoDir, '.smartsub-proofread', 'movie.mp4.u1.json'),
    'without a managed folder the sidecar keeps the old neighbour path',
  );
}

function testManagedPath(tmp) {
  const root = path.join(tmp, 'userData', 'proofread-data');
  const videoDir = path.join(tmp, 'videos');
  storage.setProofreadDataRoot(root);
  try {
    same(
      storage.getProofreadDataRoot(),
      root,
      'reports the folder the host injected',
    );
    same(
      getProofreadDataPath(fileFor(videoDir, 'u1')),
      path.join(root, 'movie.mp4.u1.json'),
      'a new sidecar is named <file>.<id>.json inside the managed folder',
    );
    same(
      getProofreadDataPath(fileFor(path.join(tmp, 'other'), 'u2')),
      path.join(root, 'movie.mp4.u2.json'),
      'the id keeps same-named files from different folders apart',
    );

    const withoutId = fileFor(videoDir, undefined);
    const hash = crypto
      .createHash('md5')
      .update(withoutId.filePath)
      .digest('hex')
      .slice(0, 12);
    same(
      getProofreadDataPath(withoutId),
      path.join(root, `movie.mp4.${hash}.json`),
      'a file without an id is named after a hash of its path, as before',
    );
    same(
      path.basename(getProofreadDataPath(fileFor(videoDir, 'a/b:c'))),
      'movie.mp4.a_b_c.json',
      'characters that are unsafe in a file name are replaced, as before',
    );
    same(
      path.basename(
        getProofreadDataPath({
          ...fileFor(videoDir, 'u3'),
          fileName: `${'x'.repeat(120)}.mp4`,
        }),
      ),
      `${'x'.repeat(80)}.u3.json`,
      'long file names are cut to 80 characters, as before',
    );
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
  same(
    getProofreadDataPath(fileFor(videoDir, 'u1')),
    path.join(videoDir, '.smartsub-proofread', 'movie.mp4.u1.json'),
    'clearing the managed folder restores the old neighbour path',
  );
}

async function testNewSidecarIsWrittenToManagedFolder(tmp) {
  const root = path.join(tmp, 'userData-write', 'proofread-data');
  const videoDir = path.join(tmp, 'videos-write');
  const sourceFile = await writeSubtitle(videoDir);
  storage.setProofreadDataRoot(root);
  try {
    const written = await writeProofreadDataFromFiles({
      file: fileFor(videoDir, 'w1'),
      sourceFile,
    });
    ok(written.ok, 'writes a sidecar even if the managed folder is missing');
    if (!written.ok) return;
    same(
      written.filePath,
      path.join(root, 'movie.mp4.w1.json'),
      'the sidecar lands in the managed folder',
    );
    same(
      listDir(root),
      ['movie.mp4.w1.json'],
      'the managed folder holds only the sidecar, no temp files',
    );
    same(
      listDir(videoDir),
      ['movie.srt'],
      'nothing is created beside the video',
    );

    const strict = await attempt(() =>
      readProofreadDataFile(written.filePath, { strict: true }),
    );
    ok(
      !strict.error,
      `the proofread panel can open it (${errorText(strict.error)})`,
    );
    same(
      strict.value && strict.value.meta.sourceFile,
      sourceFile,
      'it still records the subtitle it was built from',
    );
    same(
      strict.value && strict.value.cues.map((cue) => cue.source),
      ['hello', 'world'],
      'it holds the recognised text',
    );
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
}

async function testExistingSidecarsStayWhereTheyAre(tmp) {
  const videoDir = path.join(tmp, 'videos-legacy');
  const sourceFile = await writeSubtitle(videoDir);
  const file = fileFor(videoDir, 'l1');
  storage.setProofreadDataRoot(undefined);
  const legacy = await writeProofreadDataFromFiles({ file, sourceFile });
  ok(legacy.ok, 'writes a sidecar the way an older version did');
  if (!legacy.ok) return;
  same(
    legacy.filePath,
    path.join(videoDir, '.smartsub-proofread', 'movie.mp4.l1.json'),
    'the older sidecar sits beside the video',
  );

  const root = path.join(tmp, 'userData-legacy', 'proofread-data');
  storage.setProofreadDataRoot(root);
  try {
    const strict = await attempt(() =>
      readProofreadDataFile(legacy.filePath, { strict: true }),
    );
    ok(
      !strict.error,
      `an older sidecar still opens once a managed folder exists (${errorText(strict.error)})`,
    );

    const finalFile = path.join(videoDir, 'movie.final.srt');
    await updateProofreadDataOutputs({
      ...file,
      proofreadDataFile: legacy.filePath,
      srtFile: sourceFile,
      translatedSrtFile: finalFile,
    });
    const onDisk = JSON.parse(
      await fs.promises.readFile(legacy.filePath, 'utf8'),
    );
    same(
      onDisk.meta.finalTargetFile,
      finalFile,
      'updating it rewrites the same file',
    );
    same(listDir(root), [], 'no copy appears in the managed folder');
    same(
      listDir(path.join(videoDir, '.smartsub-proofread')),
      ['movie.mp4.l1.json'],
      'the old folder still holds just that sidecar',
    );
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
}

function testHostInjectsTheManagedFolder() {
  const source = fs.readFileSync(
    path.join(repoRoot, 'main', 'helpers', 'ipcProofreadHandlers.ts'),
    'utf8',
  );
  ok(
    /setProofreadDataRoot\(\s*path\.join\(app\.getPath\('userData'\),\s*'proofread-data'\),?\s*\)/.test(
      source,
    ),
    'setupProofreadHandlers points the managed folder at userData/proofread-data',
  );
}

async function run() {
  const tmp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-proofread-storage-'),
  );
  try {
    testWithoutManagedFolder(tmp);
    testManagedPath(tmp);
    await testNewSidecarIsWrittenToManagedFolder(tmp);
    await testExistingSidecarsStayWhereTheyAre(tmp);
    testHostInjectsTheManagedFolder();
  } finally {
    storage.setProofreadDataRoot(undefined);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

run()
  .then(() => {
    console.log(
      `Proofread data storage tests: ${passed} passed, ${failed} failed`,
    );
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
