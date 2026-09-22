const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-download-unit-'));
const media = path.join(root, 'lesson.mp4');
const en = path.join(root, 'lesson.en.srt');
const zh = path.join(root, 'lesson.zh.srt');
fs.writeFileSync(media, 'media fixture');
fs.writeFileSync(en, '1\n00:00:00,000 --> 00:00:01,000\nOfficial English\n');
fs.writeFileSync(zh, '1\n00:00:00,000 --> 00:00:01,000\nChinese fixture\n');
let checks = 0;
function check(name, run) {
  run();
  checks++;
  console.log(`PASS ${name}`);
}

function harness(initial) {
  let disk = structuredClone(
    initial || {
      workItemsMigrationVersion: 1,
      workItems: [],
      settings: {},
      userConfig: {},
      taskRecipes: [
        {
          id: 'recipe',
          name: 'Download recipe',
          accepts: 'media',
          goals: { translate: false, dub: false, video: false },
          config: {
            sourceLanguage: 'en',
            transcriptionEngine: 'builtin',
            model: 'base',
          },
        },
      ],
      translationProviders: [],
      asrProviders: [],
      ttsProviders: [],
      clonedVoices: [],
    },
  );
  let failedWrites = 0;
  let afterAccepted;
  let enqueued = 0;
  const readiness = {
    models: [],
    sherpa: false,
    runtime: false,
    vad: false,
    tts: false,
    speaker: false,
  };
  const cache = new Map();
  const store = {
    get: (key) => structuredClone(disk[key]),
    set(key, value) {
      if (failedWrites > 0) {
        failedWrites--;
        throw new Error('ENOSPC');
      }
      disk = {
        ...disk,
        ...structuredClone(typeof key === 'string' ? { [key]: value } : key),
      };
    },
  };
  const stubs = {
    '../storeManager': { store },
    './store': { store },
    '../utils': {
      defaultUserConfig: {
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        model: 'base',
        transcriptionEngine: 'builtin',
      },
    },
    '../whisper': { getModelsInstalled: () => readiness.models },
    '../modelCatalog': {
      getFasterWhisperModelsInstalled: () => readiness.models,
    },
    '../pythonRuntime/paths': { isRuntimeInstalled: () => readiness.runtime },
    '../sherpaOnnx/sherpaLibPaths': {
      isSherpaLibInstalled: () => readiness.sherpa,
    },
    '../funasrModelCatalog': {
      getInstalledFunasrAsrModels: () => readiness.models,
      isFunasrVadInstalled: () => readiness.vad,
    },
    '../qwenModelCatalog': {
      getInstalledQwenModels: () => readiness.models,
      isQwenVadInstalled: () => readiness.vad,
    },
    '../fireRedModelCatalog': {
      getInstalledFireRedModels: () => readiness.models,
      isFireRedVadInstalled: () => readiness.vad,
    },
    '../parakeetModelCatalog': {
      getInstalledParakeetModels: () => readiness.models,
      isParakeetVadInstalled: () => readiness.vad,
    },
    '../speakerDiarization/modelCatalog': {
      isSpeakerDiarizationModelInstalled: () => readiness.speaker,
    },
    '../ttsModelCatalog': {
      isTtsModelInstalled: () => readiness.tts,
      TTS_MODELS: {
        'vits-zh-aishell3': { voices: [{ id: '0', lang: 'zh' }] },
        'zipvoice-distill-zh-en': { cloneOnly: true, voices: [] },
      },
    },
    '../fileUtils': {
      wrapFileObject: (filePath) => ({
        uuid: 'random',
        filePath,
        fileName: path.basename(filePath),
        size: fs.statSync(filePath).size,
      }),
    },
    '../taskProcessor': {
      enqueueTaskSubmission(input) {
        const entry = disk.workItems.find(
          (item) => item.id === input.formData.sourceDownloadWorkItemId,
        ).downloadEntries[0];
        assert.equal(
          entry.pipeline.status,
          'pending',
          'pending intent durable before acceptance',
        );
        const { result } = load(
          'main/helpers/taskSubmission.ts',
        ).persistTaskSubmission(input, new Set());
        if (!result.duplicate) enqueued++;
        afterAccepted?.();
        return result;
      },
    },
  };
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        structuredClone,
        process,
        console,
        setTimeout: () => ({ unref() {} }),
        clearTimeout() {},
        require(request) {
          if (stubs[request]) return stubs[request];
          if (request.startsWith('.'))
            return load(path.resolve(path.dirname(filename), `${request}.ts`));
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  }
  const items = load('main/helpers/workItemStore.ts');
  items.initializeWorkItemStore();
  const pipeline = load('main/helpers/videoDownload/pipeline.ts');
  return {
    pipeline,
    items,
    store,
    readiness,
    load,
    disk: () => structuredClone(disk),
    count: () => enqueued,
    fail: (count) => {
      failedWrites = count;
    },
    after: (callback) => {
      afterAccepted = callback;
    },
    seed(patch = {}, entryPatch = {}) {
      const config = pipeline.resolveDownloadPipeline('recipe');
      config.formData = { ...config.formData, ...patch };
      items.saveWorkItem(
        {
          id: 'batch',
          name: 'Batch',
          type: 'download',
          status: 'done',
          createdAt: 1,
          updatedAt: 1,
          configSnapshot: { autoChain: config },
          downloadEntries: [
            {
              id: 'entry',
              url: 'https://example.com/1',
              engine: 'yt-dlp',
              status: 'done',
              outputPath: media,
              subtitlePaths: [en, zh],
              ...entryPatch,
            },
          ],
        },
        { durable: true },
      );
      return config;
    },
    handoff() {
      pipeline.handoffDownloadEntry('batch', 'entry');
    },
    state() {
      return items.getWorkItemById('batch').downloadEntries[0].pipeline;
    },
  };
}

