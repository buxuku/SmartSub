/*
 * Offline checks for issue #511: a proofread sidecar must always be readable
 * by the strict reader the proofread panel uses. Zero-length and inverted cues
 * coming out of ASR/segmentation used to be written verbatim and then refused.
 */
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
  proofreadDataToSubtitleRows,
  readProofreadDataFile,
  updateProofreadDataFromSubtitles,
  updateProofreadDataOutputs,
  writeProofreadDataFromFiles,
} = require('../main/helpers/proofreadData.ts');
const { assertValidProofreadData } = require('../types/proofreadData.ts');

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
function row(id, start, end, text = id) {
  return {
    id,
    startEndTime: `${formatTime(start)} --> ${formatTime(end)}`,
    content: [text],
    sourceContent: text,
    targetContent: text.toUpperCase(),
    startTimeInSeconds: start / 1000,
    endTimeInSeconds: end / 1000,
    isEditing: false,
  };
}
async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

/** Writes real subtitle files, then the sidecar through the production writer. */
async function writeFixture(root, name, sourceCues, targetCues) {
  const sourceFile = path.join(root, `${name}.srt`);
  const targetFile = path.join(root, `${name}.translated.srt`);
  await fs.promises.writeFile(sourceFile, srt(sourceCues), 'utf8');
  if (targetCues) {
    await fs.promises.writeFile(targetFile, srt(targetCues), 'utf8');
  }
  const file = {
    uuid: name,
    filePath: sourceFile,
    fileName: `${name}.srt`,
    fileExtension: '.srt',
    directory: root,
  };
  logs.length = 0;
  const written = await writeProofreadDataFromFiles({
    file,
    sourceFile,
    targetFile: targetCues ? targetFile : undefined,
  });
  return { file, sourceFile, written };
}

async function testZeroLengthCueWithTranslation(root) {
  const source = [
    [0, 1000, 'first'],
    [5200, 5200, 'oh'],
    [9000, 10000, 'third'],
  ];
  const target = [
    [0, 1000, 'FIRST'],
    [5200, 5200, 'OH!'],
    [9000, 10000, 'THIRD'],
  ];
  const { sourceFile, written } = await writeFixture(
    root,
    'middle',
    source,
    target,
  );
  ok(written.ok, 'writes a sidecar for subtitles with a zero-length cue');
  if (!written.ok) return undefined;

  const onDisk = await readJson(written.filePath);
  const contract = await attempt(() => assertValidProofreadData(onDisk));
  ok(
    !contract.error,
    `the sidecar on disk satisfies the strict contract (${errorText(contract.error)})`,
  );
  same(
    onDisk.cues.map((cue) => cue.id),
    ['1', '2', '3'],
    'keeps every cue',
  );
  same(
    onDisk.cues.map((cue) => [cue.source, cue.target]),
    [
      ['first', 'FIRST'],
      ['oh', 'OH!'],
      ['third', 'THIRD'],
    ],
    'keeps source and translated text on the right cue',
  );
  same(
    onDisk.cues.map((cue) => [cue.startMs, cue.endMs]),
    [
      [0, 1000],
      [5200, 6000],
      [9000, 10000],
    ],
    'only the zero-length cue changes: it now ends 800 ms after it starts',
  );

  const strictRead = await attempt(() =>
    readProofreadDataFile(written.filePath, { strict: true }),
  );
  ok(
    !strictRead.error,
    `the strict reader used by the proofread panel opens it (${errorText(strictRead.error)})`,
  );
  if (strictRead.value) {
    const rows = proofreadDataToSubtitleRows(strictRead.value);
    ok(
      rows.every((item) => item.endTimeInSeconds > item.startTimeInSeconds),
      'every editor row has end > start',
    );
    same(
      rows[1].startEndTime,
      '00:00:05,200 --> 00:00:06,000',
      'the editor shows the repaired range',
    );
  }
  same(
    await fs.promises.readFile(sourceFile, 'utf8'),
    srt(source),
    'the source subtitle file is never rewritten',
  );
  ok(
    logs.some(
      (entry) =>
        entry.type === 'warning' &&
        /repaired 1 cue/.test(entry.message) &&
        /ids: 2/.test(entry.message),
    ),
    'logs which cue was repaired',
  );
  return written.filePath;
}

