const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const handlers = new Map();
const provider = {
  id: 'fixture',
  isAi: true,
  type: 'openai',
  name: 'Fixture',
  modelName: 'test',
};
let translate = async () => 'Edited';
let retranslate = async () => {};
const glossaryScopes = [];
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  if (request.endsWith('/storeManager'))
    return {
      logMessage() {},
      store: {
        get: (key) =>
          key === 'translationProviders'
            ? [provider]
            : {
                translateProvider: provider.id,
                sourceLanguage: 'en',
                targetLanguage: 'zh',
              },
      },
    };
  if (request.endsWith('/glossaryManager'))
    return {
      getActiveGlossaryResolution: (projectId) => {
        glossaryScopes.push(projectId);
        return { entries: [], conflicts: [] };
      },
      logGlossaryConflicts() {},
      logGlossaryMatches() {},
    };
  if (
    parent?.filename.endsWith('/ipcProofreadHandlers.ts') &&
    [
      './subtitleDetector',
      './proofreadStore',
      './languageDetector',
      './providerMigration',
      './proofreadWaveform',
    ].includes(request)
  )
    return request === './providerMigration'
      ? { resolveProviderFallbacks: () => [] }
      : {};
  if (request.endsWith('/translationProvider'))
    return {
      TRANSLATOR_MAP: { openai: (...args) => translate(...args) },
      translateWithProvider: (...args) => retranslate(...args),
    };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  setupProofreadHandlers,
} = require('../main/helpers/ipcProofreadHandlers.ts');
setupProofreadHandlers();
function event(id) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  return { sender };
}
const first = event(1);
const second = event(2);
const single = (evt, extra = {}) =>
  handlers.get('optimizeSubtitle')(evt, {
    sourceText: 'Original',
    targetText: '',
    providerId: provider.id,
    batchId: 'request',
    mode: 'transcript',
    sourceLanguage: 'ja',
    targetLanguage: 'fr',
    ...extra,
  });
async function main() {
  let args;
  translate = async (...input) => {
    args = input;
    return 'Corrected';
  };
  assert.equal((await single(first)).data, 'Corrected');
  assert.equal(args[2], 'ja');
  assert.equal(args[3], 'fr');
  assert.match(args[0], /Do not translate/);
  assert.equal(first.sender.listenerCount('destroyed'), 0);
  await single(first, { intent: 'shorten' });
  assert.match(args[1].systemPrompt, /Shorten subtitle text/);
  assert.match(args[1].systemPrompt, /Preserve names, facts, meaning/);
  await single(first, {
    sourceText: '$& {{targetText}}',
    targetText: 'Literal',
    customPrompt: '{{sourceText}} | {{targetText}}',
  });
  assert.equal(
    args[0],
    '$& {{targetText}} | Literal',
    'subtitle text is never interpreted as a replacement template',
  );
  translate = async () => '""';
  assert.equal((await single(first)).success, false);
  let release;
  translate = (...input) => {
    args = input;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const running = single(first);
  assert.equal(
    (await handlers.get('cancelProofreadBatch')(second, { batchId: 'request' }))
      .success,
    false,
  );
  assert.equal(args[4].signal.aborted, false);
  assert.equal(
    (await handlers.get('cancelProofreadBatch')(first, { batchId: 'request' }))
      .success,
    true,
  );
  assert.equal(args[4].signal.aborted, true);
  release('Too late');
  assert.equal((await running).cancelled, true);
  const destroying = single(first);
  first.sender.emit('destroyed');
  assert.equal(args[4].signal.aborted, true);
  release('Closed');
  await destroying;
  assert.equal(first.sender.listenerCount('destroyed'), 0);
  const batch = (extra = {}) =>
    handlers.get('batchOptimizeSubtitles')(second, {
      providerId: provider.id,
      batchId: 'batch',
      sourceLanguage: 'ja',
      targetLanguage: 'fr',
      subtitles: [
        { id: '1', index: 0, sourceContent: 'One', targetContent: 'Un' },
        { id: '2', index: 1, sourceContent: 'Two', targetContent: 'Deux' },
      ],
      batchSize: 1,
      maxRetries: 0,
      ...extra,
    });
  let count = 0;
  translate = async (...input) => {
    assert.equal(input[2], 'ja');
    assert.equal(input[3], 'fr');
    if (++count === 2)
      assert.ok(
        second.sender.sent.some(
          (entry) =>
            entry.channel === 'batchOptimizeResult' &&
            entry.value.batchId === 'batch' &&
            entry.value.index === 0,
        ),
      );
    return JSON.stringify({ [count]: `Edited ${count}` });
  };
  const result = await batch();
  assert.equal(result.data.results.length, 2);
  assert.equal(
    result.data.results.every((row) => row.status === 'success'),
    true,
  );
  translate = async (prompt) => {
    assert.match(prompt, /Do not translate/);
    return '{"1":"One","2":"Two"}';
  };
  assert.equal(
    (await batch({ mode: 'transcript', batchSize: 2 })).data.results.every(
      (row) => row.status === 'success',
    ),
    true,
  );
  assert.equal(
    second.sender.sent
      .filter((entry) => entry.channel === 'batchOptimizeProgress')
      .every((entry) => entry.value.batchId === 'batch'),
    true,
  );
  for (const malformed of [
    '{"1":null,"2":12}',
    '{"1":{},"2":false}',
    '{"1":" ","2":[]}',
  ]) {
    translate = async () => malformed;
    const invalid = await batch({ batchSize: 2 });
    assert.equal(
      invalid.data.results.every((row) => row.status === 'skipped'),
      true,
    );
    assert.deepEqual(
      invalid.data.results.map((row) => row.optimizedTarget),
      ['Un', 'Deux'],
    );
  }
  translate = async () => '[]';
  assert.equal(
    (await batch()).data.results.every((row) => row.status === 'error'),
    true,
  );
  for (const batchSize of [0, -1, 2.5, NaN, Infinity, 51])
    assert.equal((await batch({ batchSize })).success, false);
  assert.equal(second.sender.listenerCount('destroyed'), 0);
  translate = async () => 'Scoped';
  await single(second, { mode: 'translation', projectId: 'project-a' });
  assert.equal(glossaryScopes.at(-1), 'project-a');
  translate = async () => '{"1":"One","2":"Two"}';
  await batch({ projectId: 'project-b' });
  assert.equal(glossaryScopes.at(-1), 'project-b');
  const {
    getTaskContext,
    throwIfTaskCancelled,
  } = require('../main/helpers/taskContext.ts');
  let retranslateContext;
  let retranslateRelease;
  retranslate = async () => {
    retranslateContext = getTaskContext();
    await new Promise((resolve) => {
      retranslateRelease = resolve;
    });
    throwIfTaskCancelled();
  };
  const retranslating = handlers.get('retranslateSubtitles')(second, {
    subtitles: [],
    projectId: 'project-a',
    batchId: 'retranslate',
  });
  assert.equal(retranslateContext.projectId, 'project-a');
  second.sender.destroyed = true;
  second.sender.emit('destroyed');
  assert.equal(retranslateContext.signal.aborted, true);
  retranslateRelease();
  assert.equal((await retranslating).cancelled, true);
  assert.equal(second.sender.listenerCount('destroyed'), 0);
  console.log(
    'Inline AI backend: explicit languages, literal template data, ownership, abort, cleanup, streamed results, malformed responses and batch bounds passed.',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  });
