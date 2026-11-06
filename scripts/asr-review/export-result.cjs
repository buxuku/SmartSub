/* Render a real reviewed result through the production adapter and diagnostics.
 * Only external runtime/store boundaries are replaced; writes go to --output. */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (a, x, i, all) =>
        i % 2 ? a : [...a, [x.replace(/^--/, ''), all[i + 1]]],
      [],
    ),
);
if (!args.result || !args.audio || !args.output)
  throw Error('--result --audio --output required');
const root = path.resolve(__dirname, '../..');
const result = JSON.parse(fs.readFileSync(args.result, 'utf8'));
const output = path.resolve(args.output);
fs.mkdirSync(output, { recursive: true });
const audio = path.join(output, 'review-audio.wav');
if (!fs.existsSync(audio)) fs.symlinkSync(path.resolve(args.audio), audio);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = String(request).replace(/\\/g, '/');
  if (resolved.endsWith('/storeManager'))
    return {
      logMessage: () => {},
      store: { get: () => ({ fasterWhisperDevice: 'cpu' }) },
    };
  if (resolved.endsWith('/pythonRuntime'))
    return {
      getPythonRuntimeManager: () => ({
        ensureStarted: async () => ({ engines: { faster_whisper: true } }),
        transcribe: () => ({ id: 'replay', result: Promise.resolve(result) }),
        cancel: () => {},
      }),
    };
  if (resolved.endsWith('/pythonRuntime/paths'))
    return {
      isRuntimeInstalled: () => true,
      readEngineManifest: () => ({}),
      normalizePyEngineVariant: (x) => x,
      getParkedVariant: () => null,
    };
  if (resolved.endsWith('/modelCatalog'))
    return {
      getFasterWhisperModelsPath: () => output,
      inspectCt2ModelSnapshot: () => ({ snapshotDir: output }),
      resolveCt2ModelSnapshotDir: () => output,
    };
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = function (module, filename) {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};
(async () => {
  const { fasterWhisperEngineAdapter } = require(
    path.join(root, 'main/helpers/engines/fasterWhisperEngine.ts'),
  );
  const { runMissedSpeechCheck } = require(
    path.join(root, 'main/helpers/missedSpeechStage.ts'),
  );
  const file = {
    uuid: 'review-evaluation',
    fileName: 'reviewed',
    filePath: audio,
    directory: output,
    fileExtension: '.wav',
    tempAudioFile: audio,
    srtFile: path.join(output, 'reviewed.srt'),
  };
  let diagnostics = {};
  await fasterWhisperEngineAdapter.transcribe({
    file,
    formData: {
      model: 'large-v3',
      sourceLanguage: result.language || 'en',
      transcriptionEngine: 'fasterWhisper',
      subtitleOutcome: 'balanced',
      maxSubtitleChars: 0,
    },
    event: { sender: { send: () => {} } },
    onDiagnostics: (d) => {
      diagnostics = { ...diagnostics, ...d };
    },
  });
  await runMissedSpeechCheck(file, diagnostics);
  fs.writeFileSync(
    path.join(output, 'evaluation.json'),
    JSON.stringify({ file, diagnostics }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        srt: file.srtFile,
        review: file.speechReviewSummary,
        warnings: file.missedSpeechWarnings,
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