const SHAPES = [
  {
    name: 'first',
    cues: [
      [0, 0, 'a'],
      [500, 1500, 'b'],
    ],
    ends: [400, 1500],
  },
  {
    name: 'last',
    cues: [
      [0, 1000, 'a'],
      [5200, 5200, 'b'],
    ],
    ends: [1000, 6000],
  },
  { name: 'only', cues: [[0, 0, 'a']], ends: [800] },
  {
    name: 'inverted',
    cues: [
      [5200, 4800, 'a'],
      [9000, 10000, 'b'],
    ],
    ends: [6000, 10000],
  },
  {
    name: 'stacked',
    cues: [
      [5200, 5200, 'a'],
      [5200, 5200, 'b'],
      [9000, 10000, 'c'],
    ],
    ends: [6000, 6000, 10000],
  },
  {
    name: 'tight',
    cues: [
      [1000, 1000, 'a'],
      [1050, 2000, 'b'],
    ],
    ends: [1050, 2000],
  },
];

async function testCueShapes(root) {
  for (const shape of SHAPES) {
    const { written } = await writeFixture(
      root,
      `shape-${shape.name}`,
      shape.cues,
    );
    ok(written.ok, `${shape.name}: writes a sidecar`);
    if (!written.ok) continue;
    const onDisk = await readJson(written.filePath);
    const contract = await attempt(() => assertValidProofreadData(onDisk));
    ok(
      !contract.error,
      `${shape.name}: strict contract holds on disk (${errorText(contract.error)})`,
    );
    same(
      onDisk.cues.map((cue) => cue.endMs),
      shape.ends,
      `${shape.name}: end times`,
    );
    same(
      onDisk.cues.map((cue) => cue.source),
      shape.cues.map(([, , text]) => text),
      `${shape.name}: text is kept`,
    );
  }
}

async function testUnreadableSidecarIsNeverWritten(root) {
  // Timestamps beyond Number.MAX_SAFE_INTEGER cannot be repaired or stored.
  const sourceFile = path.join(root, 'absurd.srt');
  await fs.promises.writeFile(
    sourceFile,
    '1\n100000000000:00:00,000 --> 100000000000:00:01,000\nabsurd\n',
    'utf8',
  );
  const file = {
    uuid: 'absurd',
    filePath: sourceFile,
    fileName: 'absurd.srt',
    fileExtension: '.srt',
    directory: root,
  };
  const written = await writeProofreadDataFromFiles({ file, sourceFile });
  ok(
    !written.ok && written.reason === 'write-failed',
    'refuses to write a sidecar the strict reader would reject',
  );
  ok(
    !written.ok && /Invalid proofread cue/.test(written.error || ''),
    'says which part of the contract was broken',
  );
  ok(
    !fs.existsSync(getProofreadDataPath(file)),
    'leaves no unreadable sidecar behind',
  );
}

async function testSavingRowsWithoutDuration(sidecarPath) {
  // The editor's time-offset tool clamps shifted cues at 00:00:00,000, which
  // collapses them to zero length; saving must not leave such cues behind.
  logs.length = 0;
  const saved = await attempt(() =>
    updateProofreadDataFromSubtitles(sidecarPath, [
      row('1', 0, 0, 'first'),
      row('2', 5200, 5200, 'oh'),
      row('3', 9000, 10000, 'third'),
    ]),
  );
  ok(
    !saved.error,
    `saves rows whose end is not after their start (${errorText(saved.error)})`,
  );
  const onDisk = await readJson(sidecarPath);
  const contract = await attempt(() => assertValidProofreadData(onDisk));
  ok(
    !contract.error,
    `the saved sidecar satisfies the strict contract (${errorText(contract.error)})`,
  );
  same(
    onDisk.cues.map((cue) => [cue.startMs, cue.endMs]),
    [
      [0, 800],
      [5200, 6000],
      [9000, 10000],
    ],
    'collapsed cues get a visible duration, the others are untouched',
  );
  ok(
    logs.some(
      (entry) =>
        entry.type === 'warning' && /repaired 2 cue/.test(entry.message),
    ),
    'logs the repair that happened while saving',
  );
}

