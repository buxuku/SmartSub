/* Offline persistence checks for missed-speech proofread metadata. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
Module._load = function (request, parent, isMain) {
  const normalized = String(request).replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: { getVersion: () => 'test', getPath: () => repoRoot },
      ipcMain: { handle: () => undefined, on: () => undefined },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (normalized.endsWith('/helpers/storeManager')) {
    return { logMessage: () => undefined, store: { get: () => ({}) } };
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
  readProofreadDataFile,
  updateProofreadDataFromSubtitles,
  writeProofreadDataFromFiles,
} = require('../main/helpers/proofreadData.ts');

let passed = 0;
let failed = 0;
function ok(value, message) {
  if (value) passed += 1;
  else {
    failed += 1;
    console.error(`\u2717 ${message}`);
  }
}
function row(id, start, end, text = id) {
  const time = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
  };
  return {
    id,
    startEndTime: `${time(start)} --> ${time(end)}`,
    content: [text],
    sourceContent: text,
    targetContent: text.toUpperCase(),
    startTimeInSeconds: start / 1000,
    endTimeInSeconds: end / 1000,
    isEditing: false,
  };
}

async function run() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-missed-'),
  );
  const sourceFile = path.join(root, 'source.srt');
  const targetFile = path.join(root, 'target.srt');
  await fs.promises.writeFile(
    sourceFile,
    '1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n',
    'utf8',
  );
  await fs.promises.writeFile(
    targetFile,
    '1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:02,000 --> 00:00:03,000\nB\n',
    'utf8',
  );
  const file = {
    uuid: 'test',
    filePath: sourceFile,
    fileName: 'source.srt',
    fileExtension: '.srt',
    directory: root,
  };
  const warning = {
    id: 'stale',
    startMs: 1000.4,
    endMs: 1999.6,
    level: 'high',
    signals: ['energySpeech', 'subtitleGap'],
    cueIds: ['stale'],
  };
  const written = await writeProofreadDataFromFiles({
    file,
    sourceFile,
    targetFile,
    missedSpeechWarnings: [warning],
  });
  ok(written.ok, 'writes sidecar with file-level warning');
  if (!written.ok) return;
  let data = await readProofreadDataFile(written.filePath);
  ok(data.missedSpeechWarnings.length === 1, 'reopens warning metadata');
  ok(
    data.missedSpeechWarnings[0].startMs === 1000 &&
      data.missedSpeechWarnings[0].endMs === 2000,
    'rounds warning range canonically',
  );
  ok(
    data.missedSpeechWarnings[0].cueIds.length === 0,
    'gap warning has no stale cue ID',
  );
  ok(
    data.cues.every((cue) => !cue.missedSpeechWarnings),
    'no cue-local warning in gap',
  );

  data = await updateProofreadDataFromSubtitles(written.filePath, [
    row('1', 0, 1500, 'a'),
    row('2', 2000, 3000, 'b'),
  ]);
  ok(
    data.missedSpeechWarnings[0].cueIds.join(',') === '1',
    'associates after timing edit',
  );
  ok(data.cues[0].missedSpeechWarnings.length === 1, 'updates cue-local view');

  data = await updateProofreadDataFromSubtitles(written.filePath, [
    row('1', 0, 500, 'a1'),
    row('3', 500, 1500, 'a2'),
    row('2', 2000, 3000, 'b'),
  ]);
  ok(
    data.missedSpeechWarnings[0].cueIds.join(',') === '3',
    'split recomputes IDs',
  );
  data = await updateProofreadDataFromSubtitles(written.filePath, [
    row('2', 2000, 3000, 'b'),
  ]);
  ok(
    data.missedSpeechWarnings[0].cueIds.length === 0,
    'delete preserves file warning',
  );
  const reopened = await readProofreadDataFile(written.filePath);
  ok(
    reopened.missedSpeechWarnings.length === 1 && reopened.cues.length === 1,
    'delete survives save and reopen',
  );

  const old = path.join(root, 'old.json');
  await fs.promises.writeFile(
    old,
    JSON.stringify({
      version: 1,
      meta: {},
      cues: [
        {
          id: 'x',
          startMs: 0,
          endMs: 1000,
          source: 'x',
          target: '',
        },
      ],
    }),
    'utf8',
  );
  const oldData = await readProofreadDataFile(old);
  ok(
    !oldData.missedSpeechWarnings,
    'old sidecar without warnings remains compatible',
  );

  await fs.promises.rm(root, { recursive: true, force: true });
}

run()
  .then(() => {
    console.log(
      `Missed speech persistence tests: ${passed} passed, ${failed} failed`,
    );
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
