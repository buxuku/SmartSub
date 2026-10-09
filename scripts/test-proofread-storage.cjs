/*
 * Offline checks for where the proofread sidecar lives (openspec change
 * manage-proofread-data-storage). New sidecars are written to a managed folder
 * the host injects (userData/proofread-data). A host that never injects one
 * keeps the old neighbour path, and sidecars that already exist keep working
 * where they are. Deleting a work item removes the managed sidecars nothing
 * else uses, and never touches anything outside the managed folder.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const logs = [];
const ipcHandlers = new Map();
// Stands in for electron-store behind the work item list.
const memoryStore = {
  disk: {},
  failWrites: false,
  get(key) {
    return structuredClone(this.disk[key]);
  },
  set(key, value) {
    if (this.failWrites) throw new Error('ENOSPC: test disk is full');
    Object.assign(
      this.disk,
      structuredClone(typeof key === 'string' ? { [key]: value } : key),
    );
  },
  delete(key) {
    delete this.disk[key];
  },
};
// What the work item deletion handler imports from parts of the app that need
// Electron or a running window; it only touches these few members.
const handlerStubs = {
  '../automation/handlers': {
    ipcMain: {
      handle: (name, handler) => ipcHandlers.set(name, handler),
      on: () => undefined,
    },
  },
  './store': { store: memoryStore },
  './dubbing/dubbingProcessor': {
    forgetDubbingSession: () => undefined,
    getDubbingSession: () => undefined,
  },
  './videoDownload/scheduler': { cancelDownloadBatch: () => undefined },
  './taskProcessor': { isTaskProjectBusy: () => false },
};
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
  if (Object.hasOwn(handlerStubs, normalized)) return handlerStubs[normalized];
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
const workItems = require('../main/helpers/workItemStore.ts');
const {
  setupWorkItemHandlers,
} = require('../main/helpers/workItemHandlers.ts');

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
/** One section blowing up must not hide what the others report. */
async function section(name, task) {
  try {
    await task();
  } catch (error) {
    failed += 1;
    console.error(`\u2717 ${name} threw: ${errorText(error)}`);
  }
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

function testManagedPathGuards(tmp) {
  storage.setProofreadDataRoot(undefined);
  const root = path.join(tmp, 'guards', 'proofread-data');
  const inside = (name) => path.join(root, name);
  const isManaged = (filePath) =>
    storage.isManagedProofreadPath(filePath, root);

  ok(
    isManaged(inside('movie.mp4.u1.json')),
    'a .json file directly in the managed folder is managed',
  );
  ok(isManaged(inside('MOVIE.JSON')), 'the extension check ignores case');
  const jsonNamedRoot = path.join(tmp, 'guards', 'folder.json');
  ok(
    !storage.isManagedProofreadPath(jsonNamedRoot, jsonNamedRoot),
    'the managed folder itself is never a target, even if its name ends in .json',
  );
  ok(
    !isManaged(path.join(root, 'sub', 'a.json')),
    'files in sub-folders are not managed',
  );
  ok(
    !isManaged(`${root}${path.sep}..${path.sep}outside.json`),
    'a path that climbs out of the folder is rejected',
  );
  ok(
    !isManaged(path.join(`${root}-evil`, 'a.json')),
    'a sibling folder that only shares the prefix is rejected',
  );
  ok(!isManaged(inside('notes.txt')), 'only .json files are managed');
  ok(
    !isManaged(inside('.movie.json.1234.abcd.tmp')),
    'leftover temp files are not managed',
  );
  ok(
    !isManaged(path.join(tmp, 'videos', '.smartsub-proofread', 'old.json')),
    'the old folder beside a video is not managed',
  );
  ok(!isManaged('a.json'), 'a relative path is rejected');
  ok(!isManaged(''), 'an empty path is rejected');
  ok(!isManaged(undefined), 'a missing path is rejected');
  ok(
    !storage.isManagedProofreadPath(inside('a.json')),
    'nothing is managed until the host injects the folder',
  );

  const win = path.win32;
  const winRoot = 'C:\\Users\\Me\\AppData\\Roaming\\SmartSub\\proofread-data';
  const isWinManaged = (filePath) =>
    storage.isManagedProofreadPath(filePath, winRoot, win);
  ok(
    isWinManaged(`${winRoot}\\movie.mp4.u1.json`),
    'windows: a sidecar in the managed folder is managed',
  );
  ok(
    isWinManaged(
      'c:\\users\\me\\appdata\\roaming\\smartsub\\PROOFREAD-DATA\\Movie.JSON',
    ),
    'windows: paths that differ only in case are the same folder',
  );
  ok(
    !isWinManaged(`${winRoot}-evil\\a.json`),
    'windows: a sibling folder that only shares the prefix is rejected',
  );
  ok(
    !isWinManaged(
      'D:\\Users\\Me\\AppData\\Roaming\\SmartSub\\proofread-data\\a.json',
    ),
    'windows: another drive is rejected',
  );
  ok(
    !isWinManaged(`${winRoot}\\sub\\a.json`),
    'windows: sub-folders are rejected',
  );
  ok(
    !isWinManaged(`${winRoot}\\..\\a.json`),
    'windows: a path that climbs out of the folder is rejected',
  );
  ok(!isWinManaged('..\\a.json'), 'windows: a relative path is rejected');
}

function testPlanningFollowsReferences(tmp) {
  storage.setProofreadDataRoot(undefined);
  const root = path.join(tmp, 'plan', 'proofread-data');
  const managed = (name) => path.join(root, `${name}.json`);
  const old = path.join(
    tmp,
    'plan',
    'videos',
    '.smartsub-proofread',
    'old.json',
  );
  const elsewhere = path.join(tmp, 'plan', 'elsewhere', 'x.json');
  const withFiles = (paths) =>
    paths.map((proofreadDataFile) => ({
      uuid: path.basename(proofreadDataFile),
      proofreadDataFile,
    }));
  const task = (id, ...paths) => ({
    id,
    type: 'generateAndTranslate',
    pipelineFiles: withFiles(paths),
  });
  const batch = (id, ...paths) => ({
    id,
    type: 'proofread',
    proofreadEntries: withFiles(paths),
  });
  const draft = (id, ...paths) => ({
    id,
    type: 'generateAndTranslate',
    taskDraft: { config: {}, manuscripts: withFiles(paths) },
  });
  const dubbing = (id, proofreadDataFile) => ({
    id,
    type: 'dubbing',
    configSnapshot: { proofreadDataFile },
  });
  const plan = (deleting, remaining = []) =>
    storage.planManagedDeletion(deleting, remaining, { root });

  same(
    storage.collectProofreadDataFiles({
      ...task('a', 'p1'),
      proofreadEntries: withFiles(['p2']),
      taskDraft: { config: {}, manuscripts: withFiles(['p3']) },
      configSnapshot: { proofreadDataFile: 'p4' },
    }),
    ['p1', 'p2', 'p3', 'p4'],
    'a work item can point at a sidecar from its files, proofread entries, draft manuscripts and dubbing snapshot',
  );
  same(
    storage.collectProofreadDataFiles({ id: 'bare', type: 'toolbox' }),
    [],
    'an item without any sidecar yields nothing',
  );
  same(
    storage.collectProofreadDataFiles({
      id: 'damaged',
      type: 'generateOnly',
      pipelineFiles: 'oops',
      proofreadEntries: [null, 5, {}],
      taskDraft: { manuscripts: {} },
      configSnapshot: { proofreadDataFile: 42 },
    }),
    [],
    'a damaged work item is read as having no sidecars instead of throwing',
  );

  same(
    plan(
      [task('t', managed('a'), managed('shared'), old, elsewhere)],
      [task('other', managed('shared'))],
    ),
    [managed('a')],
    'only managed sidecars that nothing else uses are planned; shared, old-folder and outside files are not',
  );
  same(
    plan([task('t', managed('a'))], [dubbing('d', managed('a'))]),
    [],
    'a dubbing project that still points at the sidecar keeps it',
  );
  same(
    plan([task('t', managed('a'))], [batch('p', managed('a'))]),
    [],
    'a proofread batch that still points at it keeps it',
  );
  same(
    plan([task('t', managed('a'))], [draft('g', managed('a'))]),
    [],
    'a task draft that still points at it keeps it',
  );
  same(
    plan([task('t1', managed('a')), task('t2', managed('a'))]),
    [managed('a')],
    'a sidecar used by several deleted items is planned once',
  );
  same(
    plan([task('t', managed('a'))], [task('other', managed('A'))]),
    [],
    'references that differ only in case count as the same file',
  );
  same(
    plan([
      batch('p', managed('e')),
      draft('g', managed('d')),
      dubbing('x', managed('s')),
    ]),
    [managed('e'), managed('d'), managed('s')],
    'proofread entries, drafts and dubbing snapshots are all collected for deletion',
  );
  same(
    storage.planManagedDeletion([task('t', managed('a'))], []),
    [],
    'nothing is planned until the host injects the managed folder',
  );
}

function testRemovalOnlyTouchesRegularFilesInTheManagedFolder(tmp) {
  storage.setProofreadDataRoot(undefined);
  const base = path.join(tmp, 'remove');
  const root = path.join(base, 'proofread-data');
  const outside = path.join(base, 'outside');
  const oldFolder = path.join(base, 'videos', '.smartsub-proofread');
  for (const dir of [root, path.join(root, 'sub'), outside, oldFolder]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const make = (filePath) => {
    fs.writeFileSync(filePath, '{}');
    return filePath;
  };
  const target = make(path.join(root, 'target.json'));
  const nested = make(path.join(root, 'sub', 'nested.json'));
  const notes = make(path.join(root, 'notes.txt'));
  const old = make(path.join(oldFolder, 'old.json'));
  const outsideFile = make(path.join(outside, 'outside.json'));
  const folderNamedJson = path.join(root, 'folder.json');
  fs.mkdirSync(folderNamedJson);
  const link = path.join(root, 'link.json');
  let linked = true;
  try {
    fs.symlinkSync(outsideFile, link);
  } catch {
    linked = false;
  }

  const errors = [];
  const removed = storage.removeManagedProofreadData(
    [
      target,
      nested,
      notes,
      old,
      outsideFile,
      folderNamedJson,
      link,
      path.join(root, 'missing.json'),
    ],
    { root, onError: (message) => errors.push(message) },
  );
  same(
    removed,
    [target],
    'only the regular .json file directly in the managed folder is removed',
  );
  ok(!fs.existsSync(target), 'that sidecar is gone');
  ok(
    [nested, notes, old, outsideFile].every((filePath) =>
      fs.existsSync(filePath),
    ),
    'nested, non-.json, old-folder and outside files are left alone',
  );
  ok(
    fs.statSync(folderNamedJson).isDirectory(),
    'a folder that happens to be named .json is left alone',
  );
  if (linked) {
    ok(
      fs.lstatSync(link).isSymbolicLink(),
      'a symbolic link is neither followed nor removed',
    );
  }
  same(
    errors,
    [],
    'refused paths and files that are already gone are not errors',
  );
  same(
    storage.removeManagedProofreadData([target], { root }),
    [],
    'removing a sidecar that is already gone does nothing',
  );
  same(
    storage.removeManagedProofreadData([nested]),
    [],
    'nothing is removed until the host injects the managed folder',
  );
  ok(fs.existsSync(nested), 'so the file is still there');
}

function workItem(id, patch = {}) {
  return {
    id,
    name: id,
    type: 'generateAndTranslate',
    status: 'done',
    createdAt: 1,
    updatedAt: 1,
    pipelineFiles: [],
    ...patch,
  };
}
function pipelineFile(proofreadDataFile) {
  return {
    uuid: path.basename(proofreadDataFile),
    fileName: 'movie.mp4',
    filePath: '/videos/movie.mp4',
    fileExtension: '.mp4',
    directory: '/videos',
    proofreadDataFile,
  };
}
function sidecarAt(...segments) {
  const filePath = path.join(...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}');
  return filePath;
}
function startStore(items) {
  memoryStore.failWrites = false;
  memoryStore.disk = { workItemsMigrationVersion: 1, workItems: items };
  workItems.initializeWorkItemStore();
  setupWorkItemHandlers();
}

async function testDeletingATaskRemovesItsManagedSidecars(tmp) {
  const base = path.join(tmp, 'delete');
  const root = path.join(base, 'proofread-data');
  const own = sidecarAt(root, 'own.json');
  const shared = sidecarAt(root, 'shared.json');
  const old = sidecarAt(base, 'videos', '.smartsub-proofread', 'old.json');
  storage.setProofreadDataRoot(root);
  try {
    startStore([
      workItem('t1', {
        pipelineFiles: [
          pipelineFile(own),
          pipelineFile(shared),
          pipelineFile(old),
        ],
      }),
      workItem('t2', { pipelineFiles: [pipelineFile(shared)] }),
    ]);
    ok(workItems.deleteWorkItem('t1'), 'deletes the task');
    ok(!fs.existsSync(own), 'its own sidecar in the managed folder is removed');
    ok(fs.existsSync(shared), 'a sidecar another task still uses stays');
    ok(
      fs.existsSync(old),
      'a sidecar in the old folder beside the video is never removed',
    );
    ok(workItems.deleteWorkItem('t2'), 'deletes the other task');
    ok(
      !fs.existsSync(shared),
      'the shared sidecar goes once nothing uses it any more',
    );
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
}

async function testOtherReferencesKeepASidecar(tmp) {
  const root = path.join(tmp, 'references', 'proofread-data');
  const dubbed = sidecarAt(root, 'dubbed.json');
  const reviewed = sidecarAt(root, 'reviewed.json');
  const drafted = sidecarAt(root, 'drafted.json');
  storage.setProofreadDataRoot(root);
  try {
    startStore([
      workItem('task-dubbed', { pipelineFiles: [pipelineFile(dubbed)] }),
      workItem('dub', {
        type: 'dubbing',
        configSnapshot: { proofreadDataFile: dubbed },
      }),
      workItem('task-reviewed', { pipelineFiles: [pipelineFile(reviewed)] }),
      workItem('batch', {
        type: 'proofread',
        proofreadEntries: [
          {
            id: 'entry',
            sourceSubtitlePath: '/videos/movie.srt',
            lastPosition: 0,
            totalCount: 0,
            modifiedCount: 0,
            status: 'pending',
            proofreadDataFile: reviewed,
          },
        ],
      }),
      workItem('task-drafted', { pipelineFiles: [pipelineFile(drafted)] }),
      workItem('draft', {
        taskDraft: { config: {}, manuscripts: [pipelineFile(drafted)] },
      }),
    ]);

    workItems.deleteWorkItem('task-dubbed');
    ok(
      fs.existsSync(dubbed),
      'a dubbing project keeps the sidecar it was made from',
    );
    workItems.deleteWorkItem('dub');
    ok(!fs.existsSync(dubbed), 'and it goes with that dubbing project');

    workItems.deleteWorkItem('task-reviewed');
    ok(fs.existsSync(reviewed), 'a proofread batch keeps the sidecar it opens');
    workItems.deleteWorkItem('batch');
    ok(!fs.existsSync(reviewed), 'and it goes with that batch');

    workItems.deleteWorkItem('task-drafted');
    ok(
      fs.existsSync(drafted),
      'a task draft keeps the sidecar of its manuscripts',
    );
    workItems.deleteWorkItem('draft');
    ok(!fs.existsSync(drafted), 'and it goes with that draft');
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
}

async function testFailedSaveKeepsTheSidecars(tmp) {
  const root = path.join(tmp, 'rollback', 'proofread-data');
  const own = sidecarAt(root, 'own.json');
  storage.setProofreadDataRoot(root);
  try {
    startStore([workItem('t', { pipelineFiles: [pipelineFile(own)] })]);
    memoryStore.failWrites = true;
    const failed = await attempt(() => workItems.deleteWorkItem('t'));
    ok(failed.error, 'deleting fails when the task list cannot be saved');
    ok(
      fs.existsSync(own),
      'the sidecar stays when the deletion is rolled back',
    );
    ok(workItems.getWorkItemById('t'), 'and the task is still listed');
    memoryStore.failWrites = false;
    ok(workItems.deleteWorkItem('t'), 'a later retry deletes the task');
    ok(!fs.existsSync(own), 'and then removes the sidecar');
  } finally {
    memoryStore.failWrites = false;
    storage.setProofreadDataRoot(undefined);
  }
}

async function testClearingAllTasks(tmp) {
  const base = path.join(tmp, 'clear');
  const root = path.join(base, 'proofread-data');
  const first = sidecarAt(root, 'first.json');
  const second = sidecarAt(root, 'second.json');
  const old = sidecarAt(base, 'videos', '.smartsub-proofread', 'old.json');
  storage.setProofreadDataRoot(root);
  try {
    startStore([
      workItem('t1', {
        pipelineFiles: [pipelineFile(first), pipelineFile(old)],
      }),
      workItem('t2', { pipelineFiles: [pipelineFile(second)] }),
    ]);
    workItems.clearAllWorkItems();
    same(workItems.getWorkItems(), [], 'clears every task');
    ok(
      !fs.existsSync(first) && !fs.existsSync(second),
      'clearing everything removes every managed sidecar',
    );
    ok(fs.existsSync(old), 'but still never the one in the old folder');
  } finally {
    storage.setProofreadDataRoot(undefined);
  }
}

async function testStuckSidecarDoesNotBlockDeletion(tmp) {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    process.getuid() === 0
  ) {
    return; // permissions cannot be used to make the removal fail here
  }
  const root = path.join(tmp, 'stuck', 'proofread-data');
  const own = sidecarAt(root, 'own.json');
  storage.setProofreadDataRoot(root);
  try {
    startStore([workItem('t', { pipelineFiles: [pipelineFile(own)] })]);
    fs.chmodSync(root, 0o555);
    logs.length = 0;
    ok(
      workItems.deleteWorkItem('t'),
      'the task is deleted even if its sidecar cannot be removed',
    );
    ok(!workItems.getWorkItemById('t'), 'and it is no longer listed');
    ok(fs.existsSync(own), 'the sidecar is left behind');
    ok(
      logs.some(
        (entry) =>
          entry.type === 'warning' && /could not remove/.test(entry.message),
      ),
      'the failure is logged as a warning',
    );
  } finally {
    fs.chmodSync(root, 0o755);
    storage.setProofreadDataRoot(undefined);
  }
}

async function run() {
  const tmp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-proofread-storage-'),
  );
  try {
    await section('without a managed folder', () =>
      testWithoutManagedFolder(tmp),
    );
    await section('managed paths', () => testManagedPath(tmp));
    await section('writing new sidecars', () =>
      testNewSidecarIsWrittenToManagedFolder(tmp),
    );
    await section('existing sidecars', () =>
      testExistingSidecarsStayWhereTheyAre(tmp),
    );
    await section('host injection', () => testHostInjectsTheManagedFolder());
    await section('deletion guards', () => testManagedPathGuards(tmp));
    await section('deletion planning', () =>
      testPlanningFollowsReferences(tmp),
    );
    await section('removal', () =>
      testRemovalOnlyTouchesRegularFilesInTheManagedFolder(tmp),
    );
    await section('deleting a task', () =>
      testDeletingATaskRemovesItsManagedSidecars(tmp),
    );
    await section('other references', () =>
      testOtherReferencesKeepASidecar(tmp),
    );
    await section('failed save', () => testFailedSaveKeepsTheSidecars(tmp));
    await section('clearing all', () => testClearingAllTasks(tmp));
    await section('stuck sidecar', () =>
      testStuckSidecarDoesNotBlockDeletion(tmp),
    );
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