async function testSavingUnrepairableTimesIsRejected(sidecarPath) {
  const before = await fs.promises.readFile(sidecarPath, 'utf8');
  const garbage = row('2', 5200, 6000, 'oh');
  // A negative minute parses to a negative start, which is real corruption.
  garbage.startEndTime = '00:-1:00,000 --> 00:00:06,000';
  const rejected = await attempt(() =>
    updateProofreadDataFromSubtitles(sidecarPath, [
      row('1', 0, 1000, 'first'),
      garbage,
      row('3', 9000, 10000, 'third'),
    ]),
  );
  ok(
    rejected.error && /Invalid proofread cue/.test(errorText(rejected.error)),
    'rejects times that cannot be repaired',
  );
  same(
    await fs.promises.readFile(sidecarPath, 'utf8'),
    before,
    'a rejected save leaves the sidecar untouched',
  );

  const saved = await attempt(() =>
    updateProofreadDataFromSubtitles(sidecarPath, [
      row('1', 0, 1000, 'first'),
      row('2', 5200, 6500, 'oh'),
      row('3', 9000, 10000, 'third'),
    ]),
  );
  ok(!saved.error, `a valid edit still saves (${errorText(saved.error)})`);
  same(
    saved.value && saved.value.cues.map((cue) => [cue.startMs, cue.endMs]),
    [
      [0, 1000],
      [5200, 6500],
      [9000, 10000],
    ],
    'the valid edit is persisted',
  );
}

