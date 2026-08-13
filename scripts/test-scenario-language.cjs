const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let translate;
let failRefineWrite = false;
const glossary = {
  entries: [
    {
      id: 'term',
      source: 'Kubernetes',
      target: 'GLOSSARY_TRANSLATION_ONLY',
      glossaryId: 'global',
      glossaryName: 'Technical terms',
      glossaryOrder: 0,
      entryOrder: 0,
    },
  ],
  conflicts: [],
};
require.extensions['.ts'] = (module, filename) =>
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => path.join(process.cwd(), 'node_modules/.cache'),
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  if (request.endsWith('/storeManager'))
    return {
      logMessage() {},
      store: {
        get: (key) => (key === 'translationProviders' ? [provider] : {}),
      },
    };
  if (
    parent?.filename.endsWith('/subtitleRefineStage.ts') &&
    request === './atomicFile'
  ) {
    return {
      atomicReplaceTextFile: (target, content, options) =>
        atomicReplaceTextFile(target, content, {
          ...options,
          operations: {
            open: fs.promises.open,
            rm: fs.promises.rm,
            rename: (...args) =>
              failRefineWrite
                ? Promise.reject(new Error('disk commit failed'))
                : fs.promises.rename(...args),
          },
        }),
    };
  }
  if (request.endsWith('/glossaryManager'))
    return {
      getActiveGlossaryResolution: () => glossary,
      // No ids keeps the fixture glossary so GLOSSARY_TRANSLATION_ONLY is still injected.
      // An explicit empty id list means no glossary, matching resolveTaskGlossaryEntries.
      getTaskGlossaryResolution: (ids) =>
        Array.isArray(ids) && ids.length === 0
          ? { entries: [], conflicts: [] }
          : glossary,
      logGlossaryConflicts() {},
      logGlossaryMatches() {},
    };
  if (request === '../../service')
    return { openaiTranslator: (...args) => translate(...args) };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  runAiCorrection,
} = require('../main/helpers/subtitleRefine/correctionRunner.ts');
const {
  translateWithProvider,
} = require('../main/translate/services/translationProvider.ts');
const { SCENARIO_PRESETS } = require('../renderer/lib/scenarioPresets.ts');
const { atomicReplaceTextFile } = require('../main/helpers/atomicFile.ts');
const {
  runSubtitleRefineStage,
} = require('../main/helpers/subtitleRefineStage.ts');
const provider = {
  id: 'primary',
  name: 'Primary',
  type: 'openai',
  isAi: true,
  apiUrl: 'http://localhost:1234/v1',
  apiKey: 'test-only',
  modelName: 'fixture',
  prompt: '${content}',
  systemPrompt: 'Translate ${sourceLanguage} to ${targetLanguage}.',
  echoAnchoring: true,
  batchConcurrency: 1,
  requestInterval: 0,
};
let checks = 0;
const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
async function testRefineCommit() {
  const evidence = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-refine-save-'),
  );
  const srtFile = path.join(evidence, 'original.srt');
  const original = '1\n00:00:01,123 --> 00:00:03,456\nKubernets\n\n';
  fs.writeFileSync(srtFile, original);
  translate = async () =>
    JSON.stringify({ 1: { src: 'Kubernets', tr: 'Kubernetes' } });
  const file = {
    uuid: 'refine',
    fileName: 'original',
    filePath: path.join(evidence, 'clip.wav'),
    srtFile,
  };
  const state = {};
  const event = {
    sender: {
      send: (channel, payload) => {
        if (channel === 'taskFileChange') Object.assign(state, payload);
      },
    },
  };
  const config = {
    aiCorrection: true,
    refineProvider: provider.id,
    sourceLanguage: 'en',
    subtitleFillerPolicy: 'remove-hesitations',
  };
  failRefineWrite = true;
  await runSubtitleRefineStage(event, file, config);
  check(
    fs.readFileSync(srtFile, 'utf8'),
    original,
    'failed refine commit preserves original file',
  );
  check(
    state.refineSubtitle,
    'done',
    'optional failed refinement settles with warning',
  );
  check(state.refineSubtitleError, 'disk commit failed');
  check(
    fs.readdirSync(evidence).filter((file) => file.endsWith('.tmp')),
    [],
    'failed temporary output cleaned',
  );
  failRefineWrite = false;
  await runSubtitleRefineStage(event, file, config);
  check(
    fs.readFileSync(srtFile, 'utf8').includes('Kubernetes'),
    true,
    'retry commits corrected text',
  );
  check(
    file.refineSubtitleError,
    undefined,
    'successful retry clears prior warning',
  );
}
async function run() {
  const before = structuredClone(provider);
  for (const scenario of ['lecture', 'movie', 'shortDrama']) {
    const preset = SCENARIO_PRESETS.find((p) => p.id === scenario);
    const inputText = 'Um, Kubernets is ready. Ah!';
    const corrected =
      scenario === 'lecture'
        ? 'Kubernetes is ready. Ah!'
        : 'Um, Kubernetes is ready. Ah!';
    let requests = 0;
    translate = async (text, config, from, to, options) => {
      requests++;
      check(from, 'en');
      check(to, 'en', 'correction does not translate');
      check(options.responseJsonSchema.required, ['1']);
      check(
        config.systemPrompt.includes('Kubernetes'),
        true,
        'canonical term supplied',
      );
      check(
        config.systemPrompt.includes('GLOSSARY_TRANSLATION_ONLY'),
        false,
        'translation term never enters ASR correction',
      );
      check(
        config.systemPrompt.includes(
          scenario === 'lecture'
            ? 'Remove only semantically empty'
            : 'Preserve all interjections',
        ),
        true,
        'actual request applies scenario policy',
      );
      check(
        config.systemPrompt.includes('2. Remove hesitation filler words'),
        false,
        'no conflicting legacy instruction',
      );
      check(text.includes(inputText), true);
      return JSON.stringify({ 1: { src: inputText, tr: corrected } });
    };
    const cues = [['00:00:01,123', '00:00:03,456', inputText]];
    const outcome = await runAiCorrection({
      cues,
      formData: { ...preset.fields, sourceLanguage: 'en' },
      provider,
    });
    check(
      outcome.cues,
      [['00:00:01,123', '00:00:03,456', corrected]],
      'correction preserves timing and count',
    );
    check(outcome.degraded, false);
    check(requests, 1);
    check(cues[0][2], inputText, 'caller data is not mutated');
  }
  // A malformed echo must not be accepted just because the requested style is set.
  translate = async () =>
    JSON.stringify({ 1: { src: 'unrelated source', tr: 'invented output' } });
  const unaligned = await runAiCorrection({
    cues: [['00:00:00,000', '00:00:01,000', 'Original sentence']],
    formData: { sourceLanguage: 'en', subtitleFillerPolicy: 'preserve' },
    provider,
  });
  check(unaligned.cues[0][2], 'Original sentence');
  check(unaligned.degraded, true);

  const subtitle = {
    id: '1',
    startEndTime: '00:00:01,123 --> 00:00:03,456',
    content: ['Ah, Kubernetes!'],
  };
  const fallback = { ...provider, id: 'fallback', name: 'Fallback' };
  const calls = [];
  const switches = [];
  translate = async (text, config, _from, _to, options) => {
    calls.push(config.id);
    check(
      config.systemPrompt.includes('<subtitle-style>'),
      true,
      'style survives provider fallback',
    );
    check(
      config.systemPrompt.includes('GLOSSARY_TRANSLATION_ONLY'),
      true,
      'translation glossary is preserved',
    );
    check(options.responseJsonSchema.required, ['1']);
    if (config.id === 'primary')
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    return JSON.stringify({
      1: { src: subtitle.content[0], tr: '啊，GLOSSARY_TRANSLATION_ONLY！' },
    });
  };
  const result = await translateWithProvider(
    provider,
    [subtitle],
    'en',
    'zh',
    (...args) => translate(...args),
    undefined,
    undefined,
    0,
    true,
    undefined,
    [fallback],
    (event) => switches.push(event.to.id),
    'conversational',
  );
  check(calls, ['primary', 'fallback']);
  check(switches, ['fallback']);
  check(result[0].targetContent, '啊，GLOSSARY_TRANSLATION_ONLY！');
  check(result[0].startEndTime, subtitle.startEndTime);
  check(provider, before, 'task style never mutates saved provider');
  translate = async (_text, config) => {
    check(
      config.systemPrompt.includes('<subtitle-style>'),
      false,
      'next neutral task does not inherit style',
    );
    return JSON.stringify({ 1: { src: subtitle.content[0], tr: '常规翻译' } });
  };
  await translateWithProvider(
    provider,
    [subtitle],
    'en',
    'zh',
    (...args) => translate(...args),
    undefined,
    undefined,
    0,
    true,
    undefined,
    undefined,
    undefined,
    'neutral',
  );
  await assert.rejects(
    translateWithProvider(
      { ...provider, isAi: false },
      [subtitle],
      'en',
      'zh',
      () => {
        throw new Error('must not call MT');
      },
      undefined,
      undefined,
      0,
      true,
      undefined,
      undefined,
      undefined,
      'conversational',
    ),
    /requires an AI provider/,
  );
  checks++;
  await testRefineCommit();
  console.log(
    `Scenario language: ${checks} checks passed (real correction, glossary, anchored validation, translation and fallback).`,
  );
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
