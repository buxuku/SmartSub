/* Production adapter persistence and cancellation checks with a fake runtime. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-review-adapter-'),
);
let runtimeResult, abortBeforeResult, paramsSent;
const originalLoad = Module._load;
const manager = {
  ensureStarted: async () => ({ engines: { faster_whisper: true } }),
  cancel: () => {},
  transcribe: (params, handlers) => {
    paramsSent = params;
    handlers.onReview?.({ stage: 'checking', completed: 0, total: 0 });
    return {
      id: 'review-test',
      result: Promise.resolve().then(() => {
        abortBeforeResult?.();
        return runtimeResult;
      }),
    };
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/storeManager'))
    return {
      logMessage: () => {},
      store: { get: () => ({ fasterWhisperDevice: 'cpu' }) },
    };
  if (request.endsWith('/pythonRuntime'))
    return { getPythonRuntimeManager: () => manager };
  if (request.endsWith('/pythonRuntime/paths'))
    return {
      isRuntimeInstalled: () => true,
      readEngineManifest: () => ({}),
      normalizePyEngineVariant: (x) => x,
      getParkedVariant: () => null,
    };
  if (request.endsWith('/modelCatalog'))
    return {
      getFasterWhisperModelsPath: () => output,
      inspectCt2ModelSnapshot: () => ({ snapshotDir: output }),
      resolveCt2ModelSnapshotDir: () => output,
    };
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = function (m, f) {
  m._compile(
    ts.transpileModule(fs.readFileSync(f, 'utf8'), {
      fileName: f,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );
};
const { fasterWhisperEngineAdapter: adapter } = require(
  path.join(root, 'main/helpers/engines/fasterWhisperEngine.ts'),
);
const { isTaskCancelledError } = require(
  path.join(root, 'main/helpers/taskContext.ts'),
);
const audio = path.join(output, 'input.wav');
const pcm = Buffer.alloc(16000 * 2 * 8);
const header = Buffer.alloc(44);
header.write('RIFF');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(audio, Buffer.concat([header, pcm]));
const original = [
  {
    start: 1,
    end: 2,
    text: 'Original.',
    words: [{ start: 1, end: 2, word: 'Original.' }],
  },
];
const segments = [
  ...original,
  {
    start: 3,
    end: 4,
    text: 'Recovered.',
    words: [{ start: 3, end: 4, word: 'Recovered.' }],
  },
];
const good = {
  language: 'en',
  segments,
  beforeReviewSegments: original,
  reviewSpeechSegments: [{ start: 1, end: 4 }],
  speechReview: {
    status: 'complete',
    checked: 1,
    recovered: 1,
    retimed: 0,
    pending: 0,
    changes: [{ start: 3, end: 4, original: '', text: 'Recovered.' }],
  },
};
async function run(id, signal) {
  const file = {
    uuid: id,
    fileName: id,
    filePath: audio,
    fileExtension: '.wav',
    directory: output,
    tempAudioFile: audio,
    srtFile: path.join(output, id + '.srt'),
  };
  let diagnostic;
  const events = [];
  await adapter.transcribe({
    file,
    formData: {
      model: 'large-v3',
      sourceLanguage: 'en',
      subtitleOutcome: 'balanced',
    },
    signal,
    event: { sender: { send: (...e) => events.push(e) } },
    onDiagnostics: (d) => {
      diagnostic = d;
    },
  });
  return { file, diagnostic, events };
}
(async () => {
  runtimeResult = good;
  const first = await run('task-a');
  assert.equal(paramsSent.speech_review, true);
  assert.match(fs.readFileSync(first.file.srtFile, 'utf8'), /Recovered/);
  assert.doesNotMatch(
    fs.readFileSync(first.file.speechReviewOriginalFile, 'utf8'),
    /Recovered/,
  );
  assert.equal(first.file.speechReviewSummary.changes[0].text, 'Recovered.');
  assert.equal(first.file.speechReviewStage, undefined);
  assert.equal(first.diagnostic.reviewCompleted, true);
  const second = await run('task-b');
  assert.notEqual(
    first.file.speechReviewOriginalFile,
    second.file.speechReviewOriginalFile,
  );
  assert.ok(fs.existsSync(first.file.speechReviewOriginalFile));
  runtimeResult = {
    language: 'en',
    segments: original,
    speechReview: { status: 'unavailable' },
  };
  const fallback = await run('fallback');
  assert.match(fs.readFileSync(fallback.file.srtFile, 'utf8'), /Original/);
  assert.equal(fallback.diagnostic.reviewCompleted, false);
  assert.equal(fallback.file.speechReviewSummary.status, 'unavailable');
  runtimeResult = { language: 'en', segments: original };
  const legacy = await run('legacy');
  assert.equal(legacy.file.speechReviewSummary, undefined);
  assert.equal(legacy.file.speechReviewFile, undefined);
  runtimeResult = good;
  const write = fs.promises.writeFile;
  fs.promises.writeFile = async function (p, ...args) {
    if (String(p).endsWith('.review.json'))
      throw Error('injected audit failure');
    return write.call(this, p, ...args);
  };
  try {
    const noAudit = await run('audit-failure');
    assert.match(fs.readFileSync(noAudit.file.srtFile, 'utf8'), /Recovered/);
  } finally {
    fs.promises.writeFile = write;
  }
  const abort = new AbortController();
  abortBeforeResult = () => abort.abort();
  await assert.rejects(run('cancelled', abort.signal), isTaskCancelledError);
  assert.equal(fs.existsSync(path.join(output, 'cancelled.srt')), false);
  console.log(
    'PASS: review persistence, per-task backup, nonfatal failure, legacy runtime, cancelled output protection',
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(output, { recursive: true, force: true }));