function legacySidecar(version, cues) {
  return {
    version,
    meta: {
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    ...(version === 2 ? { speakers: [] } : {}),
    cues: cues.map(([id, startMs, endMs, source]) => ({
      id,
      startMs,
      endMs,
      source,
      target: source.toUpperCase(),
      ...(version === 2 ? { translationStatus: 'success' } : {}),
    })),
  };
}

async function writeLegacy(root, name, content) {
  const filePath = path.join(root, `${name}.json`);
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fs.promises.writeFile(filePath, text, 'utf8');
  return { filePath, text };
}

async function testLegacySidecarsOpen(root) {
  // Exactly what 3.9.0 left on disk: valid JSON holding cues the strict
  // reader refused. Upgrading must be enough to open them again.
  const v2 = await writeLegacy(
    root,
    'legacy-v2',
    legacySidecar(2, [
      ['1', 0, 1000, 'first'],
      ['2', 5200, 5200, 'oh'],
      ['3', 9000, 4000, 'third'],
    ]),
  );
  const v1 = await writeLegacy(
    root,
    'legacy-v1',
    legacySidecar(1, [['1', 0, 0, 'only']]),
  );
  const expectations = [
    { name: 'v2', file: v2, ends: [1000, 6000, 9800], repaired: 2 },
    { name: 'v1', file: v1, ends: [800], repaired: 1 },
  ];
  for (const { name, file, ends, repaired } of expectations) {
    for (const strict of [true, false]) {
      const mode = strict ? 'strict' : 'lenient';
      logs.length = 0;
      const read = await attempt(() =>
        readProofreadDataFile(file.filePath, { strict }),
      );
      ok(
        !read.error,
        `${mode} read opens a legacy ${name} sidecar with non-positive cues (${errorText(read.error)})`,
      );
      same(
        read.value && read.value.cues.map((cue) => cue.endMs),
        ends,
        `${mode} read of the legacy ${name} sidecar repairs the end times`,
      );
      ok(
        logs.some(
          (entry) =>
            entry.type === 'warning' &&
            entry.message.includes(`repaired ${repaired} cue`),
        ),
        `${mode} read of the legacy ${name} sidecar logs the repair`,
      );
    }
    same(
      await fs.promises.readFile(file.filePath, 'utf8'),
      file.text,
      `reading the legacy ${name} sidecar never rewrites it`,
    );
  }

  // The export stage rewrites the sidecar's bookkeeping, which heals the file.
  await updateProofreadDataOutputs({
    proofreadDataFile: v2.filePath,
    srtFile: path.join(root, 'legacy-v2.srt'),
  });
  const healed = await readJson(v2.filePath);
  const contract = await attempt(() => assertValidProofreadData(healed));
  ok(
    !contract.error,
    `the export stage leaves a legacy sidecar valid on disk (${errorText(contract.error)})`,
  );
}

async function testCorruptionIsStillRejected(root) {
  const valid = legacySidecar(2, [['1', 0, 1000, 'first']]);
  const withCue = (change) => ({
    ...valid,
    cues: [{ ...valid.cues[0], ...change }],
  });
  const cueLabel = '#1 (id=1, startMs=0, endMs=1000)';
  const corrupt = [
    // The reason is whatever JSON.parse says; it only has to be passed on.
    { name: 'truncated JSON', content: '{"version":2,' },
    {
      name: 'text start time',
      content: withCue({ startMs: 'corrupt' }),
      reason:
        'Invalid proofread cue #1 (id=1, startMs="corrupt", endMs=1000): startMs is not an integer',
    },
    {
      name: 'negative start time',
      content: withCue({ startMs: -5, endMs: 10 }),
      reason:
        'Invalid proofread cue #1 (id=1, startMs=-5, endMs=10): startMs is negative',
    },
    {
      name: 'missing end time',
      content: withCue({ endMs: null }),
      reason:
        'Invalid proofread cue #1 (id=1, startMs=0, endMs=null): endMs is not an integer',
    },
    {
      name: 'unsupported version',
      content: { ...valid, version: 3 },
      reason: 'Unsupported proofread data version',
    },
    {
      name: 'non-text source',
      content: withCue({ source: { text: 'lost' } }),
      reason: `Invalid proofread cue ${cueLabel}: source is not text`,
    },
  ];
  for (const { name, content, reason } of corrupt) {
    const file = await writeLegacy(
      root,
      `corrupt-${name.replace(/ /g, '-')}`,
      content,
    );
    const read = await attempt(() =>
      readProofreadDataFile(file.filePath, { strict: true }),
    );
    ok(read.error, `strict read still rejects ${name}`);
    if (!read.error) continue;
    const cause = read.error.cause;
    ok(cause instanceof Error, `${name}: the original error is kept as cause`);
    same(
      errorText(read.error),
      `Invalid proofread data file: ${file.filePath} (${cause && cause.message})`,
      `${name}: the message says why the sidecar was rejected`,
    );
    if (reason) {
      same(cause && cause.message, reason, `${name}: the reason is specific`);
    }
  }
}

async function run() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-cue-timing-'),
  );
  try {
    const sidecarPath = await testZeroLengthCueWithTranslation(root);
    await testCueShapes(root);
    await testUnreadableSidecarIsNeverWritten(root);
    await testLegacySidecarsOpen(root);
    await testCorruptionIsStillRejected(root);
    if (sidecarPath) {
      await testSavingRowsWithoutDuration(sidecarPath);
      await testSavingUnrepairableTimesIsRejected(sidecarPath);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

run()
  .then(() => {
    console.log(
      `Proofread cue timing tests: ${passed} passed, ${failed} failed`,
    );
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
