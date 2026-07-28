/**
 * Offline integration checks for handleAIBatchTranslation.
 *
 * Production TypeScript is transpiled on demand so this test invokes the real
 * batch/retry/repair loop. Electron logging/store boundaries are replaced with
 * in-memory stubs; the translator itself is injected and never uses a network.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const capturedLogs = [];
const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];

Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request).replace(/\\/g, '/');
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => repoRoot,
        getPath: () => path.join(repoRoot, 'node_modules', '.cache'),
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (normalized.endsWith('/helpers/storeManager')) {
    return {
      logMessage: (message, type = 'info') => {
        capturedLogs.push({ message: String(message), type });
      },
      store: {
        get: () => ({}),
      },
    };
  }
  if (normalized.endsWith('/helpers/glossaryManager')) {
    return { logGlossaryMatches: () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => repoRoot,
        getNewLine: () => '\n',
      }),
    );
  }
  module._compile(output.outputText, filename);
};

const {
  handleAIBatchTranslation,
} = require('../main/translate/services/ai.ts');

let passed = 0;
let failed = 0;

function ok(value, name) {
  if (value) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const issue283Source = [
  '我眼神都懒得搭理他',
  '继续向前跑',
  '老公',
  '你跟他说什么话啊',
  '你看看他都干了些什么',
  '地上躺了这么多',
  '好多好多人',
  '我们要报警把他抓起来',
  '闭嘴',
  '快跟上',
];

const issue283Translations = {
  1: "I can't even be bothered to look at him.",
  2: 'Keep running forward.',
  3: 'Honey.',
  4: 'Why are you talking to him?',
  5: "Look at what he's done.",
  6: 'There are so many lying on the ground.',
  7: 'So many people.',
  8: 'We need to call the police and have him arrested.',
  9: 'Shut up.',
  10: 'Hurry and keep up.',
};

function makeSubtitles(texts) {
  return texts.map((content, index) => ({
    id: String(index + 1),
    startEndTime: `00:00:${String(index).padStart(2, '0')},000 --> 00:00:${String(index + 1).padStart(2, '0')},000`,
    content: [content],
  }));
}

function sourceResponse(subtitles) {
  return JSON.stringify(
    Object.fromEntries(
      subtitles.map((subtitle) => [subtitle.id, subtitle.content.join('\n')]),
    ),
  );
}

function translatedResponse(subtitles) {
  return JSON.stringify(
    Object.fromEntries(
      subtitles.map((subtitle) => [
        subtitle.id,
        issue283Translations[subtitle.id],
      ]),
    ),
  );
}

function provider() {
  return {
    id: 'offline-ai',
    name: 'offline injected AI',
    type: 'openai',
    isAi: true,
    prompt: '${content}',
    systemPrompt: 'Translate ${sourceLanguage} to ${targetLanguage}.',
    echoAnchoring: true,
    batchConcurrency: 1,
    requestInterval: 0,
  };
}

function config(translator, sourceLanguage = 'zh', targetLanguage = 'en') {
  return {
    provider: provider(),
    sourceLanguage,
    targetLanguage,
    translator,
    glossaryEntries: [],
  };
}

function requiredIds(options) {
  const required = options?.responseJsonSchema?.required;
  if (!Array.isArray(required)) {
    throw new Error('translator call missing dynamic schema.required');
  }
  return required.map(String);
}

async function testIssue283FullRepairFlow() {
  capturedLogs.length = 0;
  const subtitles = makeSubtitles(issue283Source);
  let batchCalls = 0;
  let repairCalls = 0;

  const translator = async (_text, _config, _from, _to, options) => {
    const ids = requiredIds(options);
    if (ids.length > 1) {
      batchCalls++;
      return sourceResponse(subtitles);
    }

    repairCalls++;
    const id = ids[0];
    return JSON.stringify({ [id]: issue283Translations[id] });
  };

  const results = await handleAIBatchTranslation(
    subtitles,
    config(translator),
    10,
    undefined,
    undefined,
    0,
  );

  ok(batchCalls === 2, 'issue #283 copied batch is retried exactly once');
  ok(
    repairCalls === 10,
    'issue #283 retry still copied routes every entry to targeted repair',
  );
  ok(
    results.every(
      (result) => result.targetContent === issue283Translations[result.id],
    ),
    'targeted repairs replace all ten copied outputs',
  );
  ok(
    capturedLogs.some((entry) => entry.message.includes('整批重试一次')),
    'real batch loop records the whole-batch retry',
  );
}

async function testFourOfTenRetryBoundary() {
  capturedLogs.length = 0;
  const subtitles = makeSubtitles(issue283Source);
  let batchCalls = 0;
  let repairCalls = 0;

  const translator = async (_text, _config, _from, _to, options) => {
    const ids = requiredIds(options);
    if (ids.length === 1) {
      repairCalls++;
      return JSON.stringify({ [ids[0]]: issue283Translations[ids[0]] });
    }

    batchCalls++;
    if (batchCalls === 1) {
      return JSON.stringify(
        Object.fromEntries(
          subtitles.map((subtitle, index) => [
            subtitle.id,
            index < 4 ? subtitle.content[0] : issue283Translations[subtitle.id],
          ]),
        ),
      );
    }
    return translatedResponse(subtitles);
  };

  const results = await handleAIBatchTranslation(
    subtitles,
    config(translator),
    10,
    undefined,
    undefined,
    0,
  );

  ok(batchCalls === 2, '4/10 flagged entries trigger the >1/3 batch retry');
  ok(repairCalls === 0, 'successful whole-batch retry avoids targeted repairs');
  ok(
    results.every(
      (result) => result.targetContent === issue283Translations[result.id],
    ),
    '4/10 boundary retry returns the corrected batch',
  );
}

async function testRepairAttemptCap() {
  capturedLogs.length = 0;
  const subtitles = makeSubtitles(issue283Source.slice(0, 4));
  let batchCalls = 0;
  let repairCalls = 0;

  const translator = async (_text, _config, _from, _to, options) => {
    const ids = requiredIds(options);
    if (ids.length > 1) {
      batchCalls++;
      return JSON.stringify({
        1: subtitles[0].content[0],
        2: issue283Translations[2],
        3: issue283Translations[3],
        4: issue283Translations[4],
      });
    }

    repairCalls++;
    return JSON.stringify({ 1: subtitles[0].content[0] });
  };

  const results = await handleAIBatchTranslation(
    subtitles,
    config(translator),
    4,
    undefined,
    undefined,
    0,
  );

  ok(batchCalls === 1, 'one copied entry in four skips whole-batch retry');
  ok(repairCalls === 3, 'copied repair output stops at the three-attempt cap');
  ok(
    results[0].targetContent.startsWith('[翻译失败:') &&
      results
        .slice(1)
        .every(
          (result) => result.targetContent === issue283Translations[result.id],
        ),
    'repair exhaustion fails only the copied entry',
  );
}

async function testPromotedExactCopyFallsBackToOriginal() {
  capturedLogs.length = 0;
  const subtitles = makeSubtitles([
    'Please keep moving forward',
    'We need to leave right now',
    'This problem is very important',
    'OpenAI',
  ]);
  const repairedTranslations = {
    1: '请继续向前走',
    2: '我们现在得离开',
    3: '这个问题非常重要',
    4: 'OpenAI',
  };
  let batchCalls = 0;
  const repairCallsById = {};

  const translator = async (_text, _config, _from, _to, options) => {
    const ids = requiredIds(options);
    if (ids.length > 1) {
      batchCalls++;
      return sourceResponse(subtitles);
    }

    const id = ids[0];
    repairCallsById[id] = (repairCallsById[id] || 0) + 1;
    return JSON.stringify({ [id]: repairedTranslations[id] });
  };

  const results = await handleAIBatchTranslation(
    subtitles,
    config(translator, 'en', 'zh'),
    4,
    undefined,
    undefined,
    0,
  );

  ok(batchCalls === 2, 'promoted-copy batch is retried exactly once');
  ok(
    repairCallsById['1'] === 1 &&
      repairCallsById['2'] === 1 &&
      repairCallsById['3'] === 1 &&
      repairCallsById['4'] === 3,
    'promoted proper name exhausts repair while strong copies repair once',
  );
  ok(
    results[3].targetContent === 'OpenAI' &&
      results
        .slice(0, 3)
        .every(
          (result) => result.targetContent === repairedTranslations[result.id],
        ),
    'repair exhaustion preserves the original weak-evidence output',
  );
}

async function testAutoSourceLanguageStillDetectsCopies() {
  capturedLogs.length = 0;
  const subtitles = makeSubtitles(issue283Source.slice(0, 4));
  let batchCalls = 0;
  let repairCalls = 0;

  const translator = async (_text, _config, _from, _to, options) => {
    const ids = requiredIds(options);
    if (ids.length > 1) {
      batchCalls++;
      return JSON.stringify({
        1: subtitles[0].content[0],
        2: issue283Translations[2],
        3: issue283Translations[3],
        4: issue283Translations[4],
      });
    }

    repairCalls++;
    return JSON.stringify({ 1: issue283Translations[1] });
  };

  const results = await handleAIBatchTranslation(
    subtitles,
    config(translator, 'auto', 'en'),
    4,
    undefined,
    undefined,
    0,
  );

  ok(batchCalls === 1, 'auto source uses the original batch response');
  ok(repairCalls === 1, 'auto source routes the copied entry to repair');
  ok(
    results.every(
      (result) => result.targetContent === issue283Translations[result.id],
    ),
    'auto source detection replaces the copied output without affecting peers',
  );
}

async function testSameScriptWeakEvidenceStaysAccepted() {
  const scenarios = [
    {
      name: 'Spanish to Portuguese near-copy',
      sourceLanguage: 'es',
      targetLanguage: 'pt',
      source: 'Este problema es importante',
      translation: 'Este problema é importante',
    },
    {
      name: 'Croatian to Serbian legal same-text output',
      sourceLanguage: 'hr',
      targetLanguage: 'sr',
      source: 'Ovo je veoma važno pitanje',
      translation: 'Ovo je veoma važno pitanje',
    },
  ];

  for (const scenario of scenarios) {
    let calls = 0;
    const subtitles = makeSubtitles([scenario.source]);
    const translator = async () => {
      calls++;
      return JSON.stringify({ 1: scenario.translation });
    };
    const results = await handleAIBatchTranslation(
      subtitles,
      config(translator, scenario.sourceLanguage, scenario.targetLanguage),
      1,
      undefined,
      undefined,
      0,
    );

    ok(
      calls === 1 && results[0].targetContent === scenario.translation,
      `${scenario.name} remains accepted without repair`,
    );
  }
}

async function main() {
  console.log('offline: real handleAIBatchTranslation flow');
  try {
    await testIssue283FullRepairFlow();
    await testFourOfTenRetryBoundary();
    await testRepairAttemptCap();
    await testPromotedExactCopyFallsBackToOriginal();
    await testAutoSourceLanguageStillDetectsCopies();
    await testSameScriptWeakEvidenceStaysAccepted();
  } finally {
    Module._load = originalLoad;
    if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
    else delete require.extensions['.ts'];
  }

  console.log(`\nuntranslated flow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
