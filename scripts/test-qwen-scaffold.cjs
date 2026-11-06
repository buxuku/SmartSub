'use strict';

// Exercise the real Qwen adapter and subtitle pipeline with native results mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-qwen-scaffold-'));
const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
let response;
// Recorded so the tests can assert on what the adapter logs and asks the worker for.
const logs = [];
const transcribeRequests = [];
const prewarmRequests = [];
let storeSettings = {};

require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
};

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => root } };
  if (request.endsWith('/storeManager'))
    return {
      logMessage(message, level) {
        logs.push({ message: String(message), level });
      },
      store: { get: () => storeSettings },
    };
  if (request.endsWith('/qwenModelCatalog'))
    return {
      getQwenModelFiles: () => ({}),
      getQwenVadModelPath: () => path.join(root, 'vad.onnx'),
      isQwenReady: () => true,
      getInstalledQwenModels: () => ['qwen3-asr-0.6b'],
      resolveQwenSelection: () => ({ id: 'qwen3-asr-0.6b' }),
    };
  if (request.endsWith('/sherpaLibPaths'))
    return { isSherpaLibInstalled: () => true };
  if (request.endsWith('/sherpaLibManager'))
    return { getSherpaLibStatus: () => ({ version: 'fixture' }) };
  if (request.endsWith('/sherpaFunasrRuntime'))
    return {
      getSherpaAsrRuntime: () => ({
        transcribe: (model) => {
          transcribeRequests.push(model);
          return { id: 'fixture', result: Promise.resolve(response) };
        },
        prewarm: (model) => {
          prewarmRequests.push(model);
        },
      }),
    };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const {
    qwenEngineAdapter,
  } = require('../main/helpers/engines/qwenEngine.ts');
  const { parseSubtitleCues } = require('../main/helpers/subtitleFormats.ts');

  async function run(name, segments, config = {}) {
    const source = {
      segments,
      vadSegments: segments.map(({ start, end }) => ({ start, end })),
    };
    const before = JSON.stringify(source);
    // The adapter must copy segments, including when a segment is discarded.
    source.segments.forEach(Object.freeze);
    Object.freeze(source.segments);
    response = source;
    const diagnostics = [];
    const events = [];
    const srtFile = path.join(root, `${name}.srt`);
    const result = await qwenEngineAdapter.transcribe({
      event: { sender: { send: (...args) => events.push(args) } },
      file: {
        uuid: name,
        fileName: `${name}.wav`,
        // No audio fixture: the existing silence trimmer leaves timing alone.
        tempAudioFile: path.join(root, 'missing.wav'),
        srtFile,
      },
      formData: {
        transcriptionEngine: 'qwen',
        model: 'qwen3-asr-0.6b',
        ...config,
      },
      onDiagnostics: (value) => diagnostics.push(value),
    });
    assert.equal(result, srtFile);
    assert.equal(
      JSON.stringify(source),
      before,
      'native result stays unchanged',
    );
    assert.deepEqual(
      diagnostics,
      [
        {
          vadAvailable: true,
          vadSegments: segments.map(({ start, end }) => ({
            startMs: start * 1000,
            endMs: end * 1000,
          })),
        },
      ],
      'all original VAD boundaries survive text filtering',
    );
    assert.ok(
      events.some(
        ([channel, file]) =>
          channel === 'taskFileChange' && file.extractSubtitle === 'done',
      ),
    );
    const srt = fs.readFileSync(srtFile, 'utf8');
    return { srt, cues: parseSubtitleCues(srt, 'srt') };
  }

  const mixed = await run('mixed', [
    { start: 1, end: 2, text: 'language English<asr_text>Now' },
    { start: 2, end: 3, text: '语言中文' },
    { start: 3, end: 4, text: 'language Chinese<asr_text>你好<asr_text>世界' },
    { start: 4, end: 5, text: 'language None<asr_text>' },
    { start: 5, end: 6, text: 'language learning' },
    { start: 6, end: 7, text: '语言表达能力' },
    // A language-looking body must not be cleaned a second time.
    { start: 7, end: 8, text: 'language English<asr_text>language Chinese' },
    {
      start: 8,
      end: 9,
      text: 'language English<asr_text>language Chinese</asr_text>',
    },
  ]);
  assert.deepEqual(mixed.cues, [
    { startMs: 1000, endMs: 2000, text: 'Now' },
    { startMs: 3000, endMs: 4000, text: '你好世界' },
    { startMs: 5000, endMs: 6000, text: 'language learning' },
    { startMs: 6000, endMs: 7000, text: '语言表达能力' },
    { startMs: 7000, endMs: 8000, text: 'language Chinese' },
    { startMs: 8000, endMs: 9000, text: 'language Chinese' },
  ]);
  assert.deepEqual(
    mixed.srt
      .trim()
      .split(/\n\s*\n/)
      .map((block) => block.split('\n')[0]),
    ['1', '2', '3', '4', '5', '6'],
    'filtering leaves consecutive SRT indexes',
  );

  const text = '现在开始介绍语音识别，以及字幕清理的完整流程。';
  const clean = await run('clean', [{ start: 10, end: 18, text }], {
    maxSubtitleChars: 12,
  });
  const tagged = await run(
    'tagged',
    [
      {
        start: 10,
        end: 18,
        text: `**language Chinese<asr_text>${text}**`,
      },
    ],
    { maxSubtitleChars: 12 },
  );
  assert.ok(clean.cues.length > 1, 'fixture exercises real subtitle splitting');
  assert.equal(
    tagged.srt,
    clean.srt,
    'scaffold is removed before timing is split',
  );
  assert.equal(clean.cues[0].startMs, 10000);
  assert.equal(clean.cues.at(-1).endMs, 18000);

  const empty = await run('empty', [
    { start: 0, end: 1, text: 'language Chinese' },
    { start: 1, end: 2, text: 'language None<asr_text>' },
    { start: 2, end: 3, text: '<asr_text></asr_text>' },
  ]);
  assert.equal(empty.srt, '', 'metadata-only output creates no blank cues');
  assert.deepEqual(empty.cues, []);

  // Decoding budget: segments inside it stay silent, one far beyond it logs one warning.
  const budgetWarnings = () =>
    logs.filter(
      (entry) =>
        entry.level === 'warning' && /decoding budget/.test(entry.message),
    );
  assert.equal(
    budgetWarnings().length,
    0,
    'segments inside the decoding budget never warn',
  );
  const longSegments = [
    { start: 0, end: 45, text: 'language English<asr_text>Long speech' },
  ];
  const long = await run('long', longSegments);
  assert.deepEqual(
    long.cues,
    [{ startMs: 0, endMs: 45000, text: 'Long speech' }],
    'an over-budget segment still produces its subtitle unchanged',
  );
  assert.equal(
    budgetWarnings().length,
    1,
    'one aggregated warning per transcription',
  );
  const [warning] = budgetWarnings();
  assert.match(
    warning.message,
    /1 of 1 VAD segments exceed the decoding budget/,
  );
  assert.match(warning.message, /0\.0s-45\.0s/, 'names the longest segment');
  assert.match(warning.message, /~728 tokens/, 'states the estimated need');
  assert.match(warning.message, /~28\.3s/, 'states what still fits');

  // A raised budget fits the same segment, so nothing new is logged.
  storeSettings = { qwenMaxTotalLen: 1024, qwenMaxNewTokens: 256 };
  await run('long-big-budget', longSegments);
  storeSettings = {};
  assert.equal(
    budgetWarnings().length,
    1,
    'a raised budget (1024/256) fits a 45s segment without a warning',
  );

  // The worker request carries the clamped VAD limit, and prewarm asks for the same one.
  const requestFor = async (name, config) => {
    await run(
      name,
      [{ start: 0, end: 2, text: 'language English<asr_text>Hi' }],
      config,
    );
    return transcribeRequests.at(-1);
  };
  assert.equal(
    (await requestFor('limit-default', {})).params.vad_max_speech_duration_s,
    15,
    'default settings no longer mean unlimited',
  );
  const zero = await requestFor('limit-zero', { vadMaxSpeechDuration: 0 });
  assert.equal(
    zero.params.vad_max_speech_duration_s,
    15,
    '0 is treated as automatic (15s)',
  );
  assert.equal(
    (await requestFor('limit-manual', { vadMaxSpeechDuration: 12 })).params
      .vad_max_speech_duration_s,
    12,
    'a valid manual value is kept',
  );
  assert.equal(
    (await requestFor('limit-big', { vadMaxSpeechDuration: 60 })).params
      .vad_max_speech_duration_s,
    20,
    'an oversized value is clamped to the 20s cap',
  );
  qwenEngineAdapter.prewarm({
    transcriptionEngine: 'qwen',
    model: 'qwen3-asr-0.6b',
    vadMaxSpeechDuration: 0,
  });
  assert.deepEqual(
    prewarmRequests.at(-1),
    zero,
    'prewarm builds the identical worker request as transcribe',
  );
  console.log('Qwen scaffold adapter regression tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
    else delete require.extensions['.ts'];
    fs.rmSync(root, { recursive: true, force: true });
  });
