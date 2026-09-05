/** Real processor/worker contracts; native synthesis and app services are stubbed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-language-flow-'));
const load = Module._load;
const tsLoader = require.extensions['.ts'];
const requests = [];
let failNext = false;
const voice = {
  id: 'clone-test',
  engine: 'zipvoice',
  language: 'en',
  refText: 'The year is 2026.',
  refWavPath: path.join(temp, 'ref.wav'),
};
fs.writeFileSync(voice.refWavPath, 'test');

require.extensions['.ts'] = (mod, file) => {
  mod._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
};
const runtime = {
  setPoolSize() {},
  shrinkTo() {},
  cancel() {},
  synthesize(req) {
    requests.push(req);
    if (failNext) {
      failNext = false;
      return {
        id: 'failure',
        result: Promise.reject(new Error('synthetic failure')),
      };
    }
    fs.writeFileSync(req.outWavPath, 'test-wav');
    return {
      id: String(requests.length),
      result: Promise.resolve({ durationMs: 1000 }),
    };
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => temp } };
  if (request.endsWith('/storeManager')) return { logMessage() {} };
  if (request.endsWith('/fileUtils')) return { ensureTempDir: () => temp };
  if (request.endsWith('/compose/composeQueue')) return {};
  if (request.endsWith('/sherpaOnnx/ttsRuntime'))
    return { getSherpaTtsRuntime: () => runtime };
  if (request.endsWith('/ttsProviderManager'))
    return { getTtsProviderById: () => ({ id: 'cloud', type: 'edge' }) };
  if (request.endsWith('/voiceClone/voiceCloneManager'))
    return {
      getClonedVoiceById: (id) => (id === voice.id ? voice : undefined),
    };
  if (request.endsWith('/service/tts'))
    return {
      synthesizeSegment: async (_provider, req) => {
        requests.push(req);
        fs.writeFileSync(req.outWavPath, 'cloud');
        return { durationMs: 1000 };
      },
    };
  if (request.endsWith('/audioPipeline'))
    return {
      probeMediaDurationMs: async () => 0,
      wavDurationMs: () => 1000,
      assembleTrack: async (_segments, dest) => fs.writeFileSync(dest, 'track'),
    };
  if (request.endsWith('/ttsModelCatalog')) {
    const catalog = load.call(this, request, parent, isMain);
    return {
      ...catalog,
      isTtsModelInstalled: () => true,
      getTtsModelRequest: (id) =>
        catalog.TTS_MODELS[id].buildModelRequest('/models'),
    };
  }
  return load.call(this, request, parent, isMain);
};

async function main() {
  const store = require('../../main/helpers/dubbing/sessionStore.ts');
  store.setDubbingSessionsRoot(path.join(temp, 'sessions'));
  const proc = require('../../main/helpers/dubbing/dubbingProcessor.ts');
  const config = {
    engine: { kind: 'local', modelId: 'kokoro-multi-lang-v1_1' },
    voice: '0',
    globalSpeed: 1,
    background: 'mute',
    output: 'audioOnly',
    language: 'auto',
  };
  const subtitle = path.join(temp, 'input.srt');
  fs.writeFileSync(
    subtitle,
    '1\n00:00:00,000 --> 00:00:10,000\n90%\n\n2\n00:00:10,000 --> 00:00:20,000\n2026年\n',
  );
  const session = await proc.createDubbingSession(
    subtitle,
    undefined,
    undefined,
    'zh-Hant',
  );
  await proc.runDubbingBatch(session, config, () => {});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].language, 'zh-Hant');
  assert.ok(requests[0].model.ruleFsts);
  assert.equal(session.cues[0].text, '90%');
  assert.ok(session.cues.every((c) => c.synthesizedInputKey));
  const firstKey = session.cues[0].synthesizedInputKey;
  proc.disposeDubbingSession(session.id);
  const restored = proc.restoreDubbingSession(session.id).session;
  assert.equal(restored.subtitleLanguage, 'zh-Hant');
  assert.equal(proc.syncDubbingVoiceStaleness(restored, config), 0);
  await proc.runDubbingBatch(restored, config, () => {});
  assert.equal(
    requests.length,
    2,
    'same configuration reuses successful audio',
  );

  const english = { ...config, language: 'en-GB' };
  assert.equal(proc.syncDubbingVoiceStaleness(restored, english), 2);
  await assert.rejects(
    proc.buildDubTrack(restored, { config: english }),
    /重新生成/,
  );
  await proc.previewVoice(config.engine, '0', '90%', { language: 'en-GB' });
  assert.equal(requests.at(-1).language, 'en-GB');
  assert.equal(requests.at(-1).model.ruleFsts, undefined);

  failNext = true;
  await assert.rejects(
    proc.resynthesizeCue(restored, 0, {}, english),
    /synthetic failure/,
  );
  assert.equal(
    restored.cues[0].synthesizedInputKey,
    firstKey,
    'failure preserves actual artifact identity',
  );
  assert.equal(proc.syncDubbingVoiceStaleness(restored, english), 2);
  await proc.resynthesizeCue(restored, 0, {}, english);
  assert.equal(
    proc.syncDubbingVoiceStaleness(restored, english),
    1,
    'partial regeneration does not bless other old WAVs',
  );
  const count = requests.length;
  await proc.runDubbingBatch(restored, english, () => {}, { staleOnly: true });
  assert.equal(requests.length, count + 1);
  assert.equal(proc.syncDubbingVoiceStaleness(restored, english), 0);
  await proc.buildDubTrack(restored, { config: english });

  const cloneConfig = {
    ...config,
    engine: { kind: 'local', modelId: 'zipvoice-distill-zh-en' },
    voice: voice.id,
    language: 'zh',
  };
  await proc.resynthesizeCue(restored, 0, {}, cloneConfig);
  assert.equal(requests.at(-1).language, 'zh');
  assert.equal(requests.at(-1).generationConfig.referenceLanguage, 'en');
  await assert.rejects(
    proc.previewVoice(
      { kind: 'local', modelId: 'vits-zh-aishell3' },
      '0',
      '90%',
      { language: 'en' },
    ),
    /不支持/,
  );

  const cloud = {
    ...english,
    engine: { kind: 'cloud', providerId: 'cloud' },
    voice: 'en-GB-SoniaNeural',
  };
  await proc.resynthesizeCue(restored, 0, {}, cloud);
  assert.equal(requests.at(-1).language, 'en-GB');
  assert.equal(requests.at(-1).text, '90%');

  const pipeline = require('../../main/helpers/pipeline/dubStage.ts');
  const file = {
    uuid: 'pipeline-language',
    filePath: subtitle,
    fileName: 'input.srt',
    fileExtension: '.srt',
    srtFile: subtitle,
    tempTranslatedSrtFile: subtitle,
  };
  const task = {
    taskType: 'translateOnly',
    translateProvider: 'test',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    dub: config,
  };
  const event = { sender: { send() {} } };
  await pipeline.runDubStage(event, file, task);
  assert.equal(
    requests.at(-1).language,
    'zh-Hant',
    'pipeline uses translation language',
  );
  assert.ok(fs.existsSync(file.dubbedAudioPath));
  const reviewed = proc.getDubbingSession(file.dubbingSessionId);
  const reviewConfig = { ...english, globalSpeed: 1.1 };
  proc.syncDubbingVoiceStaleness(reviewed, reviewConfig);
  reviewed.lastConfig = reviewConfig;
  proc.flushDubbingSession(reviewed);
  await assert.rejects(
    pipeline.rebuildDubTrackForFile(event, file, task),
    /重新生成/,
  );
  await proc.runDubbingBatch(reviewed, reviewConfig, () => {});
  const beforeRebuild = requests.length;
  await pipeline.rebuildDubTrackForFile(event, file, task);
  assert.equal(
    requests.length,
    beforeRebuild,
    'review resume reuses regenerated audio',
  );
  const originalFile = {
    ...file,
    uuid: 'original-language',
    dubbingSessionId: undefined,
    dubbedAudioPath: undefined,
  };
  await pipeline.runDubStage(event, originalFile, {
    ...task,
    translateProvider: '-1',
  });
  assert.equal(
    requests.at(-1).language,
    'en',
    'disabled translation uses source language',
  );
  proc.disposeDubbingSession(reviewed.id);
  proc.disposeDubbingSession(originalFile.dubbingSessionId);

  // Execute the actual worker with a fake native boundary to observe exactly
  // what reaches generateAsync for target text and reference transcription.
  const generated = [];
  let handler;
  let complete;
  const workerFile = path.join(
    root,
    'extraResources/sherpa/worker/tts-worker.js',
  );
  const ttsConfig = require('../../extraResources/sherpa/worker/tts-config.js');
  vm.runInNewContext(fs.readFileSync(workerFile, 'utf8'), {
    __dirname: path.dirname(workerFile),
    process: {
      parentPort: {
        on: (_event, cb) => {
          handler = cb;
        },
        postMessage: (msg) => complete(msg),
      },
    },
    require: (name) =>
      name === 'path'
        ? path
        : name.endsWith('tts-config.js')
          ? ttsConfig
          : {
              OfflineTts: class {
                async generateAsync(req) {
                  generated.push(req);
                  return { samples: new Float32Array(10), sampleRate: 24000 };
                }
              },
              readWave: () => ({
                samples: new Float32Array(10),
                sampleRate: 24000,
              }),
              writeWave() {},
            },
  });
  const result = await new Promise((resolve) => {
    complete = resolve;
    handler({
      data: {
        type: 'synthesize',
        id: 'test',
        model: { modelType: 'zipvoice' },
        text: '90%',
        language: 'zh',
        sid: 0,
        speed: 1,
        outWavPath: 'out.wav',
        generationConfig: {
          refWavPath: voice.refWavPath,
          refText: 'In 2026, 小明.',
          referenceLanguage: 'en',
        },
      },
    });
  });
  assert.equal(result.type, 'done');
  assert.equal(generated[0].text, '百分之九十');
  assert.equal(generated[0].generationConfig.referenceText, 'In 2026, 小明.');
  proc.disposeDubbingSession(restored.id);
  console.log(
    'Dubbing language flow: processor, persistence, retries, preview, export, pipeline review, cloud and worker contracts passed',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = load;
    if (tsLoader) require.extensions['.ts'] = tsLoader;
    else delete require.extensions['.ts'];
    fs.rmSync(temp, { recursive: true, force: true });
  });
