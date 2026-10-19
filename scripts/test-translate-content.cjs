/**
 * Offline checks for how the output style (translateContent) reaches a delivered
 * subtitle file.
 *
 * The real translate() runs against a temp directory. Only Electron, the logger/store
 * and the translation provider network call are replaced, so the files asserted here
 * are what a user would get.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const originalLoad = Module._load;
const logs = [];
const unhandled = [];
const state = { tempDir: '', providerCalls: 0, failConversion: false };

// A swallowed async error would otherwise surface here instead of failing the call.
process.on('unhandledRejection', (error) => unhandled.push(error));

function fakeTranslateWithProvider(
  _provider,
  subtitles,
  _sourceLanguage,
  _targetLanguage,
  _translator,
  _onProgress,
  onTranslationResult,
) {
  state.providerCalls++;
  const results = subtitles.map((subtitle) => ({
    id: subtitle.id,
    startEndTime: subtitle.startEndTime,
    sourceContent: subtitle.content.join('\n'),
    targetContent: `FR(${subtitle.content.join(' ')})`,
    translationStatus: 'success',
  }));
  // The real provider awaits the callback, so a failure in it must come back here.
  return Promise.resolve(onTranslationResult(results)).then(() => results);
}

Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request).replace(/\\/g, '/');
  if (request === 'electron')
    return {
      app: {
        getAppPath: () => repoRoot,
        getPath: () => os.tmpdir(),
        isPackaged: false,
      },
    };
  if (normalized.endsWith('/helpers/storeManager'))
    return {
      logMessage: (message, type = 'info') =>
        logs.push({ message: String(message), type }),
      store: { get: () => ({}) },
    };
  if (normalized.endsWith('/helpers/fileUtils'))
    return { ensureTempDir: () => state.tempDir };
  if (normalized.endsWith('/services/translationProvider'))
    return {
      TRANSLATOR_MAP: { test: {} },
      translateWithProvider: fakeTranslateWithProvider,
    };
  if (normalized.endsWith('/helpers/chineseConvert')) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      convertChineseText: (...args) => {
        if (state.failConversion) throw new Error('conversion exploded');
        return real.convertChineseText(...args);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};

const translate = require('../main/translate/index.ts').default;
const { resolvePipelineForm } = require('../main/automation/pipelineConfig.ts');

const base = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-translate-content-'),
);
const sourceSrt =
  '1\n00:00:01,123 --> 00:00:03,456\nHello\nsecond line\n\n2\n00:00:05,000 --> 00:00:06,000\nWorld\n\n';
const cues = [
  {
    id: '1',
    time: '00:00:01,123 --> 00:00:03,456',
    source: 'Hello\nsecond line',
    target: 'FR(Hello second line)',
  },
  {
    id: '2',
    time: '00:00:05,000 --> 00:00:06,000',
    source: 'World',
    target: 'FR(World)',
  },
];
const layouts = {
  onlyTranslate: (cue) => `${cue.target}\n\n`,
  sourceAndTranslate: (cue) => `${cue.source}\n${cue.target}\n\n`,
  translateAndSource: (cue) => `${cue.target}\n${cue.source}\n\n`,
};
const expected = (style) =>
  cues.map((cue) => `${cue.id}\n${cue.time}\n${layouts[style](cue)}`).join('');
const translationOnly = expected('onlyTranslate');
const read = (file) => fs.readFileSync(file, 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

let scenario = 0;
let checks = 0;
const failures = [];
/** Keeps going after a failure so one run lists every broken scenario. */
function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(
      () => {
        checks++;
        console.log(`PASS ${name}`);
      },
      (error) => {
        failures.push(name);
        console.error(
          `FAIL ${name}\n  ${String(error.message).split('\n').slice(0, 9).join('\n  ')}`,
        );
      },
    );
}

