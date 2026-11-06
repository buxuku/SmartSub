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
  const ownership =
    require('../../main/helpers/dubbing/sessionOwnership.ts').dubbingSessionOwnership;
  assert.equal(ownership.acquire(reviewed.id, 7, 'review'), true);
  const beforeConcurrent = JSON.stringify(reviewed);
  await assert.rejects(
    pipeline.runDubStage(event, file, task),
    /open in an editor/,
  );
  await assert.rejects(
    pipeline.rebuildDubTrackForFile(event, file, task),
    /open in an editor/,
  );
  assert.equal(JSON.stringify(reviewed), beforeConcurrent);
  ownership.release(reviewed.id, 7, 'review');
  const journal = store.getSessionDraftPath(reviewed.id, 'cue');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, '{unconfirmed');
  await assert.rejects(
    pipeline.runDubStage(event, file, task),
    /unconfirmed edits/,
  );
  assert.equal(ownership.isBusy(reviewed.id), false);
  fs.unlinkSync(journal);
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
  const previousAudio = file.dubbedAudioPath;
  fs.writeFileSync(previousAudio, 'user-edited prior export');
  file.dubbingError = 'previous failed attempt';
  await pipeline.runDubStage(event, file, task);
  assert.equal(file.dubbingError, '');
  assert.equal(
    requests.length,
    beforeRebuild,
    'failed-stage retry also retains workbench config',
  );
  assert.equal(
    fs.readFileSync(previousAudio, 'utf8'),
    'user-edited prior export',
  );
  assert.notEqual(file.dubbedAudioPath, previousAudio);
  assert.equal(
    file.shiftedSubtitlePath,
    undefined,
    'unchanged captions retain original artifact and styles',
  );
  const oldTrack = file.dubbedTrackPath;
  await pipeline.runDubStage(event, file, {
    ...task,
    dub: { ...task.dub, voice: '1' },
  });
  assert.equal(
    requests.length,
    beforeRebuild + 2,
    'explicit task voice change regenerates',
  );
  assert.equal(
    requests.at(-1).speed,
    1.1,
    'unchanged task speed preserves workbench repair',
  );
  assert.notEqual(file.dubbedTrackPath, oldTrack);
  assert.ok(
    fs.existsSync(oldTrack),
    'in-flight consumers retain immutable old track',
  );

  const bilingual = path.join(temp, 'bilingual.srt');
  fs.writeFileSync(
    bilingual,
    '1\n00:00:00,000 --> 00:00:10,000\nOriginal one\n90%\n\n2\n00:00:10,000 --> 00:00:20,000\nOriginal two\n2026年\n',
  );
  file.translatedSrtFile = bilingual;
  await proc.resynthesizeCue(
    reviewed,
    0,
    { text: 'Short.' },
    reviewed.lastConfig,
  );
  await pipeline.runDubStage(event, file, {
    ...task,
    dub: { ...task.dub, voice: '1' },
  });
  assert.match(
    fs.readFileSync(file.shiftedSubtitlePath, 'utf8'),
    /Original one\nShort\./,
  );
  assert.doesNotMatch(fs.readFileSync(file.shiftedSubtitlePath, 'utf8'), /90%/);
  assert.match(
    fs.readFileSync(file.shiftedSubtitlePath, 'utf8'),
    /00:00:10,000 --> 00:00:20,000/,
  );
  const goodBilingual = fs.readFileSync(bilingual, 'utf8');
  fs.writeFileSync(bilingual, goodBilingual.replace('90%', '90%\n90%'));
  await assert.rejects(
    pipeline.rebuildDubTrackForFile(event, file, {
      ...task,
      dub: { ...task.dub, voice: '1' },
    }),
    /安全更新双语字幕/,
  );
  fs.writeFileSync(
    bilingual,
    goodBilingual.replace('00:00:10,000 -->', '00:00:11,000 -->'),
  );
  await assert.rejects(
    pipeline.rebuildDubTrackForFile(event, file, {
      ...task,
      dub: { ...task.dub, voice: '1' },
    }),
    /时间轴不一致/,
  );
  fs.writeFileSync(bilingual, goodBilingual);
  proc.disposeDubbingSession(reviewed.id);
  const restoredReview = proc.restoreDubbingSession(reviewed.id).session;
  assert.equal(restoredReview.pipelineConfigSnapshot.voice, '1');
  assert.equal(restoredReview.lastConfig.globalSpeed, 1.1);
  const oldSession = file.dubbingSessionId;
  const oldSubtitle = reviewed.subtitlePath;
  const oldWav = reviewed.cues[0].wavPath;
  fs.writeFileSync(
    subtitle,
    fs.readFileSync(subtitle, 'utf8').replace('90%', 'Updated upstream.'),
  );
  file.translatedSrtFile = undefined;
  await pipeline.rebuildDubTrackForFile(event, file, task);
  assert.notEqual(
    file.dubbingSessionId,
    oldSession,
    'upstream edits replace even an in-memory session',
  );
  assert.ok(fs.existsSync(oldWav));
  assert.match(fs.readFileSync(oldSubtitle, 'utf8'), /90%/);
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

  // Workbench (#537): a bilingual deliverable is dubbed from its translation
  // only. The pipeline above already rebuilds a pure-translation subtitle.
  const proofreadStorage = require('../../main/helpers/proofreadDataStorage.ts');
  const wbDir = path.join(temp, 'workbench-bilingual');
  const wbManaged = path.join(wbDir, 'proofread-data');
  fs.mkdirSync(path.join(wbDir, 'tmp'), { recursive: true });
  fs.mkdirSync(wbManaged, { recursive: true });
  const wbRows = [
    ['Hello there, welcome to our show.', '你好，欢迎来到我们的节目。'],
    [
      'How was your day today, I hope everything went well.',
      '你今天过得怎么样，希望一切顺利。',
    ],
  ];
  const wbChinese = wbRows.map(([, zh]) => zh);
  const wbTime = (index) =>
    `00:00:${String(index * 10).padStart(2, '0')},000 --> 00:00:${String(index * 10 + 10).padStart(2, '0')},000`;
  const wbSrtOf = (texts) =>
    texts
      .map((text, index) => `${index + 1}\n${wbTime(index)}\n${text}\n`)
      .join('\n');
  const wbBilingualSrt = wbSrtOf(wbRows.map(([en, zh]) => `${en}\n${zh}`));
  const wbSrt = path.join(wbDir, 'episode.zh-en.srt');
  const wbVtt = path.join(wbDir, 'episode.zh-en.vtt');
  const wbPure = path.join(wbDir, 'tmp', 'episode.zh.srt');
  const wbTempFinal = path.join(wbDir, 'tmp', 'episode.final.srt');
  fs.writeFileSync(wbSrt, wbBilingualSrt);
  fs.writeFileSync(wbTempFinal, wbBilingualSrt);
  fs.writeFileSync(wbPure, wbSrtOf(wbChinese));
  fs.writeFileSync(
    wbVtt,
    'WEBVTT\n\n' +
      wbRows
        .map(
          ([en, zh], index) =>
            `${wbTime(index).replaceAll(',', '.')}\n${en}\n${zh}\n`,
        )
        .join('\n'),
  );
  fs.writeFileSync(
    path.join(wbManaged, 'episode.json'),
    JSON.stringify({
      version: 2,
      speakers: [],
      meta: {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hant',
        translateContent: 'sourceAndTranslate',
        targetFile: wbPure,
        finalTargetFile: wbSrt,
        translatedSubtitleFiles: [wbSrt, wbVtt],
        tempFinalSubtitleFile: wbTempFinal,
      },
      cues: wbRows.map(([en, zh], index) => ({
        id: String(index + 1),
        startMs: index * 10000,
        endMs: index * 10000 + 10000,
        source: en,
        target: zh,
      })),
    }),
  );
  proofreadStorage.setProofreadDataRoot(wbManaged);
  try {
    // Every delivered file is recognised without being handed the sidecar,
    // including the second format and the compose-oriented temp file.
    for (const delivered of [wbSrt, wbVtt, wbTempFinal]) {
      const found = await proc.createDubbingSession(delivered);
      const name = path.basename(delivered);
      assert.deepEqual(
        found.cues.map((cue) => cue.text),
        wbChinese,
        `${name}: only the translation is dubbed`,
      );
      assert.equal(
        found.subtitleLanguage,
        'zh-Hant',
        `${name}: target language`,
      );
      assert.equal(
        found.detectedLanguage,
        'zh',
        `${name}: language is detected from the spoken text`,
      );
      assert.deepEqual(
        found.cues.map((cue) => cue.display),
        wbRows.map((lines) => ({ lines, from: 1, to: 2 })),
        `${name}: bilingual layout is kept for the exported subtitle`,
      );
      proc.disposeDubbingSession(found.id);
    }

    const wbSession = await proc.createDubbingSession(wbSrt);
    const beforeWorkbench = requests.length;
    await proc.runDubbingBatch(wbSession, config, () => {});
    assert.deepEqual(
      requests.slice(beforeWorkbench).map((request) => request.text),
      wbChinese,
      'the synthesis engine never receives the source line',
    );
    assert.ok(
      requests
        .slice(beforeWorkbench)
        .every((request) => request.language === 'zh-Hant'),
    );
    proc.disposeDubbingSession(wbSession.id);
    const wbReopened = proc.restoreDubbingSession(wbSession.id).session;
    assert.deepEqual(
      wbReopened.cues.map((cue) => cue.display),
      wbSession.cues.map((cue) => cue.display),
      'bilingual layout survives reopening the session',
    );
    assert.deepEqual(
      wbReopened.cues.map((cue) => cue.text),
      wbChinese,
    );
    assert.equal(
      proc.syncDubbingVoiceStaleness(wbReopened, config),
      0,
      'reopened bilingual session reuses its audio',
    );
    proc.disposeDubbingSession(wbReopened.id);

    // The pipeline hands over its own sidecar together with a rebuilt
    // pure-translation subtitle: that file must not be treated as bilingual.
    const wbPureSession = await proc.createDubbingSession(
      wbPure,
      undefined,
      path.join(wbManaged, 'episode.json'),
    );
    assert.deepEqual(
      wbPureSession.cues.map((cue) => cue.text),
      wbChinese,
    );
    assert.equal(
      wbPureSession.cues.some((cue) => cue.display),
      false,
    );
    assert.equal(wbPureSession.subtitleLanguage, 'zh-Hant');
    proc.disposeDubbingSession(wbPureSession.id);

    // A cue edited in both columns cannot be located: it keeps its whole text
    // while the remaining cues are still reduced to the translation.
    fs.writeFileSync(
      wbTempFinal,
      wbSrtOf([
        `${wbRows[0][0]}\n${wbRows[0][1]}`,
        'Edited source.\n改过的译文',
      ]),
    );
    const wbPartial = await proc.createDubbingSession(wbTempFinal);
    assert.deepEqual(
      wbPartial.cues.map((cue) => cue.text),
      [wbChinese[0], 'Edited source. 改过的译文'],
    );
    assert.equal(wbPartial.cues[1].display, undefined);
    proc.disposeDubbingSession(wbPartial.id);

    // Nothing records which line of an external bilingual file is the
    // translation, so it keeps its whole text.
    proofreadStorage.setProofreadDataRoot(undefined);
    const wbExternal = path.join(wbDir, 'external.srt');
    fs.writeFileSync(wbExternal, wbBilingualSrt);
    const wbExternalSession = await proc.createDubbingSession(wbExternal);
    assert.deepEqual(
      wbExternalSession.cues.map((cue) => cue.text),
      wbRows.map(([en, zh]) => `${en} ${zh}`),
    );
    proc.disposeDubbingSession(wbExternalSession.id);
  } finally {
    proofreadStorage.setProofreadDataRoot(undefined);
  }

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
  const wavIo = require('../../extraResources/sherpa/worker/wav-io.js');
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
          : name.endsWith('wav-io.js')
            ? wavIo
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
