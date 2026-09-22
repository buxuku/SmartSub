/* Real installed runtime -> production adapter -> final SRT and diagnostics.
 * All artifacts are isolated under --output. No writes to user profile/source. */
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
if (!args.audio || !args.runtime || !args.model || !args.output)
  throw Error('--audio --runtime --model --output required');
const root = path.resolve(__dirname, '../..');
const outcome = args.outcome || 'balanced';
if (!['accurate', 'balanced', 'clean', 'custom'].includes(outcome))
  throw Error('--outcome must be accurate, balanced, clean or custom');
const output = path.resolve(args.output);
fs.mkdirSync(output, { recursive: true });
const runtime = path.resolve(args.runtime);
const model = path.resolve(args.model);
const audio = path.join(output, 'source.wav');
if (!fs.existsSync(audio)) fs.symlinkSync(path.resolve(args.audio), audio);
let manager;
let lastProgress = -1;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const r = String(request).replace(/\\/g, '/');
  if (r.endsWith('/storeManager'))
    return {
      logMessage: (m) =>
        fs.appendFileSync(path.join(output, 'app.log'), String(m) + '\n'),
      store: {
        get: () => ({
          fasterWhisperDevice: 'cpu',
          fasterWhisperComputeType: 'auto',
        }),
      },
    };
  if (r.endsWith('/pythonRuntime'))
    return { getPythonRuntimeManager: () => manager };
  if (r.endsWith('/pythonRuntime/paths'))
    return {
      isRuntimeInstalled: () => true,
      readEngineManifest: () => ({}),
      normalizePyEngineVariant: (x) => x,
      getParkedVariant: () => null,
    };
  if (r.endsWith('/modelCatalog'))
    return {
      getFasterWhisperModelsPath: () => path.dirname(model),
      inspectCt2ModelSnapshot: () => ({ snapshotDir: model }),
      resolveCt2ModelSnapshotDir: () => model,
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
  const { PythonRuntimeManager } = require(
    path.join(root, 'main/helpers/pythonRuntime/manager.ts'),
  );
  manager = new PythonRuntimeManager(
    () => ({
      command: path.join(
        runtime,
        process.platform === 'win32' ? 'python.exe' : 'bin/python3',
      ),
      args: [
        path.join(root, 'extraResources/python-review/bootstrap.py'),
        path.join(runtime, 'main.py'),
      ],
      cwd: runtime,
      pythonHome: runtime,
      pythonPath: path.join(runtime, 'site-packages'),
    }),
    (msg, level) =>
      fs.appendFileSync(path.join(output, 'runtime.log'), `${level} ${msg}\n`),
  );
  const transcribe = manager.transcribe.bind(manager);
  manager.transcribe = (params, handlers) => {
    fs.writeFileSync(
      path.join(output, 'runtime-params.json'),
      JSON.stringify(params, null, 2),
    );
    const task = transcribe(params, handlers);
    return {
      id: task.id,
      result: task.result.then((result) => {
        fs.writeFileSync(
          path.join(output, 'raw-result.json'),
          JSON.stringify(result),
        );
        return result;
      }),
    };
  };
  const { fasterWhisperEngineAdapter } = require(
    path.join(root, 'main/helpers/engines/fasterWhisperEngine.ts'),
  );
  const { runMissedSpeechCheck } = require(
    path.join(root, 'main/helpers/missedSpeechStage.ts'),
  );
  const file = {
    uuid: 'full-retest',
    fileName: 'reviewed',
    filePath: audio,
    directory: output,
    fileExtension: '.wav',
    tempAudioFile: audio,
    srtFile: path.join(output, 'reviewed.srt'),
  };
  let diagnostics = {};
  let lastStage;
  const started = Date.now();
  try {
    await fasterWhisperEngineAdapter.transcribe({
      file,
      formData: {
        model: 'large-v3',
        sourceLanguage: args.language || 'en',
        transcriptionEngine: 'fasterWhisper',
        subtitleOutcome: outcome,
        maxSubtitleChars: 0,
      },
      event: {
        sender: {
          send: (channel, ...data) => {
            if (
              channel === 'taskProgressChange' &&
              Math.floor(data[2]) !== lastProgress
            ) {
              lastProgress = Math.floor(data[2]);
              console.log(new Date().toISOString(), 'progress', lastProgress);
            }
            if (
              channel === 'taskFileChange' &&
              data[0].speechReviewStage !== lastStage
            ) {
              lastStage = data[0].speechReviewStage;
              console.log('stage', lastStage);
            }
          },
        },
      },
      onDiagnostics: (d) => {
        diagnostics = { ...diagnostics, ...d };
      },
    });
    await runMissedSpeechCheck(file, diagnostics);
    fs.writeFileSync(
      path.join(output, 'evaluation.json'),
      JSON.stringify(
        {
          file,
          diagnostics,
          outcome,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          seconds: (Date.now() - started) / 1000,
        },
        null,
        2,
      ),
    );
    console.log(
      'COMPLETE',
      JSON.stringify({
        seconds: (Date.now() - started) / 1000,
        review: file.speechReviewSummary,
        warnings: file.missedSpeechWarnings,
      }),
    );
  } finally {
    await manager.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