/** Runs the real translate() for one subtitle in its own directory. */
async function translateIn(overrides = {}, prepare) {
  const dir = fs.mkdtempSync(path.join(base, `case${++scenario}-`));
  state.tempDir = path.join(dir, 'cache');
  fs.mkdirSync(state.tempDir);
  const srtFile = path.join(dir, 'clip.srt');
  fs.writeFileSync(srtFile, sourceSrt);
  const file = {
    uuid: `file-${scenario}`,
    fileName: 'clip',
    directory: dir,
    srtFile,
    filePath: path.join(dir, 'clip.mp4'),
  };
  const formData = {
    taskType: 'translateOnly',
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    targetSrtSaveOption: 'fileNameWithLang',
    customTargetSrtFileName: '${fileName}.${targetLanguage}',
    translateProvider: 'test',
    ...overrides,
  };
  prepare?.({ dir, file, srtFile });
  const messages = [];
  const event = {
    sender: { send: (channel, payload) => messages.push({ channel, payload }) },
  };
  state.providerCalls = 0;
  logs.length = 0;
  const outcome = await translate(event, file, formData, {
    id: 'test',
    type: 'test',
    name: 'Test',
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  await settle();
  return { dir, file, srtFile, messages, outcome };
}

async function main() {
  for (const style of Object.keys(layouts))
    await check(`${style} lays out the delivered file as chosen`, async () => {
      const run = await translateIn({ translateContent: style });
      assert.equal(run.outcome.ok, true);
      assert.equal(read(run.file.translatedSrtFile), expected(style));
      assert.equal(
        read(run.file.tempTranslatedSrtFile),
        translationOnly,
        'the pure translation kept for later stages never carries source text',
      );
    });

  await check('a missing style delivers translation only', async () => {
    const run = await translateIn({});
    assert.equal(run.outcome.ok, true);
    assert.equal(read(run.file.translatedSrtFile), translationOnly);
    assert.equal(read(run.file.tempTranslatedSrtFile), translationOnly);
    assert.deepEqual(
      logs.filter((entry) => entry.type === 'warning'),
      [],
      'not choosing a style is normal and stays quiet',
    );
  });

  for (const unknown of ['both', 'sourceandtranslate'])
    await check(
      `an unknown style "${unknown}" delivers translation only and is logged`,
      async () => {
        const run = await translateIn({ translateContent: unknown });
        assert.equal(run.outcome.ok, true);
        assert.equal(read(run.file.translatedSrtFile), translationOnly);
        const warning = logs.find((entry) => entry.type === 'warning');
        assert.ok(warning, 'the unexpected value is visible in the log');
        assert.match(warning.message, new RegExp(unknown));
      },
    );

  await check(
    'a failure while writing results rejects instead of leaving an empty file',
    async () => {
      state.failConversion = true;
      try {
        const run = await translateIn({
          translateContent: 'onlyTranslate',
          targetLanguage: 'zh',
        });
        assert.equal(run.outcome.ok, false, 'the failed run is reported');
        assert.match(run.outcome.error.message, /conversion exploded/);
        assert.ok(
          run.messages.some(
            (entry) =>
              entry.channel === 'message' &&
              /conversion exploded/.test(String(entry.payload)),
          ),
          'the user is told why',
        );
        assert.deepEqual(unhandled, [], 'no rejection escapes unobserved');
      } finally {
        state.failConversion = false;
      }
    },
  );

  await check(
    'a target named like the source is refused before anything is written',
    async () => {
      const run = await translateIn({ targetSrtSaveOption: 'fileName' });
      assert.equal(run.outcome.ok, false);
      assert.match(
        run.outcome.error.message,
        /would overwrite the source subtitle/,
      );
      assert.equal(
        read(run.srtFile),
        sourceSrt,
        'the source subtitle survives',
      );
      assert.equal(state.providerCalls, 0, 'no translation is paid for first');
      assert.equal(run.file.tempTranslatedSrtFile, undefined);
    },
  );

  if (process.platform !== 'win32') {
    await check(
      'a symlink or hard link to the target is the same file',
      async () => {
        const viaSymlink = await translateIn(
          { targetSrtSaveOption: 'fileName' },
          ({ dir, file }) => {
            fs.symlinkSync('clip.srt', path.join(dir, 'link.srt'));
            file.srtFile = path.join(dir, 'link.srt');
          },
        );
        assert.match(
          viaSymlink.outcome.error?.message || '',
          /would overwrite the source subtitle/,
        );
        assert.equal(read(viaSymlink.srtFile), sourceSrt);
        assert.equal(viaSymlink.file.tempTranslatedSrtFile, undefined);

        const viaHardLink = await translateIn(
          { targetSrtSaveOption: 'fileName' },
          ({ dir, file, srtFile }) => {
            fs.linkSync(srtFile, path.join(dir, 'hard.srt'));
            file.srtFile = path.join(dir, 'hard.srt');
          },
        );
        assert.match(
          viaHardLink.outcome.error?.message || '',
          /would overwrite the source subtitle/,
        );
        assert.equal(read(viaHardLink.srtFile), sourceSrt);
        assert.equal(viaHardLink.file.tempTranslatedSrtFile, undefined);
      },
    );
  }

  await check(
    'a differently cased path to the same file is the same file',
    async () => {
      const probe = fs.mkdtempSync(path.join(base, 'case-probe-'));
      fs.writeFileSync(path.join(probe, 'a'), '');
      if (!fs.existsSync(path.join(probe, 'A'))) {
        console.log(
          'SKIP case-insensitive path (this file system is case-sensitive)',
        );
        return;
      }
      const run = await translateIn(
        { targetSrtSaveOption: 'fileName' },
        ({ dir, file }) => {
          file.srtFile = path.join(dir, 'CLIP.SRT');
        },
      );
      assert.match(
        run.outcome.error?.message || '',
        /would overwrite the source subtitle/,
      );
      assert.equal(read(run.srtFile), sourceSrt);
    },
  );

  const form = (operation, args = {}, defaults = {}) =>
    resolvePipelineForm(
      operation,
      { files: ['/media/clip.srt'], ...args },
      defaults,
      [],
    );
  await check(
    'automation fills a missing or unknown style for translating tasks',
    () => {
      assert.equal(form('translate').translateContent, 'onlyTranslate');
      assert.equal(
        form('translate', { config: { translateContent: 'both' } })
          .translateContent,
        'onlyTranslate',
      );
      assert.equal(
        form('pipeline', { taskType: 'generateAndTranslate' }, {})
          .translateContent,
        'onlyTranslate',
      );
    },
  );
  await check(
    'automation keeps a chosen style, from the task or the saved preference',
    () => {
      assert.equal(
        form('translate', {}, { translateContent: 'sourceAndTranslate' })
          .translateContent,
        'sourceAndTranslate',
      );
      assert.equal(
        form(
          'pipeline',
          {
            taskType: 'generateAndTranslate',
            config: { translateContent: 'translateAndSource' },
          },
          { translateContent: 'sourceAndTranslate' },
        ).translateContent,
        'translateAndSource',
      );
    },
  );
  await check(
    'automation leaves a transcribe-only task without a style',
    () => {
      const transcribe = form('transcribe', { files: ['/media/clip.mp4'] });
      assert.equal(transcribe.taskType, 'generateOnly');
      assert.equal('translateContent' in transcribe, false);
    },
  );

  await settle();
  if (unhandled.length) failures.push('an async error escaped unobserved');
  if (failures.length)
    throw new Error(
      `${failures.length} scenario(s) failed:\n- ${failures.join('\n- ')}`,
    );
  console.log(
    `Translate content: ${checks} scenarios passed. Fixtures: ${base}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
