const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let fixture;
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/speakerDiarization/stage.ts')) {
    if (request === '../storeManager')
      return { logMessage: (...args) => fixture.logs.push(args) };
    if (request === '../sherpaOnnx/sherpaLibPaths')
      return { isSherpaLibInstalled: () => fixture.runtimeInstalled };
    if (request === './modelCatalog')
      return {
        isSpeakerDiarizationModelInstalled: () => fixture.modelInstalled,
        getSpeakerDiarizationModelFiles: () => ({
          segmentation: 'seg.onnx',
          embedding: 'emb.onnx',
        }),
      };
    if (request === './runtime')
      return {
        getSpeakerDiarizationRuntime: () => {
          if (fixture.factoryError) throw new Error('worker startup failed');
          return {
            diarize: (input) => {
              fixture.requests.push(input);
              if (fixture.syncError)
                throw new Error('inference startup failed');
              return {
                id: 'speaker-request',
                result:
                  fixture.result?.() ??
                  Promise.resolve({ segments: fixture.segments }),
              };
            },
            cancel: (id) => {
              fixture.cancelled.push(id);
              fixture.reject?.(
                Object.assign(new Error('cancelled'), { code: 'cancelled' }),
              );
            },
          };
        },
      };
    if (request === '../atomicFile')
      return {
        atomicReplaceTextFile: async (target, content, options) => {
          fixture.writes.push(target);
          await atomicReplaceTextFile(target, content, {
            ...options,
            operations: {
              open: fs.promises.open,
              rm: fs.promises.rm,
              rename: async (...args) => {
                if (fixture.writes.length === fixture.failWrite)
                  throw new Error('disk replacement failed');
                return fs.promises.rename(...args);
              },
            },
          });
          if (fixture.writes.length === fixture.abortAfterWrite)
            fixture.controller.abort();
        },
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { atomicReplaceTextFile } = require('../main/helpers/atomicFile.ts');
const {
  runSpeakerDiarizationStage,
} = require('../main/helpers/speakerDiarization/stage.ts');
const { TaskCancelledError } = require('../main/helpers/taskContext.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-speaker-stage-'));
const subtitle = '1\n00:00:00,000 --> 00:00:02,000\nHello\n\n';
let checks = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function setup(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const media = path.join(dir, 'clip.wav');
  const output = path.join(dir, 'output.srt');
  fs.writeFileSync(media, 'audio');
  fs.writeFileSync(output, subtitle);
  fixture = {
    dir,
    modelInstalled: true,
    runtimeInstalled: true,
    segments: [{ start: 0, end: 2, speaker: 0 }],
    requests: [],
    writes: [],
    cancelled: [],
    logs: [],
    controller: new AbortController(),
  };
  return {
    file: {
      filePath: media,
      fileName: 'clip',
      tempAudioFile: media,
      srtFile: output,
    },
    formData: {
      speakerDiarization: true,
      speakerDiarizationEmbedInSubtitle: true,
      speakerDiarizationCount: 2,
    },
    signal: fixture.controller.signal,
  };
}
async function run() {
  for (const [name, change, reason] of [
    [
      'disabled',
      (input) => {
        input.formData.speakerDiarization = false;
      },
      'disabled',
    ],
    [
      'audio',
      (input) => {
        input.file.tempAudioFile = '';
      },
      'audio-unavailable',
    ],
    [
      'models',
      () => {
        fixture.modelInstalled = false;
      },
      'model-unavailable',
    ],
    [
      'runtime',
      () => {
        fixture.runtimeInstalled = false;
      },
      'model-unavailable',
    ],
    [
      'factory',
      () => {
        fixture.factoryError = true;
      },
      'inference-failed',
    ],
    [
      'sync',
      () => {
        fixture.syncError = true;
      },
      'inference-failed',
    ],
    [
      'async',
      () => {
        fixture.result = () => Promise.reject(new Error('worker exited'));
      },
      'inference-failed',
    ],
    [
      'empty',
      () => {
        fixture.segments = [];
      },
      'empty-result',
    ],
  ]) {
    const input = setup(name);
    change(input);
    const result = await runSpeakerDiarizationStage(input);
    check(result, { applied: false, embedded: false, reason }, name);
    check(
      fs.readFileSync(input.file.srtFile, 'utf8'),
      subtitle,
      `${name} preserves subtitle`,
    );
    check(fixture.writes.length, 0, `${name} never writes`);
  }
  let input = setup('metadata');
  input.formData.speakerDiarizationEmbedInSubtitle = false;
  let result = await runSpeakerDiarizationStage(input);
  check(result, { applied: true, embedded: false, segments: fixture.segments });
  check(fixture.requests[0].numClusters, 2);
  check(fixture.writes.length, 0);

  input = setup('annotation');
  result = await runSpeakerDiarizationStage(input);
  check(result.embedded, true);
  check(
    fs.readFileSync(input.file.srtFile, 'utf8').includes('[Speaker 1] Hello'),
    true,
  );
  await runSpeakerDiarizationStage(input);
  check(
    fs.readFileSync(input.file.srtFile, 'utf8').match(/\[Speaker 1\]/g).length,
    1,
    'idempotent labels',
  );

  for (const link of ['direct', 'symlink', 'hardlink']) {
    input = setup(`protected-${link}`);
    const imported = path.join(fixture.dir, 'imported.srt');
    fs.writeFileSync(imported, subtitle);
    input.file.providedSubtitlePath = imported;
    const alias = path.join(fixture.dir, 'alias.srt');
    if (link === 'symlink') fs.symlinkSync(imported, alias);
    if (link === 'hardlink') fs.linkSync(imported, alias);
    input.file.srtFile = link === 'direct' ? imported : alias;
    result = await runSpeakerDiarizationStage(input);
    check(result.reason, 'imported-subtitle-protected', link);
    check(result.applied, true, 'metadata remains available');
    check(fs.readFileSync(imported, 'utf8'), subtitle);
    check(fixture.writes.length, 0);
  }
  for (const link of ['symlink', 'hardlink']) {
    input = setup(`owned-${link}`);
    const alias = path.join(fixture.dir, 'alias.srt');
    if (link === 'symlink') fs.symlinkSync(input.file.srtFile, alias);
    else fs.linkSync(input.file.srtFile, alias);
    input.file.tempSrtFile = alias;
    result = await runSpeakerDiarizationStage(input);
    check(result.embedded, true);
    check(
      fs.readFileSync(alias, 'utf8'),
      fs.readFileSync(input.file.srtFile, 'utf8'),
      'owned aliases stay in sync',
    );
    check(fixture.writes.length, link === 'symlink' ? 1 : 2);
  }
  for (const kind of ['missing', 'empty']) {
    input = setup(`subtitle-${kind}`);
    if (kind === 'missing') fs.unlinkSync(input.file.srtFile);
    else fs.writeFileSync(input.file.srtFile, '');
    result = await runSpeakerDiarizationStage(input);
    check(result.reason, 'subtitle-unavailable');
    check(result.applied, true);
  }
  input = setup('rollback');
  input.file.translatedSrtFile = path.join(fixture.dir, 'translated.srt');
  fs.writeFileSync(input.file.translatedSrtFile, subtitle);
  fixture.failWrite = 2;
  result = await runSpeakerDiarizationStage(input);
  check(result.reason, 'annotation-failed');
  check(result.applied, true);
  check(
    fs.readFileSync(input.file.srtFile, 'utf8'),
    subtitle,
    'committed first file rolled back',
  );
  check(
    fs.readFileSync(input.file.translatedSrtFile, 'utf8'),
    subtitle,
    'failed second replacement preserved original',
  );
  check(
    fixture.writes,
    [input.file.srtFile, input.file.translatedSrtFile, input.file.srtFile].map(
      (file) => fs.realpathSync(file),
    ),
    'only committed replacements rolled back',
  );
  check(
    fs.readdirSync(fixture.dir).some((file) => file.endsWith('.tmp')),
    false,
  );

  input = setup('cancel-before');
  fixture.modelInstalled = false;
  fixture.controller.abort();
  await assert.rejects(runSpeakerDiarizationStage(input), TaskCancelledError);
  checks++;
  input = setup('cancel-inference');
  fixture.result = () =>
    new Promise((_resolve, reject) => {
      fixture.reject = reject;
    });
  const pending = runSpeakerDiarizationStage(input);
  fixture.controller.abort();
  await assert.rejects(pending, TaskCancelledError);
  checks++;
  check(fixture.cancelled, ['speaker-request']);
  check(fixture.writes.length, 0);
  input = setup('cancel-annotation');
  input.file.translatedSrtFile = path.join(fixture.dir, 'translated.srt');
  fs.writeFileSync(input.file.translatedSrtFile, subtitle);
  fixture.abortAfterWrite = 1;
  await assert.rejects(runSpeakerDiarizationStage(input), TaskCancelledError);
  checks++;
  check(fs.readFileSync(input.file.srtFile, 'utf8'), subtitle);
  check(fs.readFileSync(input.file.translatedSrtFile, 'utf8'), subtitle);
  console.log(`Speaker stage: ${checks} checks passed; evidence: ${root}`);
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
  });
