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
  // What the user picked on the task page, i.e. what 3.9 used to forget.
  const started = {
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

  const first = harness({ sourceLanguage: 'en', leftover: 'from-last-time' });
  assert.ok(
    first.registered('rememberTaskDefaults'),
    'the task page remembers defaults through the rememberTaskDefaults channel',
  );
  assert.deepEqual(
    await first.call('rememberTaskDefaults', { ...started, ...perTask }),
    { success: true },
    'the save is acknowledged',
  );
  assert.deepEqual(
    first.stored(),
    started,
    'the started task replaces the stored defaults; per-task inputs never persist',
  );
  const next = await first.call('getUserConfig');
  for (const [key, value] of Object.entries(started))
    assert.deepEqual(
      next[key],
      value,
      `the next new task is seeded with ${key}`,
    );
  assert.equal(next.maxConcurrentTasks, 1, 'untouched factory defaults remain');
  assert.equal(next.leftover, undefined, 'cleared settings do not linger');

  for (const bad of [undefined, null, [], 'x', {}, perTask]) {
    await assert.rejects(
      first.call('rememberTaskDefaults', bad),
      /INVALID_TASK_DEFAULTS/,
      `refuses ${JSON.stringify(bad)}`,
    );
    assert.deepEqual(first.stored(), started, 'a refused call never wipes');
  }

  first.failWrites(true);
  await assert.rejects(
    first.call('rememberTaskDefaults', { sourceLanguage: 'fr' }),
    /ENOSPC/,
    'a failed disk write is reported, not swallowed',
  );
  first.failWrites(false);
  assert.deepEqual(
    first.stored(),
    started,
    'a failed write keeps the old defaults',
  );

  console.log(
    'Task defaults: started tasks become the next defaults; per-task inputs, empty and failed saves never touch them.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
