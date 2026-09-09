/* Real file export/persistence/IPC tests; ASR and translation are deterministic fixtures. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const handlers = new Map();
let active;
let passed = 0;
let workItems = [];
const source =
  '1\n00:00:01,123 --> 00:00:03,456\nHello\nsecond line\n\n2\n00:00:05,000 --> 00:00:06,000\nWorld\n\n';
const target = source
  .replace('Hello\nsecond line', 'Bonjour')
  .replace('World', 'Monde');

require.extensions['.ts'] = function (module, filename) {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
    }).outputText,
    filename,
  );
};
Module._load = function (request, parent, isMain) {
  const req = String(request).replace(/\\/g, '/');
  if (request === 'electron')
    return {
      app: {
        getVersion: () => 'test',
        getPath: () => active.root,
        getAppPath: () => process.cwd(),
      },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
    };
  if (req.endsWith('/storeManager'))
    return { logMessage() {}, store: { get: () => ({}) } };
  if (parent?.filename.endsWith('taskManager.ts') && req === './workItemStore')
    return {
      getWorkItems: () => workItems,
      saveWorkItem: (item) => {
        workItems = [JSON.parse(JSON.stringify(item))];
        return item;
      },
    };
  if (req.endsWith('/messageHandler'))
    return { createMessageSender: () => ({ send() {} }) };
  if (req.endsWith('/fileUtils'))
    return {
      ensureTempDir: () => active.cache,
      getMd5: (value) => crypto.createHash('md5').update(value).digest('hex'),
    };
  if (parent?.filename.endsWith('stageUtils.ts') && req.endsWith('/lib/utils'))
    return {
      isSubtitleFile: (filePath) =>
        /\.(srt|vtt|ass|ssa|lrc|txt)$/i.test(filePath),
    };
  if (parent?.filename.endsWith('fileProcessor.ts')) {
    const stubs = {
      './audioProcessor': {
        extractAudioFromVideo: async (_event, file) => {
          file.tempAudioFile = file.filePath;
          return file.filePath;
        },
        probeEmbeddedSubtitles: async () => [],
      },
      './transcriptionRouter': {
        routeTranscription: async ({ event, file }) => {
          active.asr++;
          await fs.promises.writeFile(file.srtFile, source);
          event.sender.send('taskFileChange', {
            ...file,
            extractSubtitle: 'done',
          });
          return file.srtFile;
        },
      },
      '../translate': async (_event, file, config) => {
        active.translations++;
        file.translatedSrtFile = path.join(active.root, 'clip.fr.srt');
        file.tempTranslatedSrtFile = path.join(active.cache, 'translation.srt');
        const output =
          config.translateContent === 'onlyTranslate'
            ? target
            : target
                .replace('Bonjour', 'Hello\nsecond line\nBonjour')
                .replace('Monde', 'World\nMonde');
        await fs.promises.writeFile(file.translatedSrtFile, output);
        await fs.promises.writeFile(file.tempTranslatedSrtFile, target);
        return true;
      },
      './subtitleRefineStage': {
        runSubtitleRefineStage: async () => {},
        settleSkippedRefineStage() {},
      },
      './manuscriptMatchingStage': {
        runManuscriptMatchingStage: async () => {},
        settleSkippedManuscriptMatchStage() {},
      },
      './pipeline/dubStage': {
        runDubStage: async () => {
          active.dubs++;
        },
        rebuildDubTrackForFile: async () => {
          active.dubs++;
        },
      },
      './pipeline/composeStage': {
        runComposeStage: async () => {
          active.composes++;
        },
      },
      './pipeline/gateManager': { notifyGateReview() {} },
      './speakerDiarization/stage': {
        runSpeakerDiarizationStage: async () => ({}),
      },
    };
    if (Object.hasOwn(stubs, req)) return stubs[req];
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  resolveSubtitleOutputFormats,
  SUBTITLE_OUTPUT_FORMATS,
  subtitleOutputFilesToSave,
  getProofreadSourcePath,
} = require('../types/subtitleOutput.ts');
const {
  writeSubtitleDeliverables,
} = require('../main/helpers/subtitleDeliverables.ts');
const { parseSubtitleCues } = require('../main/helpers/subtitleFormats.ts');
const { processFile } = require('../main/helpers/fileProcessor.ts');
const {
  readProofreadDataFile,
  proofreadDataToSubtitleRows,
} = require('../main/helpers/proofreadData.ts');
const { runWithTaskContext } = require('../main/helpers/taskContext.ts');
const {
  pickComposeSubtitle,
} = require('../main/helpers/pipeline/deriveComposeConfig.ts');
const {
  pickDubTextSource,
} = require('../main/helpers/pipeline/dubTextSource.ts');
const { setupIpcHandlers } = require('../main/helpers/ipcHandlers.ts');
const { recipeToWizardPrefill } = require('../renderer/lib/recipes.ts');
const { isPinnedTaskConfigSnapshot } = require('../types/taskSnapshot.ts');
const {
  createSubtitlePathIdentity,
} = require('../main/helpers/subtitlePathIdentity.ts');
const {
  derivePipelineWorkItemStatus,
} = require('../main/helpers/workItemMigration.ts');
const { applyTaskEventToProjects } = require('../main/helpers/taskManager.ts');
const {
  getFileStages,
  isFileTerminal,
  isProofreadReady,
} = require('../renderer/components/tasks/stageUtils.ts');
setupIpcHandlers({});

function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  passed++;
}
async function fixture(root, name) {
  const dir = path.join(root, name);
  const cache = path.join(dir, 'cache');
  await fs.promises.mkdir(cache, { recursive: true });
  active = { root: dir, cache, asr: 0, translations: 0, dubs: 0, composes: 0 };
  return active;
}
async function task(root, name, config = {}, fileOverrides = {}, onEvent) {
  await fixture(root, name);
  const file = {
    uuid: name,
    filePath: path.join(active.root, 'clip.mp4'),
    fileName: 'clip',
    fileExtension: '.mp4',
    directory: active.root,
    ...fileOverrides,
  };
  await fs.promises.writeFile(
    file.filePath,
    file.fileExtension === '.srt' ? source : 'media',
  );
  const form = {
    taskType: 'generateOnly',
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    sourceSrtSaveOption: 'fileNameWithLang',
    targetSrtSaveOption: 'fileNameWithLang',
    translateProvider: 'test',
    translateContent: 'onlyTranslate',
    useEmbeddedSubtitles: false,
    ...config,
  };
  const state = { ...file };
  const event = {
    sender: {
      send(channel, payload, key, value) {
        if (channel === 'taskFileChange') Object.assign(state, payload);
        if (channel === 'taskStatusChange') state[key] = value;
        if (channel === 'taskErrorChange') state[`${key}Error`] = value;
        onEvent?.(channel, payload, key, value);
      },
    },
  };
  await processFile(event, file, form, false, { id: 'test' });
  return { state, file, form, event, counters: active };
}

async function run(root) {
  for (const [exportSubtitle, expected] of [
    ['loading', 'running'],
    ['error', 'error'],
    ['done', 'done'],
    ['', 'waiting'],
  ]) {
    const file = {
      uuid: 'status',
      extractAudio: 'done',
      extractSubtitle: 'done',
      translateSubtitle: 'done',
      exportSubtitle,
    };
    check(
      derivePipelineWorkItemStatus([file]),
      expected,
      `export ${exportSubtitle} participates in status derivation`,
    );
    workItems = [
      {
        id: 'status',
        type: 'generateAndTranslate',
        status: 'done',
        pipelineFiles: [{ ...file, exportSubtitle: 'done' }],
      },
    ];
    applyTaskEventToProjects(
      'taskStatusChange',
      file,
      'exportSubtitle',
      exportSubtitle,
    );
    check(
      workItems[0].status,
      expected,
      `taskManager persists export ${exportSubtitle} correctly`,
    );
  }
  check(
    derivePipelineWorkItemStatus([
      { exportSubtitle: 'error', exportSubtitleError: 'TASK_INTERRUPTED' },
    ]),
    'interrupted',
    'export interruption survives restart',
  );
  check(resolveSubtitleOutputFormats(), ['srt'], 'default');
  for (const format of SUBTITLE_OUTPUT_FORMATS)
    check(
      resolveSubtitleOutputFormats({ subtitleOutputFormat: format }),
      [format],
      `legacy ${format}`,
    );
  check(
    resolveSubtitleOutputFormats({
      subtitleOutputFormat: 'ass',
      subtitleOutputFormats: [],
    }),
    ['ass'],
    'empty list legacy fallback',
  );
  check(
    resolveSubtitleOutputFormats({
      subtitleOutputFormats: ['txt', 'srt', 'srt', '../bad'],
    }),
    ['srt', 'txt'],
    'deduplicate, filter and prefer timed primary',
  );
  check(
    resolveSubtitleOutputFormats({ subtitleOutputFormats: 'txt' }),
    ['srt'],
    'malformed persisted config',
  );
  const recipe = recipeToWizardPrefill({
    id: 'test',
    name: 'test',
    goals: { translate: true, dub: true, video: false },
    accepts: 'media',
    config: { subtitleOutputFormats: ['vtt', 'txt'] },
  });
  check(
    resolveSubtitleOutputFormats(JSON.parse(JSON.stringify(recipe.config))),
    ['vtt', 'txt'],
    'recipe and JSON round trip',
  );
  check(
    isPinnedTaskConfigSnapshot({ subtitleOutputFormats: ['srt', 'txt'] }),
    true,
    'multi-format task retry uses its saved snapshot',
  );
  check(
    isPinnedTaskConfigSnapshot({ subtitleOutputFormat: 'txt' }),
    false,
    'ordinary legacy task snapshot behavior is unchanged',
  );
  const legacyRecipe = recipeToWizardPrefill({
    id: 'legacy',
    goals: {},
    config: { subtitleOutputFormat: 'ass' },
  });
  check(
    resolveSubtitleOutputFormats({
      subtitleOutputFormats: ['srt', 'txt'],
      ...legacyRecipe.config,
    }),
    ['ass'],
    'legacy recipe overrides newer global multi-format preference',
  );

  for (let mask = 1; mask < 32; mask++) {
    await fixture(root, `formats-${mask}`);
    const srtPath = path.join(active.root, 'source.srt');
    await fs.promises.writeFile(srtPath, source);
    const formats = SUBTITLE_OUTPUT_FORMATS.filter(
      (_, index) => mask & (1 << index),
    );
    const [result] = await writeSubtitleDeliverables([
      { kind: 'source', srtPath, formats },
    ]);
    check(result.files.length, formats.length, `output count ${mask}`);
    check(
      await fs.promises.readFile(srtPath, 'utf8'),
      source,
      `canonical SRT untouched ${mask}`,
    );
    for (const output of result.files) {
      const content = await fs.promises.readFile(output, 'utf8');
      const format = path.extname(output).slice(1);
      assert.ok(content.includes('Hello') && content.includes('World'));
      if (format === 'txt') assert.ok(!content.includes('-->'));
      else
        check(
          parseSubtitleCues(content, format).length,
          2,
          `cue count ${format} ${mask}`,
        );
    }
  }

  const generated = await task(root, 'generate', {
    subtitleOutputFormats: ['srt', 'txt'],
    sourceSrtSaveOption: 'noSave',
  });
  check(
    generated.state.exportSubtitle,
    'done',
    'generateOnly completes exports even with legacy noSave',
  );
  check(generated.counters.asr, 1, 'one transcription for two formats');
  check(generated.state.sourceSubtitleFiles.length, 2, 'two generated outputs');
  check(generated.counters.translations, 0, 'no unwanted translation');
  for (const format of SUBTITLE_OUTPUT_FORMATS) {
    const legacy = await task(root, `legacy-${format}`, {
      subtitleOutputFormat: format,
    });
    check(
      legacy.state.exportSubtitle,
      'done',
      `legacy ${format} task completes`,
    );
    check(
      legacy.state.sourceSubtitleFiles.map((filePath) =>
        path.extname(filePath),
      ),
      [`.${format}`],
      `legacy ${format} exports only selected format`,
    );
    check(legacy.counters.asr, 1, `legacy ${format} transcribes once`);
  }
  const typeDef = {
    taskType: 'generateOnly',
    accepts: 'media',
    hasTranslate: false,
  };
  const stages = getFileStages(generated.state, typeDef, generated.form);
  check(
    isFileTerminal(generated.state, stages),
    true,
    'completed exports finish the task',
  );
  check(
    isProofreadReady(
      { ...generated.state, exportSubtitle: 'loading' },
      typeDef,
      generated.form,
    ),
    false,
    'proofreading waits for all exports',
  );
  check(
    isFileTerminal(
      { extractAudio: 'done', extractSubtitle: 'error', exportSubtitle: '' },
      stages,
    ),
    true,
    'unreached export stage does not hide an ASR failure',
  );

  const bilingual = await task(root, 'bilingual', {
    taskType: 'generateAndTranslate',
    subtitleOutputFormats: ['vtt', 'ass', 'lrc', 'txt'],
    translateContent: 'sourceAndTranslate',
    compose: { subtitle: 'hard' },
  });
  check(bilingual.state.exportSubtitle, 'done', 'bilingual export completes');
  check(
    [
      bilingual.counters.asr,
      bilingual.counters.translations,
      bilingual.counters.composes,
    ],
    [1, 1, 1],
    'one ASR/translation/compose',
  );
  check(bilingual.state.sourceSubtitleFiles.length, 4, 'four source formats');
  check(
    bilingual.state.translatedSubtitleFiles.length,
    4,
    'four translation formats',
  );
  check(
    fs.existsSync(path.join(active.root, 'clip.en.srt')),
    false,
    'unselected source SRT moved to cache',
  );
  check(
    fs.existsSync(path.join(active.root, 'clip.fr.srt')),
    false,
    'unselected translated SRT retained only in cache',
  );
  check(
    pickComposeSubtitle(bilingual.state, fs.existsSync, false),
    bilingual.state.tempFinalSubtitleFile,
    'compose uses timed bilingual cache',
  );
  check(
    pickDubTextSource(bilingual.state, bilingual.form, fs.existsSync).path,
    bilingual.state.tempTranslatedSrtFile,
    'TTS uses pure translation',
  );

  const data = await readProofreadDataFile(bilingual.state.proofreadDataFile);
  check(
    data.meta.sourceSubtitleFiles,
    bilingual.state.sourceSubtitleFiles,
    'source outputs survive sidecar reopen',
  );
  check(
    data.meta.translatedSubtitleFiles,
    bilingual.state.translatedSubtitleFiles,
    'translated outputs survive sidecar reopen',
  );
  const rows = proofreadDataToSubtitleRows(data);
  rows[0].sourceContent = 'Edited source';
  rows[0].targetContent = 'Edited target';
  const saved = await handlers.get('saveProofreadDataAndRender')(
    {},
    {
      proofreadDataFile: bilingual.state.proofreadDataFile,
      subtitles: rows,
      outputs: [],
    },
  );
  check(
    saved.success,
    true,
    'actual proofread IPC saves recorded outputs without renderer duplicates',
  );
  for (const output of subtitleOutputFilesToSave(
    data.meta,
    data.meta.translateContent,
  )) {
    const content = await fs.promises.readFile(output.filePath, 'utf8');
    assert.ok(
      content.includes('Edited source'),
      `source edit in ${output.filePath}`,
    );
    if (output.contentType !== 'source')
      assert.ok(content.includes('Edited target'));
    passed++;
  }
  const reopened = await readProofreadDataFile(
    bilingual.state.proofreadDataFile,
  );
  check(reopened.cues[0].startMs, 1123, 'proofread retains exact start time');
  check(reopened.cues[0].endMs, 3456, 'proofread retains exact end time');
  const savedWithCache = await handlers.get('saveProofreadDataAndRender')(
    {},
    {
      proofreadDataFile: bilingual.state.proofreadDataFile,
      subtitles: rows,
      outputs: [
        {
          filePath: bilingual.state.tempTranslatedSrtFile,
          contentType: 'onlyTranslate',
        },
        {
          filePath: bilingual.state.translatedSrtFile,
          contentType: 'sourceAndTranslate',
        },
      ],
    },
  );
  check(
    savedWithCache.success,
    true,
    'proofread accepts existing renderer cache outputs',
  );
  const pureTranslation = await fs.promises.readFile(
    bilingual.state.tempTranslatedSrtFile,
    'utf8',
  );
  check(
    pureTranslation.includes('Edited target') &&
      !pureTranslation.includes('Edited source'),
    true,
    'TTS cache remains pure translation after proofread',
  );
  await processFile(
    bilingual.event,
    { ...bilingual.state },
    bilingual.form,
    false,
    { id: 'test' },
  );
  check(
    [active.asr, active.translations, active.composes],
    [1, 1, 2],
    'pipeline resume reuses exports without another ASR or translation',
  );

  const noSource = await task(root, 'no-source', {
    taskType: 'generateAndTranslate',
    subtitleOutputFormats: ['srt', 'txt'],
    sourceSrtSaveOption: 'noSave',
  });
  check(
    noSource.state.sourceSubtitleFiles,
    [],
    'noSave does not export source formats',
  );
  check(
    noSource.state.translatedSubtitleFiles.length,
    2,
    'noSave exports translated formats',
  );
  check(noSource.state.srtFile, undefined, 'noSave clears source delivery');
  check(
    fs.existsSync(noSource.state.tempSrtFile),
    true,
    'noSave keeps proofread cache',
  );
  const noSourceData = await readProofreadDataFile(
    noSource.state.proofreadDataFile,
  );
  check(
    noSourceData.meta.tempSrtFile,
    noSource.state.tempSrtFile,
    'noSave cache survives sidecar reload',
  );

  const inputRoot = path.join(root, 'imported');
  const imported = await task(
    root,
    'imported',
    { taskType: 'translateOnly', subtitleOutputFormats: ['srt', 'txt'] },
    { filePath: path.join(inputRoot, 'original.srt'), fileExtension: '.srt' },
  );
  check(
    [imported.counters.asr, imported.counters.translations],
    [0, 1],
    'imported subtitles translate once without ASR',
  );
  check(
    await fs.promises.readFile(imported.file.filePath, 'utf8'),
    source,
    'imported source is unchanged',
  );
  check(
    imported.state.sourceSubtitleFiles,
    [],
    'input source is not converted',
  );

  const pairedPath = path.join(root, 'paired-source.srt');
  await fs.promises.writeFile(pairedPath, source);
  const paired = await task(
    root,
    'paired',
    { taskType: 'generateAndTranslate', subtitleOutputFormats: ['srt', 'txt'] },
    { providedSubtitlePath: pairedPath },
  );
  check(
    [paired.counters.asr, paired.counters.translations],
    [0, 1],
    'paired media skips ASR and translates once',
  );
  check(
    await fs.promises.readFile(pairedPath, 'utf8'),
    source,
    'paired source is unchanged',
  );
  check(
    paired.state.sourceSubtitleFiles,
    [],
    'paired source is not re-exported',
  );

  const txtOnly = await task(root, 'txt-only', {
    subtitleOutputFormats: ['txt'],
    dub: { engine: {} },
  });
  check(txtOnly.state.exportSubtitle, 'done', 'TXT-only export succeeds');
  check(
    getProofreadSourcePath(txtOnly.state),
    txtOnly.state.tempSrtFile,
    'TXT-only proofread preview selects timed cache',
  );
  const preview = await handlers.get('getSubtitleAsVtt')(
    {},
    { filePath: getProofreadSourcePath(txtOnly.state) },
  );
  check(
    parseSubtitleCues(preview.content, 'vtt').length,
    2,
    'actual preview IPC creates a nonempty TXT-only subtitle track',
  );
  check(
    parseSubtitleCues(preview.content, 'vtt')[0].endMs,
    3456,
    'preview keeps exact source timing',
  );
  check(
    pickDubTextSource(txtOnly.state, txtOnly.form, fs.existsSync).path,
    txtOnly.state.tempSrtFile,
    'TXT-only source keeps timed TTS input',
  );
  const lossy = await task(root, 'lossy-source', {
    subtitleOutputFormats: ['lrc', 'txt'],
    compose: { subtitle: 'hard' },
  });
  check(
    pickComposeSubtitle(lossy.state, fs.existsSync, false),
    lossy.state.tempSrtFile,
    'LRC/TXT composition uses exact source timing',
  );
  check(
    parseSubtitleCues(
      await fs.promises.readFile(lossy.state.tempSrtFile, 'utf8'),
      'srt',
    )[0].endMs,
    3456,
    'source cache retains end time absent from LRC',
  );

  await fixture(root, 'failures');
  const srtPath = path.join(active.root, 'source.srt');
  const protectedPath = path.join(active.root, 'source.txt');
  await fs.promises.writeFile(srtPath, source);
  await fs.promises.writeFile(protectedPath, 'user input');
  await assert.rejects(
    writeSubtitleDeliverables(
      [{ kind: 'target', srtPath, formats: ['vtt', 'txt'] }],
      [protectedPath],
    ),
    /overwrite/,
  );
  check(
    await fs.promises.readFile(protectedPath, 'utf8'),
    'user input',
    'input collision preserves user file',
  );
  check(
    fs.existsSync(path.join(active.root, 'source.vtt')),
    false,
    'all paths validated before first write',
  );
  await fs.promises.mkdir(path.join(active.root, 'source.ass'));
  await assert.rejects(
    writeSubtitleDeliverables([{ kind: 'source', srtPath, formats: ['ass'] }]),
  );
  check(
    await fs.promises.readFile(srtPath, 'utf8'),
    source,
    'write failure preserves canonical SRT',
  );
  check(
    (await fs.promises.readdir(active.root)).some((name) =>
      name.endsWith('.tmp'),
    ),
    false,
    'failed rename cleans temporary file',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    writeSubtitleDeliverables(
      [{ kind: 'source', srtPath, formats: ['vtt'] }],
      [],
      controller.signal,
    ),
  );
  check(
    fs.existsSync(path.join(active.root, 'source.vtt')),
    false,
    'cancellation creates no output',
  );

  let blockExport = true;
  const failed = await task(
    root,
    'task-failure',
    { subtitleOutputFormats: ['srt', 'txt'], compose: { subtitle: 'hard' } },
    {},
    (channel, payload) => {
      if (
        blockExport &&
        channel === 'taskFileChange' &&
        payload.exportSubtitle === 'loading'
      )
        fs.mkdirSync(path.join(active.root, 'clip.en.txt'), {
          recursive: true,
        });
    },
  );
  check(failed.state.exportSubtitle, 'error', 'task exposes export failure');
  check(
    failed.counters.composes,
    0,
    'export failure blocks downstream compose',
  );
  check(
    fs.existsSync(path.join(active.root, 'clip.en.srt')),
    true,
    'failed task preserves source SRT',
  );
  blockExport = false;
  await fs.promises.rmdir(path.join(active.root, 'clip.en.txt'));
  await processFile(failed.event, { ...failed.state }, failed.form, false, {
    id: 'test',
  });
  check(
    failed.state.exportSubtitle,
    'done',
    'retry completes the previously failed export stage',
  );
  check(
    failed.state.exportSubtitleError,
    undefined,
    'retry clears the export error',
  );
  check(
    failed.counters.composes,
    1,
    'retry reaches downstream compose after export succeeds',
  );
  check(
    failed.state.sourceSubtitleFiles.length,
    2,
    'retry records every output',
  );
  check(
    fs.existsSync(path.join(active.root, 'clip.en.txt')),
    true,
    'retry writes the missing format',
  );
  check(failed.counters.asr, 1, 'pipeline export retry does not repeat ASR');

  const missing = JSON.parse(JSON.stringify(failed.state));
  missing.exportSubtitle = 'error';
  missing.subtitleExportCheckpoint = {
    sourceSrtPath: path.join(active.root, 'missing.srt'),
    sourceOwned: true,
    translationActive: false,
    translateOk: true,
  };
  const callsBeforeMissing = [
    failed.counters.asr,
    failed.counters.translations,
  ];
  await processFile(failed.event, missing, failed.form, false, { id: 'test' });
  check(
    failed.state.exportSubtitle,
    'error',
    'missing checkpoint input remains an explicit export error',
  );
  check(
    [failed.counters.asr, failed.counters.translations],
    callsBeforeMissing,
    'missing inputs never silently fall back to paid work',
  );

  for (const taskType of [
    'generateOnly',
    'generateAndTranslate',
    'translateOnly',
  ]) {
    for (const phase of ['delivery', 'cache', 'metadata']) {
      const name = `retry-${taskType}-${phase}`;
      const rename = fs.promises.rename;
      let injected = false;
      fs.promises.rename = async (from, to) => {
        const hit =
          phase === 'delivery'
            ? to.endsWith('.txt')
            : phase === 'cache'
              ? /-(source|final)\.srt$/.test(to)
              : to.endsWith('.json');
        if (!injected && hit) {
          injected = true;
          throw new Error(`injected ${phase} failure`);
        }
        return rename(from, to);
      };
      let result;
      try {
        result = await task(
          root,
          name,
          {
            taskType,
            subtitleOutputFormats: ['vtt', 'txt'],
            sourceSrtSaveOption:
              taskType === 'generateAndTranslate'
                ? 'noSave'
                : 'fileNameWithLang',
          },
          taskType === 'translateOnly'
            ? {
                filePath: path.join(root, name, 'input.srt'),
                fileExtension: '.srt',
              }
            : {},
        );
      } finally {
        fs.promises.rename = rename;
      }
      check(injected, true, `${name} exercised failure point`);
      check(result.state.exportSubtitle, 'error', `${name} exposes failure`);
      const checkpoint = result.state.subtitleExportCheckpoint;
      check(
        fs.existsSync(checkpoint.sourceSrtPath),
        true,
        `${name} preserves canonical source before retry`,
      );
      if (checkpoint.translatedSrtPath)
        check(
          fs.existsSync(checkpoint.translatedSrtPath),
          true,
          `${name} preserves canonical translation before retry`,
        );
      const calls = [result.counters.asr, result.counters.translations];
      await processFile(
        result.event,
        JSON.parse(JSON.stringify(result.state)),
        result.form,
        false,
        { id: 'test' },
      );
      check(
        result.state.exportSubtitle,
        'done',
        `${name} reopens and exports successfully`,
      );
      check(
        [result.counters.asr, result.counters.translations],
        calls,
        `${name} retry incurs no ASR or translation calls`,
      );
      check(
        result.state.subtitleExportCheckpoint,
        undefined,
        `${name} clears completed checkpoint`,
      );
      check(
        result.state.proofreadDataReady,
        'done',
        `${name} retains proofread readiness`,
      );
      const files =
        taskType === 'generateOnly'
          ? result.state.sourceSubtitleFiles
          : result.state.translatedSubtitleFiles;
      check(files.length, 2, `${name} restores all outputs`);
    }
  }

  await fixture(root, 'filesystem-case');
  const caseSource = path.join(active.root, 'Clip.SRT');
  const caseInput = path.join(active.root, 'clip.TXT');
  await fs.promises.writeFile(caseSource, source);
  await fs.promises.writeFile(caseInput, 'protected case-insensitive input');
  const caseOperations = (caseSensitive) => ({
    readdir: fs.promises.readdir.bind(fs.promises),
    stat: async (filePath) => {
      const directory = path.dirname(filePath);
      const name = path.basename(filePath);
      const entries = await fs.promises.readdir(directory);
      const entry = entries.find((item) =>
        caseSensitive
          ? item === name
          : item.toLowerCase() === name.toLowerCase(),
      );
      if (!entry)
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return fs.promises.stat(path.join(directory, entry));
    },
  });
  const insensitive = caseOperations(false);
  insensitive.lstat = insensitive.stat;
  await assert.rejects(
    writeSubtitleDeliverables(
      [{ kind: 'source', srtPath: caseSource, formats: ['vtt', 'txt'] }],
      [caseInput],
      undefined,
      insensitive,
    ),
    /overwrite/,
  );
  check(
    await fs.promises.readFile(caseInput, 'utf8'),
    'protected case-insensitive input',
    'macOS-style case collision preserves input',
  );
  check(
    fs.existsSync(path.join(active.root, 'Clip.vtt')),
    false,
    'case conflicts fail before any export writes',
  );
  await assert.rejects(
    writeSubtitleDeliverables(
      [
        { kind: 'source', srtPath: caseSource, formats: ['txt'] },
        {
          kind: 'target',
          srtPath: path.join(active.root, 'clip.srt'),
          formats: ['txt'],
        },
      ],
      [],
      undefined,
      insensitive,
    ),
    /overlap/,
  );
  passed++;
  const sensitive = caseOperations(true);
  sensitive.lstat = sensitive.stat;
  const sensitiveIdentity = createSubtitlePathIdentity(sensitive);
  check(
    (await sensitiveIdentity(path.join(active.root, 'Clip.txt'))).name ===
      (await sensitiveIdentity(caseInput)).name,
    false,
    'case-sensitive volumes keep distinct basenames',
  );
  const [upperSrt] = await writeSubtitleDeliverables(
    [{ kind: 'source', srtPath: caseSource, formats: ['srt'] }],
    [],
    undefined,
    insensitive,
  );
  check(
    upperSrt.files,
    [caseSource],
    'case-insensitive SRT alias retains canonical spelling and is not cleaned up',
  );

  const cancelled = new AbortController();
  const cancelledTask = await runWithTaskContext(
    { signal: cancelled.signal },
    () =>
      task(
        root,
        'cancelled',
        { subtitleOutputFormats: ['srt', 'txt'] },
        {},
        (channel, payload) => {
          if (
            channel === 'taskFileChange' &&
            payload.exportSubtitle === 'loading'
          )
            cancelled.abort();
        },
      ),
  );
  check(
    cancelledTask.state.exportSubtitle,
    '',
    'task cancellation is not an export failure',
  );
  check(
    fs.existsSync(path.join(active.root, 'clip.en.txt')),
    false,
    'cancelled task does not export TXT',
  );
  await processFile(
    cancelledTask.event,
    JSON.parse(JSON.stringify(cancelledTask.state)),
    cancelledTask.form,
    false,
    { id: 'test' },
  );
  check(
    cancelledTask.state.exportSubtitle,
    'done',
    'cancelled export checkpoint can resume',
  );
  check(
    cancelledTask.counters.asr,
    1,
    'cancelled export resume does not repeat recognition',
  );
}

(async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-output-'),
  );
  const originalLog = console.log;
  try {
    console.log = () => {};
    await run(root);
    originalLog(`Subtitle output: ${passed} checks passed`);
  } finally {
    console.log = originalLog;
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
    if (
      path.dirname(root) === path.resolve(os.tmpdir()) &&
      path.basename(root).startsWith('smartsub-output-')
    )
      await fs.promises.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