check(
  'official subtitle selection rejects ambiguous languages and unrelated paths',
  () => {
    const { selectDownloadedSubtitle: select } = harness().pipeline;
    assert.equal(select(media, [en, zh], 'en'), en);
    assert.equal(select(media, [en, zh], 'auto'), undefined);
    assert.equal(select(media, [en, zh], 'fr'), undefined);
    assert.equal(select(media, [en], 'en-US'), en);
    assert.equal(
      select(
        media,
        [en.replace('.en.', '.en-US.'), en.replace('.en.', '.en-GB.')],
        'en',
      ),
      undefined,
    );
    assert.equal(
      select(media, [en.replace(root, root + '-other')], 'en'),
      undefined,
    );
    assert.equal(select(media, [en.replace('.srt', '.vtt'), en], 'en'), en);
  },
);
check(
  'snapshot fills required defaults, strips manuscript, and hashes consent-independent config',
  () => {
    const h = harness();
    h.store.set('userConfig', {
      manuscriptPath: '/old.txt',
      manuscriptName: 'old',
      transcriptionEngine: 'cloud',
    });
    const first = h.pipeline.resolveDownloadPipeline('recipe');
    assert.equal(first.formData.manuscriptPath, undefined);
    assert.equal(first.formData.translateRetryTimes, '3');
    assert.equal(first.formData.transcriptionEngine, 'builtin');
    assert.equal(first.formData.translateProvider, '-1');
    assert.equal(
      h.pipeline.downloadPipelineKey(first),
      h.pipeline.downloadPipelineKey({ ...first, cloudUploadConsent: true }),
    );
    assert.notEqual(
      h.pipeline.downloadPipelineKey(first),
      h.pipeline.downloadPipelineKey({
        ...first,
        formData: { ...first.formData, model: 'other' },
      }),
    );
    assert.throws(
      () => h.pipeline.resolveDownloadPipeline('deleted'),
      /RECIPE_REQUIRED/,
    );
  },
);
check(
  'official subtitles bypass missing ASR and never duplicate accepted or deleted child',
  () => {
    const h = harness();
    h.seed();
    h.handoff();
    assert.equal(h.state().status, 'submitted');
    assert.equal(h.count(), 1);
    const child = h.items.getWorkItemById(h.state().projectId);
    assert.equal(child.pipelineFiles[0].providedSubtitlePath, en);
    h.handoff();
    h.items.deleteWorkItem(child.id);
    h.handoff();
    assert.equal(h.count(), 1);
  },
);
check(
  'missing ASR blocks handoff only, retry retains original recipe and files',
  () => {
    const h = harness();
    h.seed({}, { subtitlePaths: [] });
    h.handoff();
    assert.match(h.state().error, /ASR_REQUIRED/);
    const original = structuredClone(h.state().submission);
    h.store.set('taskRecipes', []);
    h.store.set('userConfig', { model: 'other' });
    h.readiness.models = ['base'];
    h.handoff();
    assert.equal(h.state().status, 'submitted');
    assert.deepEqual(
      h.items.getWorkItemById(h.state().projectId).configSnapshot,
      original.formData,
    );
  },
);
check(
  'cloud fallback requires explicit consent and exact configured model',
  () => {
    const h = harness();
    h.seed(
      { transcriptionEngine: 'cloud', model: 'asr', asrProviderId: 'cloud' },
      { subtitlePaths: [] },
    );
    h.handoff();
    assert.match(h.state().error, /CLOUD_CONSENT_REQUIRED/);
    h.store.set('settings', { cloudUploadConsent: true });
    h.handoff();
    assert.match(h.state().error, /ASR_REQUIRED/);
    h.store.set('asrProviders', [
      {
        id: 'cloud',
        name: 'Cloud',
        type: 'openaiCompatible',
        apiUrl: 'https://example.com/v1',
        apiKey: 'test',
        models: 'other',
      },
    ]);
    h.handoff();
    assert.match(h.state().error, /ASR_REQUIRED/);
    h.store.set('asrProviders', [
      { ...h.store.get('asrProviders')[0], models: 'asr' },
    ]);
    h.handoff();
    assert.equal(h.state().status, 'submitted');
  },
);
check(
  'official-only cloud config never requires upload consent or provider',
  () => {
    const h = harness();
    h.seed({ transcriptionEngine: 'cloud', asrProviderId: 'deleted' });
    h.handoff();
    assert.equal(h.state().status, 'submitted');
  },
);
check(
  'pending disk failure prevents enqueue; repaired retry succeeds once',
  () => {
    const h = harness();
    h.seed();
    h.fail(1);
    h.handoff();
    assert.match(h.state().error, /ENOSPC/);
    assert.equal(h.count(), 0);
    h.handoff();
    assert.equal(h.count(), 1);
    assert.equal(h.state().status, 'submitted');
  },
);
check(
  'lost acknowledgement reconciles accepted receipt without requeue',
  () => {
    const h = harness();
    h.seed();
    h.after(() => {
      throw new Error('ACK_LOST');
    });
    h.handoff();
    assert.match(h.state().error, /ACK_LOST/);
    assert.equal(h.count(), 1);
    const resumed = harness(h.disk());
    resumed.handoff();
    assert.equal(resumed.state().status, 'submitted');
    assert.equal(resumed.count(), 0);
  },
);
check(
  'crash after accepted child and before parent commit recovers without replay',
  () => {
    const h = harness();
    h.seed();
    h.after(() => h.fail(2));
    assert.throws(() => h.handoff(), /ENOSPC/);
    assert.equal(h.state().status, 'pending');
    const resumed = harness(h.disk());
    resumed.pipeline.recoverDownloadHandoffs();
    assert.equal(resumed.state().status, 'submitted');
    assert.equal(resumed.count(), 0);
  },
);
check(
  'restart dispatches durable unaccepted intent, but never retries explicit failures',
  () => {
    const h = harness();
    h.seed();
    const resumed = harness(h.disk());
    resumed.pipeline.recoverDownloadHandoffs();
    assert.equal(resumed.count(), 1);
    const failed = harness();
    failed.seed({}, { subtitlePaths: [] });
    failed.handoff();
    const again = harness(failed.disk());
    again.readiness.models = ['base'];
    again.pipeline.recoverDownloadHandoffs();
    assert.equal(again.count(), 0);
    assert.equal(again.state().status, 'error');
  },
);
check('changed pending request cannot claim an unrelated receipt', () => {
  const h = harness();
  h.seed();
  h.after(() => {
    throw new Error('ACK_LOST');
  });
  h.handoff();
  const batch = h.items.getWorkItemById('batch');
  batch.downloadEntries[0].pipeline.submission.formData.model = 'tampered';
  h.items.saveWorkItem(batch, { durable: true });
  h.handoff();
  assert.match(h.state().error, /REQUEST_CONFLICT/);
  assert.equal(h.count(), 1);
});
check(
  'missing media and malformed subtitle stay visible and repairable',
  () => {
    const h = harness();
    h.seed({}, { outputPath: path.join(root, 'missing.mp4') });
    h.handoff();
    assert.equal(h.state().status, 'error');
    assert.equal(h.count(), 0);
    const invalid = path.join(root, 'lesson.fr.srt');
    fs.writeFileSync(invalid, 'not a subtitle');
    const bad = harness();
    bad.seed({ sourceLanguage: 'fr' }, { subtitlePaths: [invalid] });
    bad.handoff();
    assert.match(bad.state().error, /SUBTITLE_INVALID/);
    assert.equal(bad.count(), 0);
  },
);
check('TTS validates provider, exact voice, local runtime and language', () => {
  const dub = {
    engine: { kind: 'cloud', providerId: 'tts' },
    voice: 'alloy',
    globalSpeed: 1,
  };
  const h = harness();
  h.seed({ dub });
  h.handoff();
  assert.match(h.state().error, /TTS_REQUIRED/);
  h.store.set('ttsProviders', [
    {
      id: 'tts',
      name: 'TTS',
      type: 'openaiCompatible',
      apiUrl: 'https://example.com/v1',
      apiKey: 'test',
      model: 'tts',
      voices: 'other',
    },
  ]);
  h.handoff();
  assert.match(h.state().error, /VOICE_REQUIRED/);
  h.store.set('ttsProviders', [
    { ...h.store.get('ttsProviders')[0], voices: 'alloy' },
  ]);
  h.handoff();
  assert.equal(h.state().status, 'submitted');
  const local = harness();
  local.seed({
    dub: {
      ...dub,
      engine: { kind: 'local', modelId: 'vits-zh-aishell3' },
      voice: '0',
    },
  });
  local.handoff();
  assert.match(local.state().error, /TTS_REQUIRED/);
  local.readiness.sherpa = true;
  local.readiness.tts = true;
  local.handoff();
  assert.match(local.state().error, /TTS_LANGUAGE_REQUIRED/);
  const cloned = harness();
  cloned.readiness.sherpa = true;
  cloned.readiness.tts = true;
  cloned.store.set('clonedVoices', [
    { id: 'clone', engine: 'zipvoice', language: 'en' },
  ]);
  cloned.seed({
    dub: {
      ...dub,
      engine: { kind: 'local', modelId: 'zipvoice-distill-zh-en' },
      voice: 'clone',
    },
  });
  cloned.handoff();
  assert.match(cloned.state().error, /VOICE_REQUIRED/);
});
check(
  'native subtitle bypass does not bypass diarization or invalid composition',
  () => {
    const h = harness();
    h.seed({ speakerDiarization: true });
    h.handoff();
    assert.match(h.state().error, /SPEAKERS_REQUIRED/);
    h.readiness.sherpa = true;
    h.readiness.speaker = true;
    h.handoff();
    assert.equal(h.state().status, 'submitted');
    const bad = harness();
    bad.seed({ compose: { subtitle: 'none' } });
    bad.handoff();
    assert.match(bad.state().error, /COMPOSE_REQUIRED/);
  },
);
check(
  'translation and refinement dependencies are checked independently',
  () => {
    const h = harness();
    h.seed({
      taskType: 'generateAndTranslate',
      translateProvider: 'translate',
    });
    h.handoff();
    assert.match(h.state().error, /TRANSLATION_REQUIRED/);
    h.store.set('translationProviders', [
      {
        id: 'translate',
        name: 'AI',
        type: 'openai',
        isAi: true,
        apiUrl: 'https://example.com/v1',
        apiKey: 'test',
        modelName: 'model',
        prompt: '${content}',
      },
    ]);
    h.handoff();
    assert.equal(h.state().status, 'submitted');
    const refine = harness();
    refine.readiness.models = ['base'];
    refine.seed(
      { aiCorrection: true, refineProvider: 'missing' },
      { subtitlePaths: [] },
    );
    refine.handoff();
    assert.match(refine.state().error, /REFINE_REQUIRED/);
    const native = harness();
    native.seed({ aiCorrection: true, refineProvider: 'missing' });
    native.handoff();
    assert.equal(
      native.state().status,
      'submitted',
      'no ASR refinement runs for imported official subtitles',
    );
  },
);
check(
  'every local ASR family requires the selected model and its runtime',
  () => {
    for (const engine of [
      'fasterWhisper',
      'funasr',
      'qwen',
      'fireRedAsr',
      'parakeet',
    ]) {
      const h = harness();
      const model = engine === 'parakeet' ? 'parakeet-tdt-0.6b-v3' : 'selected';
      h.seed({ transcriptionEngine: engine, model }, { subtitlePaths: [] });
      h.handoff();
      assert.match(h.state().error, /ASR_REQUIRED/);
      h.readiness.models = [model];
      h.handoff();
      assert.match(h.state().error, /ASR_REQUIRED/);
      h.readiness.runtime = true;
      h.readiness.sherpa = true;
      h.readiness.vad = true;
      h.handoff();
      assert.equal(h.state().status, 'submitted', engine);
    }
  },
);
check('composition defaults are pinned at batch creation', () => {
  const h = harness();
  const recipe = h.store.get('taskRecipes')[0];
  h.store.set('taskRecipes', [
    {
      ...recipe,
      goals: { ...recipe.goals, video: true },
      config: {
        ...recipe.config,
        compose: { subtitle: 'hard', style: { fontSize: 33 } },
      },
    },
  ]);
  h.store.set('mergePreferences', { videoQuality: 'high', encoderMode: 'cpu' });
  const config = h.pipeline.resolveDownloadPipeline('recipe');
  assert.equal(config.formData.compose.videoQuality, 'high');
  assert.equal(config.formData.compose.style.fontSize, 33);
  assert.ok(config.formData.compose.style.fontName);
  h.store.set('mergePreferences', { videoQuality: 'standard' });
  assert.notEqual(
    h.pipeline.downloadPipelineKey(config),
    h.pipeline.downloadPipelineKey(
      h.pipeline.resolveDownloadPipeline('recipe'),
    ),
  );
});
check(
  'retry validates changed official subtitle bytes before acceptance',
  () => {
    const h = harness();
    h.seed({ speakerDiarization: true });
    h.handoff();
    h.readiness.sherpa = true;
    h.readiness.speaker = true;
    const original = fs.readFileSync(en);
    try {
      fs.writeFileSync(en, 'corrupt');
      h.handoff();
      assert.match(h.state().error, /SUBTITLE_INVALID/);
      assert.equal(h.count(), 0);
    } finally {
      fs.writeFileSync(en, original);
    }
    h.handoff();
    assert.equal(h.state().status, 'submitted');
  },
);
console.log(`Download pipeline: ${checks} scenarios passed. Fixtures: ${root}`);
