// Exercise the production import/start handlers without Electron or network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
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
};
const recipes = require('../renderer/lib/recipes.ts');
const { getTaskTypeBySlug } = require('../renderer/lib/taskTypes.ts');
const { isSubtitleFile } = require('../renderer/lib/utils.ts');
const { isManuscriptPath } = require('../renderer/lib/filePairing.ts');
const {
  validateRefineProviderConfig,
  getRefineValidationErrorMessage,
} = require('../renderer/lib/subtitleRefineValidation.ts');
const {
  getFileStages,
  isFileDone,
} = require('../renderer/components/tasks/stageUtils.ts');
if (originalTs) require.extensions['.ts'] = originalTs;
else delete require.extensions['.ts'];

function loadHandlers(filename, names) {
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(path.join(root, filename), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fragments = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(source);
      if (names.includes(name)) {
        const initializer = node.initializer;
        const handler =
          ts.isCallExpression(initializer) &&
          initializer.expression.getText(source) === 'useCallback'
            ? initializer.arguments[0]
            : initializer;
        fragments.set(name, `const ${name} = ${handler.getText(source)};`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(fragments.size, names.length, `Load handlers from ${filename}`);
  return ts.transpileModule([...fragments.values()].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

const homeCode = loadHandlers('renderer/pages/[locale]/home.tsx', [
  'collectDropPaths',
  'resolveDroppedBothKinds',
  'resetDrag',
  'importPaths',
  'importFiles',
  'handleGlobalDrop',
  'handleRecipeDrop',
]);
const startCode = loadHandlers('renderer/components/TaskControls.tsx', [
  'handleTask',
]);
const retryCode = loadHandlers('renderer/pages/[locale]/tasks/[type].tsx', [
  'handleRetryFiles',
]);

function simulate({ hasModels = true, hasProvider = true } = {}) {
  const calls = [];
  const errors = [];
  const routes = [];
  const drafts = [];
  const dispatched = [];
  const t = (key) => key;
  const context = vm.createContext({
    ...recipes,
    getTaskTypeBySlug,
    isSubtitleFile,
    isManuscriptPath,
    validateRefineProviderConfig,
    getRefineValidationErrorMessage,
    getFileStages,
    isFileDone,
    canStartParakeetTask: async () => true,
    console,
    t,
    toast: Object.assign(() => {}, {
      error: (message) => errors.push(message),
    }),
    router: { push: async (route) => routes.push(route) },
    locale: 'zh',
    localeStr: 'zh',
    readiness: { hasModels, hasProvider, ttsReady: true },
    importBusyRef: { current: false },
    dragCounterRef: { current: 0 },
    startingRef: { current: false },
    retryingRef: { current: false },
    setGlobalDragging() {},
    setDragCard() {},
    setImporting() {},
    setStagedDraftFiles() {},
    setQuickDownloadOpen() {},
    setStarting() {},
    setTaskStatus() {},
    taskDraftManager: { patchDraft: (draft) => drafts.push(draft) },
    sessionStorage: { setItem() {} },
    uuidv4: () => 'test-project',
    window: {
      ipc: {
        getPathForFile: (file) => file.path,
        invoke: async (channel, options) => {
          calls.push({ channel, options });
          if (channel !== 'getDroppedFiles') return [];
          const filters = {
            media: /\.(wav|mp4)$/i,
            translate: /\.(srt|vtt|ass|ssa|lrc)$/i,
            manuscript: /\.(txt|md|markdown)$/i,
            'media-and-manuscript': /\.(wav|mp4|txt|md|markdown)$/i,
          };
          const paths = options.files.flatMap((file) =>
            file === '/mixed-folder'
              ? ['/clip.wav', '/clip.SRT', '/clip.md']
              : [file],
          );
          return paths
            .filter((file) => filters[options.taskType].test(file))
            .map((filePath) => ({ filePath }));
        },
        send: (channel, payload) => dispatched.push({ channel, payload }),
      },
    },
    projectId: 'test-project',
    cachedProviders: [],
    onOpenRefine: undefined,
    dispatchTask: (files) => dispatched.push(files),
  });
  vm.runInContext(homeCode + startCode + retryCode, context);
  return { context, calls, errors, routes, drafts, dispatched };
}

function drop(paths) {
  return {
    dataTransfer: { types: ['Files'], files: paths.map((path) => ({ path })) },
    stopped: false,
    preventDefault() {},
    stopPropagation() {
      this.stopped = true;
    },
  };
}

async function dropOnRecipe(state, id, paths) {
  state.context.recipe = recipes.BUILTIN_RECIPES.find(
    (recipe) => recipe.id === id,
  );
  state.context.drop = drop(paths);
  await vm.runInContext('handleRecipeDrop(drop, recipe)', state.context);
  assert.equal(state.context.drop.stopped, true, 'Card drops stop bubbling');
  assert.equal(
    state.context.importBusyRef.current,
    false,
    'Import lock released',
  );
}

function taskContext(state, slug, files) {
  Object.assign(state.context, {
    typeDef: getTaskTypeBySlug(slug),
    files: files.map((filePath) => ({ filePath })),
    formData: {
      taskType: getTaskTypeBySlug(slug).taskType,
      model: 'base',
      translateProvider: 'google',
      aiCorrection: true,
      refineProvider: 'deleted-provider',
    },
  });
  state.context.listFormData = state.context.formData;
}

async function main() {
  let passed = 0;
  async function check(name, run) {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  }

  for (const hasProvider of [true, false]) {
    await check(
      `Subtitle card rejects WAV before setup (provider: ${hasProvider})`,
      async () => {
        const state = simulate({ hasProvider });
        await dropOnRecipe(state, 'builtin-translate', ['/clip.wav']);
        assert.deepEqual(state.errors, ['globalDrop.subtitleRequired']);
        assert.equal(state.routes.length, 0);
        assert.equal(state.drafts.length, 0);
        assert.equal(
          state.calls.some((call) => call.channel === 'saveTaskProject'),
          false,
        );
      },
    );
  }

  await check(
    'Mixed folder imports only subtitles into translation project',
    async () => {
      const state = simulate();
      await dropOnRecipe(state, 'builtin-translate', ['/mixed-folder']);
      const project = state.calls.find(
        (call) => call.channel === 'saveTaskProject',
      ).options;
      assert.equal(project.taskType, 'translateOnly');
      assert.equal(project.files.length, 1);
      assert.equal(project.files[0].filePath, '/clip.SRT');
      assert.deepEqual(state.routes, [
        '/zh/tasks/translate?project=test-project',
      ]);
    },
  );

  await check(
    'Transcription card filters subtitles and preserves reference scripts',
    async () => {
      const state = simulate();
      await dropOnRecipe(state, 'builtin-generate', ['/mixed-folder']);
      const files = state.calls.find(
        (call) => call.channel === 'saveTaskProject',
      ).options.files;
      assert.equal(files.length, 2);
      assert.equal(files[0].filePath, '/clip.wav');
      assert.equal(files[1].filePath, '/clip.md');
    },
  );

  await check('Global import keeps WAV and opens the wizard', async () => {
    const state = simulate();
    await vm.runInContext('importFiles(["/clip.wav"])', state.context);
    assert.equal(state.drafts[0].files[0].filePath, '/clip.wav');
    assert.deepEqual(state.routes, ['/zh/tasks/new']);
  });

  await check(
    'Full workflow preserves mixed media and subtitle pairing',
    async () => {
      const state = simulate();
      await dropOnRecipe(state, 'builtin-pipeline', ['/mixed-folder']);
      assert.equal(state.drafts[0].files.length, 3);
      assert.deepEqual(state.routes, ['/zh/tasks/new?recipe=builtin-pipeline']);
    },
  );

  for (const handler of ['handleTask()', 'handleRetryFiles(files)']) {
    await check(
      `${handler} rejects previously imported WAV before AI refine checks`,
      async () => {
        const state = simulate();
        taskContext(state, 'translate', ['/clip.wav']);
        await vm.runInContext(handler, state.context);
        assert.equal(state.errors.length, 1);
        assert.match(state.errors[0], /subtitleFilesRequired$/);
        assert.equal(state.dispatched.length, 0);
      },
    );
  }

  await check(
    'Uppercase SRT translation ignores stale transcription refine settings',
    async () => {
      const state = simulate();
      taskContext(state, 'translate', ['/clip.SRT']);
      await vm.runInContext('handleTask()', state.context);
      assert.deepEqual(state.errors, []);
      assert.equal(state.dispatched.length, 1);
    },
  );

  await check(
    'Actual WAV transcription still blocks an unavailable AI refine provider',
    async () => {
      const state = simulate();
      taskContext(state, 'generate', ['/clip.wav']);
      await vm.runInContext('handleTask()', state.context);
      assert.deepEqual(state.errors, [
        'tasks:wizard.blockRefineProviderInvalid',
      ]);
      assert.equal(state.dispatched.length, 0);
    },
  );

  console.log(`Launchpad import regression: ${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
