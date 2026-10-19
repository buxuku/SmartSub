const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const handlersFile = path.join(root, 'main/helpers/ipcStoreHandlers.ts');

/**
 * Loads the real store handlers (and the real shared task-config rules) against an
 * in-memory store. Everything else the handler module imports is replaced by an
 * empty module: none of it runs while registering or while serving userConfig.
 */
function harness(initialUserConfig) {
  let disk = { userConfig: initialUserConfig, settings: { gpuMode: 'auto' } };
  let writeFailure = false;
  const handlers = new Map();
  const store = {
    get: (key) => structuredClone(disk[key]),
    set(key, value) {
      if (writeFailure) throw new Error('ENOSPC');
      disk = { ...disk, [key]: structuredClone(value) };
    },
  };
  const at = (relative) => path.resolve(root, relative);
  const stubs = new Map([
    [
      at('main/automation/handlers'),
      {
        ipcMain: {
          handle: (name, handler) => handlers.set(name, handler),
          on: (name, handler) => handlers.set(name, handler),
        },
      },
    ],
    [at('main/helpers/store'), { store }],
    [
      at('main/helpers/utils'),
      {
        defaultUserConfig: {
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          translateProvider: 'autoFree',
          maxConcurrentTasks: 1,
        },
        supportedLanguage: [],
      },
    ],
    [
      at('main/helpers/engines/outcomePresets'),
      { inferDisplayOutcome: () => 'balanced' },
    ],
    [
      at('main/helpers/providerManager'),
      { getAndInitializeProviders: async () => [] },
    ],
    [at('main/helpers/buildInfo'), { getBuildInfo: () => ({}) }],
    [at('main/helpers/logger'), { logMessage() {} }],
    [
      at('main/helpers/storagePaths'),
      { isFactoryDefaultGgmlPath: () => false },
    ],
  ]);
  const cache = new Map();
  function load(filename) {
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
        console: { log() {}, error: console.error },
        require(request) {
          if (request === 'electron')
            return {
              app: { getVersion: () => 'test', getPath: () => '/userData' },
            };
          if (!request.startsWith('.')) return require(request);
          const resolved = path.resolve(path.dirname(filename), request);
          if (stubs.has(resolved)) return stubs.get(resolved);
          // Shared rules under types/ are the contract under test: load them for real.
          if (resolved.startsWith(path.join(root, 'types') + path.sep))
            return load(`${resolved}.ts`);
          return {};
        },
      },
      { filename },
    );
    return module.exports;
  }
  load(handlersFile).setupStoreHandlers();
  return {
    registered: (channel) => handlers.has(channel),
    // The handlers run in their own vm realm; bring results back so deepStrictEqual
    // is not defeated by a foreign Object.prototype.
    call: async (channel, payload) =>
      structuredClone(await handlers.get(channel)({}, payload)),
    stored: () => structuredClone(disk.userConfig),
    failWrites: (value) => {
      writeFailure = value;
    },
  };
}

async function main() {
  // What the user changes on the task page, i.e. what 3.9 used to forget.
  const changed = {
    sourceLanguage: 'ja',
    targetLanguage: 'zh',
    translateProvider: 'deepseek',
    subtitleOutcome: 'custom',
    useEmbeddedSubtitles: false,
    speakerDiarization: true,
    speakerDiarizationCount: 3,
    maxContext: 6,
    subtitleOutputFormats: ['srt', 'vtt'],
    customParameters: { temperature: 0.2, nested: { flag: true } },
  };
  // Inputs of one single task, never preferences.
  const perTask = {
    taskType: 'generateOnly',
    manuscriptPath: '/media/script.txt',
    manuscriptName: 'script.txt',
    dub: { engine: 'edge' },
    compose: { burn: true },
    gates: { subtitle: 'manual' },
    cloudUploadConsent: true,
  };

  const first = harness({
    sourceLanguage: 'en',
    maxConcurrentTasks: 4,
    leftover: 'from-last-time',
    manuscriptPath: '/old/script.txt',
  });
  assert.ok(
    first.registered('updateTaskDefaults'),
    'the task page syncs defaults through the updateTaskDefaults channel',
  );
  assert.ok(
    !first.registered('rememberTaskDefaults'),
    'the start-time channel is gone: edits are the only way defaults change',
  );
  assert.ok(
    first.registered('setUserConfig'),
    'the legacy full-replace channel stays for existing integrations',
  );

  assert.deepEqual(
    await first.call('updateTaskDefaults', { ...changed, ...perTask }),
    { success: true },
    'the sync is acknowledged',
  );
  let expected = {
    maxConcurrentTasks: 4,
    leftover: 'from-last-time',
    ...changed,
  };
  assert.deepEqual(
    first.stored(),
    expected,
    'the patch merges into the stored defaults; settings it does not mention stay; per-task inputs and old manuscripts never persist',
  );

  await first.call('updateTaskDefaults', { maxContext: 9 });
  expected = { ...expected, maxContext: 9 };
  assert.deepEqual(
    first.stored(),
    expected,
    'a patch with one key changes that key and nothing else',
  );

  await first.call('updateTaskDefaults', { leftover: undefined });
  const { leftover: _leftover, ...withoutLeftover } = expected;
  expected = withoutLeftover;
  assert.deepEqual(
    first.stored(),
    expected,
    'an undefined value removes the stored key',
  );

  const next = await first.call('getUserConfig');
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(
      next[key],
      value,
      `the next new task is seeded with ${key}`,
    );
  assert.equal(next.maxConcurrentTasks, 4, 'the saved value beats the factory');
  assert.equal(next.leftover, undefined, 'cleared settings do not linger');
  assert.equal(next.taskType, undefined, 'task type is per task');

  assert.deepEqual(
    await first.call('updateTaskDefaults', perTask),
    { success: true },
    'a patch of per-task inputs alone is a harmless no-op',
  );
  assert.deepEqual(first.stored(), expected, 'per-task inputs change nothing');

  for (const bad of [undefined, null, [], 'x', 5]) {
    await assert.rejects(
      first.call('updateTaskDefaults', bad),
      /INVALID_TASK_DEFAULTS/,
      `refuses ${JSON.stringify(bad)}`,
    );
    assert.deepEqual(first.stored(), expected, 'a refused call never rewrites');
  }

  first.failWrites(true);
  await assert.rejects(
    first.call('updateTaskDefaults', { sourceLanguage: 'fr' }),
    /ENOSPC/,
    'a failed disk write is reported, not swallowed',
  );
  first.failWrites(false);
  assert.deepEqual(
    first.stored(),
    expected,
    'a failed write keeps the old defaults',
  );

  const fresh = harness({});
  await fresh.call('updateTaskDefaults', { maxContext: 6, ...perTask });
  assert.deepEqual(
    fresh.stored(),
    { maxContext: 6 },
    'the store keeps only what the user set, never a frozen copy of the factory defaults',
  );
  const seeded = await fresh.call('getUserConfig');
  assert.equal(seeded.maxContext, 6);
  assert.equal(
    seeded.maxConcurrentTasks,
    1,
    'untouched factory defaults remain',
  );

  const corrupt = harness('not-an-object');
  await corrupt.call('updateTaskDefaults', { maxContext: 6, ...perTask });
  assert.deepEqual(
    corrupt.stored(),
    { maxContext: 6 },
    'an unusable stored config is rebuilt from the patch',
  );

  console.log(
    'Task defaults: task-page edits patch the stored defaults; per-task inputs, invalid payloads and failed writes never corrupt them.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
