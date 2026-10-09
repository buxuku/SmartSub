/**
 * Offline regression checks for the AI segmentation window loop (issue #507).
 *
 * The real runAiSegmentation (windowing -> LLM round trips -> validation ->
 * alignment -> guards) runs against a scripted translator, so every scenario
 * mirrors a model / network behaviour seen in the report:
 *
 *  - the first answer is a perfect copy with one segment over the length limit
 *    (accepted by design: the physical guards re-split it), but a later retry
 *    damages the text or times out -> the window used to be thrown away, and a
 *    failed retry request even counted as "service unreachable";
 *  - the model changes punctuation / case / a stray character while otherwise
 *    copying the text -> the window used to be rejected, and the same drift came
 *    back on every retry;
 *  - every request carries a bounded timeout (the SDK default is 10 minutes and
 *    it retries a timeout twice, i.e. 30 minutes for one stalled request).
 *
 * Electron and the translator registry are replaced with in-memory stubs, so
 * nothing here touches the network (the one service-level case talks to a
 * local socket).
 *
 * Run: node scripts/test-ai-segmentation-runner.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const mainDir = path.join(repoRoot, 'main');

// The services print their config and every completion; keep the report readable.
const report = (line) => process.stdout.write(`${line}\n`);
const reportError = (line) => process.stderr.write(`${line}\n`);
console.log = () => {};
console.warn = () => {};
console.error = () => {};

/** Everything the app logged through storeManager.logMessage. */
const logs = [];
/** Replaces translationProvider's registry (and every service it would pull in). */
const TRANSLATOR_MAP = {};

const electronStub = {
  app: {
    getAppPath: () => repoRoot,
    getPath: () => path.join(repoRoot, 'node_modules', '.cache'),
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: { getAllWindows: () => [] },
};

// Stubs are keyed by resolved file path: the sources import these modules with
// different relative specifiers, so matching on the request string is brittle.
const stubsByFile = new Map([
  [
    path.join(mainDir, 'helpers', 'storeManager.ts'),
    {
      logMessage(message, level = 'info') {
        logs.push({ level, message: String(message) });
      },
      store: { get: () => ({}) },
    },
  ],
  [
    path.join(mainDir, 'helpers', 'glossaryManager.ts'),
    { logGlossaryMatches() {} },
  ],
  [
    path.join(mainDir, 'translate', 'services', 'translationProvider.ts'),
    { TRANSLATOR_MAP },
  ],
]);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (parent && /^\.{1,2}\//.test(request)) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      /* not resolvable here: let the real loader report it */
    }
    if (resolved && stubsByFile.has(resolved)) return stubsByFile.get(resolved);
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => repoRoot,
        getNewLine: () => '\n',
      }),
    );
  }
  module._compile(output.outputText, filename);
};

const {
  runAiSegmentation,
} = require('../main/helpers/subtitleRefine/segmentationRunner.ts');
const {
  TaskCancelledError,
  isTaskCancelledError,
} = require('../main/helpers/taskContext.ts');

// ---------------------------------------------------------------- fixtures --

const SENTENCE =
  'so the first thing we did was add a cache layer in front of the database and that alone cut the response time by almost forty percent';
/** Every segment within the 8-word limit. */
const VALID_ANSWER =
  'so the first thing we did<br>was add a cache layer<br>in front of the database<br>and that alone cut the response time<br>by almost forty percent';
/** Same text, last segment is 11 words: a *soft* violation the guards re-split. */
const GOOD_BUT_LONG =
  'so the first thing we did<br>was add a cache layer<br>in front of the database<br>and that alone cut the response time by almost forty percent';
/** Same text again, but with TWO over-long segments (11 and 9 words). */
const TWO_LONG_SEGMENTS =
  'so the first thing we did was add a cache layer<br>in front of the database and that alone cut<br>the response time by almost forty percent';
/** A model that wandered off: unrelated text, nothing to align. */
const GARBAGE = 'Sorry, I am unable to help with that request.';
const GARBAGE_2 = 'As an AI language model I cannot segment this text.';
const GARBAGE_3 = 'Here is a summary: caching reduced latency.';
/** A model that gave up half way. */
const TRUNCATED = 'so the first thing we did<br>was add a cache layer';

const PARAGRAPH_B =
  'then we moved on to the second problem which was the slow image resizing job that blocked every upload';

/** Whisper-style words: leading space, real timestamps (300 ms per word). */
function wordsOf(text, { startMs = 0, stepMs = 300 } = {}) {
  return text.split(' ').map((word, i) => ({
    text: i === 0 ? word : ` ${word}`,
    start: startMs + i * stepMs,
    end: startMs + (i + 1) * stepMs - 40,
  }));
}

const repeat = (text, times, separator = ' ') =>
  Array.from({ length: times }, () => text).join(separator);

/**
 * Two paragraphs separated by a 5 s pause. Inputs of 500 words or fewer stay a
 * single window, so the total must exceed that for the pause to close the
 * first window: 10 x 26 + 14 x 19 = 526 words.
 */
const PARAGRAPH_A_REPEATS = 10;
const PARAGRAPH_B_REPEATS = 14;
function twoWindowWords() {
  const a = wordsOf(repeat(SENTENCE, PARAGRAPH_A_REPEATS));
  const b = wordsOf(repeat(PARAGRAPH_B, PARAGRAPH_B_REPEATS), {
    startMs: a[a.length - 1].end + 5000,
  });
  return a.concat(b);
}

function makeProvider(overrides = {}) {
  return {
    id: 'fake-llm',
    name: 'Fake LLM',
    type: 'fakellm',
    isAi: true,
    batchConcurrency: 1,
    requestInterval: 0,
    ...overrides,
  };
}

/**
 * Scripts the model. `reply(callIndex, prompt)` returns the answer text or an
 * Error (thrown like a failed request). Returns the recorded calls.
 */
function installLlm(reply) {
  const calls = [];
  TRANSLATOR_MAP.fakellm = async (prompt, _provider, _from, _to, options) => {
    const index = calls.length;
    calls.push({ prompt, options });
    const answer = typeof reply === 'function' ? reply(index, prompt) : reply;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

async function segment(words, { signal, provider, formData = {} } = {}) {
  const text = words.map((w) => w.text).join('');
  return runAiSegmentation({
    cues: [['00:00:00,000', '00:00:30,000', text.trim()]],
    words,
    formData,
    provider: provider || makeProvider(),
    signal,
  });
}

const cueTexts = (outcome) => outcome.cues.map((cue) => cue[2]);
const joinedCueText = (outcome) => cueTexts(outcome).join(' ');
const logLines = (level) =>
  logs
    .filter((entry) => !level || entry.level === level)
    .map((entry) => entry.message);
const timeoutError = () =>
  new Error('OpenAI translation failed: Request timed out.');

// ------------------------------------------------------------------ runner --

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('baseline: a valid answer is accepted in a single request', async () => {
  const calls = installLlm(VALID_ANSWER);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 1);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(joinedCueText(outcome), SENTENCE);
  assert.equal(outcome.cues[0][0], '00:00:00,000', 'timeline from real words');
});

// Root cause 1 — the window used to keep the LAST answer, not the best one.
test('a content-perfect first answer survives later retries that wreck the text', async () => {
  const calls = installLlm(
    (index) => [GOOD_BUT_LONG, GARBAGE, GARBAGE_2][index],
  );
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 3, 'all feedback rounds were used');
  assert.equal(outcome.degraded, false);
  assert.equal(
    outcome.degradedWindows,
    0,
    'the usable first answer must not be discarded',
  );
  assert.equal(joinedCueText(outcome), SENTENCE, 'no word lost or duplicated');
  assert.ok(
    outcome.cues.every((cue) => cue[2].split(' ').length <= 8),
    `the guards re-split the over-long segment: ${JSON.stringify(cueTexts(outcome))}`,
  );
  assert.ok(
    logLines('info').some((line) => /window 1\/1 accepted/i.test(line)),
    `acceptance with a soft violation is logged: ${JSON.stringify(logLines())}`,
  );
});

test('retries are built from the best answer so far, not from the latest garbage', async () => {
  const calls = installLlm(
    (index) => [GOOD_BUT_LONG, GARBAGE, GARBAGE_2][index],
  );
  await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 3);
  assert.ok(calls[1].prompt.includes(GOOD_BUT_LONG), 'round 2 echoes round 1');
  assert.ok(
    calls[2].prompt.includes(GOOD_BUT_LONG),
    'round 3 still echoes the best answer',
  );
  assert.ok(
    !calls[2].prompt.includes(GARBAGE),
    'round 3 must not echo the failed round 2',
  );
});

test('a later round that fixes the length violation wins', async () => {
  const calls = installLlm((index) => [GOOD_BUT_LONG, VALID_ANSWER][index]);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 2, 'stops as soon as the answer is fully valid');
  assert.equal(outcome.degradedWindows, 0);
  assert.deepEqual(cueTexts(outcome), VALID_ANSWER.split('<br>'));
});

test('among usable answers the one with fewer length violations is kept', async () => {
  // Round 1: one over-long segment; round 2: two (a regression); round 3: garbage.
  const calls = installLlm(
    (index) => [GOOD_BUT_LONG, TWO_LONG_SEGMENTS, GARBAGE][index],
  );
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 3);
  assert.equal(outcome.degradedWindows, 0);
  assert.ok(
    calls[2].prompt.includes(GOOD_BUT_LONG),
    'the third round is built from the better (one-violation) answer',
  );
  assert.ok(
    !calls[2].prompt.includes('layer<br>in front of the database and that'),
    'and not from the worse (two-violation) round 2',
  );
});

// Root cause 2 — a failed retry request threw the earlier good answer away.
test('a retry request that fails keeps the earlier usable answer', async () => {
  const calls = installLlm((index) =>
    index === 0 ? GOOD_BUT_LONG : timeoutError(),
  );
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 2, 'no point retrying a service that just failed');
  assert.equal(outcome.degradedWindows, 0, 'window keeps its first answer');
  assert.equal(
    outcome.degraded,
    false,
    'a lost retry is not "service unreachable"',
  );
  assert.equal(joinedCueText(outcome), SENTENCE);
  assert.ok(
    logLines('warning').some((line) => /retry request failed/i.test(line)),
    `the lost retry is logged: ${JSON.stringify(logLines())}`,
  );
});

test('a failed first request still degrades only that window', async () => {
  const answerA = repeat(VALID_ANSWER, PARAGRAPH_A_REPEATS, '<br>');
  const calls = installLlm((_index, prompt) =>
    prompt.includes('second problem') ? timeoutError() : answerA,
  );
  const outcome = await segment(twoWindowWords());
  assert.equal(outcome.totalWindows, 2, 'two windows');
  assert.equal(
    calls.length,
    2,
    'one request per window, no retry after a failure',
  );
  assert.equal(outcome.degradedWindows, 1);
  assert.equal(outcome.degraded, false, 'the other window succeeded');
  assert.ok(
    logLines('warning').some((line) =>
      /window 2\/2 request failed, degraded to rule cues/i.test(line),
    ),
  );
});

test('the stage degrades when every window fails its first request', async () => {
  installLlm(() => timeoutError());
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.cues.length, 1, 'the original rule cue is returned');
});

// Diagnostics — #507 could not be explained from its log.
test('a window that never matches the text degrades with a reason in the log', async () => {
  const calls = installLlm((index) => [GARBAGE, GARBAGE_2, GARBAGE_3][index]);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 3);
  assert.equal(outcome.degradedWindows, 1);
  assert.equal(outcome.degraded, false);
  const degradeLine = logLines('warning').find((line) =>
    /window 1\/1 degraded to rule cues/i.test(line),
  );
  assert.ok(
    degradeLine,
    `degrading a window is logged: ${JSON.stringify(logLines())}`,
  );
  assert.ok(/content/i.test(degradeLine), 'the reason is stated');
});

test('an answer repeated verbatim ends the retries early', async () => {
  const calls = installLlm(GOOD_BUT_LONG);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 2, 'a repeat means the retry cannot help');
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(joinedCueText(outcome), SENTENCE);
});

test('cancellation during a retry still cancels the stage', async () => {
  const controller = new AbortController();
  installLlm((index) => {
    if (index === 0) return GOOD_BUT_LONG;
    controller.abort();
    return new TaskCancelledError();
  });
  await assert.rejects(
    () => segment(wordsOf(SENTENCE), { signal: controller.signal }),
    (error) => isTaskCancelledError(error),
  );
});

// ------------------------------------------------------------------- drift --
// Root cause 3 — the model rarely copies the text byte for byte. Punctuation,
// case and the odd letter change, and the window used to be rejected for it
// (then rejected again on every retry, because the model repeats the drift).

const PUNCTUATED =
  'So, the first thing we did was add a cache layer. In front of the database, and that alone cut the response time by almost forty percent.';
/** Lower case, no punctuation: what chat models tend to return. */
const PUNCTUATED_ANSWER = VALID_ANSWER;
const PUNCTUATED_CUES = [
  'So, the first thing we did',
  'was add a cache layer.',
  'In front of the database,',
  'and that alone cut the response time',
  'by almost forty percent.',
];

test('punctuation and case drift is accepted without a retry and the original text is kept', async () => {
  const calls = installLlm(PUNCTUATED_ANSWER);
  const outcome = await segment(wordsOf(PUNCTUATED));
  assert.equal(calls.length, 1, 'no feedback round needed');
  assert.equal(outcome.degradedWindows, 0);
  assert.deepEqual(cueTexts(outcome), PUNCTUATED_CUES);
  assert.equal(outcome.cues[0][0], '00:00:00,000', 'real word timestamps');
});

test('a few changed letters are accepted and never reach the cues', async () => {
  // Two insertions: the copy is two characters longer than the transcript, so
  // counting characters (what alignment does) cannot line them up by luck.
  const drifted = VALID_ANSWER.replace('forty', 'fourty').replace(
    'layer',
    'layers',
  );
  const calls = installLlm(drifted);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 1);
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(
    joinedCueText(outcome),
    SENTENCE,
    'the cue text is the transcript, not the model copy',
  );
  assert.deepEqual(cueTexts(outcome), VALID_ANSWER.split('<br>'));
});

test('accepting drifted text is logged', async () => {
  installLlm(PUNCTUATED_ANSWER);
  await segment(wordsOf(PUNCTUATED));
  assert.ok(
    logLines('info').some((line) => /window 1\/1 .*drift/i.test(line)),
    `expected a note about tolerated drift: ${JSON.stringify(logLines())}`,
  );
});

test('a rewrite beyond the tolerance still degrades the window', async () => {
  // About a fifth of the letters differ: a paraphrase, not a copy.
  const paraphrases = [
    'so the initial step we took<br>was adding a caching tier<br>before the db<br>and that alone cut latency<br>by roughly forty percent',
    'so the opening move we made<br>was adding a caching tier<br>before the db<br>and that alone cut latency<br>by roughly forty percent',
    'so the earliest thing we tried<br>was adding a caching tier<br>before the db<br>and that alone cut latency<br>by roughly forty percent',
  ];
  const calls = installLlm((index) => paraphrases[index]);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 3);
  assert.equal(outcome.degradedWindows, 1);
  assert.ok(
    logLines('warning').some((line) =>
      /window 1\/1 degraded to rule cues: content differs/i.test(line),
    ),
  );
});

test('segment-level timelines keep the original text too', async () => {
  const cues = [
    ['00:00:00,000', '00:00:03,000', 'So, the first thing we did was add'],
    [
      '00:00:03,000',
      '00:00:06,000',
      'a cache layer. In front of the database,',
    ],
    [
      '00:00:06,000',
      '00:00:10,000',
      'and that alone cut the response time by almost forty percent.',
    ],
  ];
  installLlm(PUNCTUATED_ANSWER);
  const outcome = await runAiSegmentation({
    cues,
    words: null,
    formData: {},
    provider: makeProvider(),
  });
  assert.equal(outcome.tier, 'segment');
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(joinedCueText(outcome), PUNCTUATED);
});

// ----------------------------------------------------------- request limits --
// Root cause 2 — the OpenAI SDK waits 10 minutes per attempt and re-sends a
// timed-out request twice, so one stalled request held a window for 30 minutes.

test('the first request is time-bounded and keeps the SDK retries for transient errors', async () => {
  const calls = installLlm(VALID_ANSWER);
  await segment(wordsOf(SENTENCE));
  const { timeoutMs, maxRetries } = calls[0].options;
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs < 10 * 60_000,
    `expected a bounded timeoutMs below the SDK default, got ${timeoutMs}`,
  );
  assert.equal(maxRetries, undefined, '429 / 5xx keep the SDK backoff retries');
});

test('a retry that only tries to improve a usable answer gets a tighter limit and no transport retries', async () => {
  const calls = installLlm((index) => [GOOD_BUT_LONG, VALID_ANSWER][index]);
  await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 2);
  // The usable answer is already in hand: the retry is a nice-to-have (this is
  // exactly where #507 lost 30 minutes per window).
  assert.ok(
    calls[1].options.timeoutMs < calls[0].options.timeoutMs,
    `retry ${calls[1].options.timeoutMs} should be tighter than first ${calls[0].options.timeoutMs}`,
  );
  assert.equal(calls[1].options.maxRetries, 0);
});

test('the limit for an improving retry follows how slow the provider has been', async () => {
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  try {
    const improvingLimit = async (firstRequestMs) => {
      skewMs = 0;
      const calls = installLlm((index) => {
        if (index === 0) {
          skewMs += firstRequestMs; // the first request "takes" this long
          return GOOD_BUT_LONG;
        }
        return VALID_ANSWER;
      });
      await segment(wordsOf(SENTENCE));
      return calls[1].options.timeoutMs;
    };
    assert.equal(await improvingLimit(5_000), 60_000, 'floor of one minute');
    assert.equal(
      await improvingLimit(100_000),
      200_000,
      'twice the slowest request',
    );
    assert.equal(
      await improvingLimit(250_000),
      300_000,
      'never above the first-request limit',
    );
  } finally {
    Date.now = realNow;
  }
});

test('a retry that has to rescue damaged text keeps the generous limit', async () => {
  const calls = installLlm((index) => [GARBAGE, VALID_ANSWER][index]);
  const outcome = await segment(wordsOf(SENTENCE));
  assert.equal(calls.length, 2);
  assert.equal(outcome.degradedWindows, 0);
  assert.equal(calls[1].options.timeoutMs, calls[0].options.timeoutMs);
  assert.equal(calls[1].options.maxRetries, undefined);
});

// Service level — the limits really reach the SDK and make it give up.

/** An OpenAI-compatible endpoint; `handler` decides how (or whether) to answer. */
async function startServer(handler) {
  const http = require('node:http');
  const sockets = new Set();
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests: () => requestCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const neverAnswer = () => {};
const answerWith = (content) => (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content },
        },
      ],
    }),
  );
};
const openAiProvider = (port) => ({
  id: 'local-openai',
  apiKey: 'sk-test',
  apiUrl: `http://127.0.0.1:${port}/v1`,
  modelName: 'm',
  systemPrompt: 's',
  useJsonMode: false,
  structuredOutput: 'disabled',
});
const azureProvider = (port) => ({
  id: 'local-azure',
  apiKey: 'test-key',
  apiUrl: `http://127.0.0.1:${port}/openai/deployments/dep/chat/completions?api-version=2024-02-01`,
  modelName: 'dep',
  systemPrompt: 's',
  useJsonMode: false,
  structuredOutput: 'disabled',
});

test('toSdkRequestOptions forwards only what the caller set', async () => {
  const {
    toSdkRequestOptions,
  } = require('../main/service/sdkRequestOptions.ts');
  const signal = new AbortController().signal;
  assert.deepEqual(toSdkRequestOptions(undefined), { signal: undefined });
  assert.deepEqual(toSdkRequestOptions({ signal }), { signal });
  assert.deepEqual(
    toSdkRequestOptions({ signal, timeoutMs: 5000, maxRetries: 0 }),
    { signal, timeout: 5000, maxRetries: 0 },
  );
  assert.deepEqual(
    toSdkRequestOptions({ timeoutMs: 0, maxRetries: -1 }),
    { signal: undefined },
    'nonsensical values fall back to the SDK defaults',
  );
});

test('translateWithOpenAI gives up on a stalled request after timeoutMs', async () => {
  const translateWithOpenAI = require('../main/service/openai.ts').default;
  const server = await startServer(neverAnswer);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        translateWithOpenAI('hello', openAiProvider(server.port), 'en', 'zh', {
          timeoutMs: 150,
          maxRetries: 0,
        }),
      /timed out/i,
    );
    assert.ok(
      Date.now() - startedAt < 5000,
      'must give up quickly instead of waiting for the SDK 10 minute default',
    );
    assert.equal(server.requests(), 1, 'maxRetries: 0 means no re-send');
  } finally {
    await server.close();
  }
});

test('without maxRetries the SDK re-sends a timed-out request (why the option exists)', async () => {
  const translateWithOpenAI = require('../main/service/openai.ts').default;
  const server = await startServer(neverAnswer);
  try {
    await assert.rejects(
      () =>
        translateWithOpenAI('hello', openAiProvider(server.port), 'en', 'zh', {
          timeoutMs: 100,
        }),
      /timed out/i,
    );
    assert.equal(
      server.requests(),
      3,
      'SDK default: the original request plus two re-sends',
    );
  } finally {
    await server.close();
  }
});

test('translateWithAzureOpenAI gives up on a stalled request after timeoutMs', async () => {
  const {
    translateWithAzureOpenAI,
  } = require('../main/service/azureOpenai.ts');
  const server = await startServer(neverAnswer);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        translateWithAzureOpenAI(
          'hello',
          azureProvider(server.port),
          'en',
          'zh',
          { timeoutMs: 150, maxRetries: 0 },
        ),
      /timed out/i,
    );
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

test('limits do not disturb a healthy request', async () => {
  const translateWithOpenAI = require('../main/service/openai.ts').default;
  const server = await startServer(answerWith('segmented<br>text'));
  try {
    const answer = await translateWithOpenAI(
      'hello',
      openAiProvider(server.port),
      'en',
      'zh',
      { timeoutMs: 5000, maxRetries: 0 },
    );
    assert.equal(answer, 'segmented<br>text');
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------------ driver --

/** A hung test must fail the run, not block CI until its job timeout. */
const TEST_DEADLINE_MS = 20_000;
function withDeadline(promise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no result within ${TEST_DEADLINE_MS}ms (hung)`)),
      TEST_DEADLINE_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    logs.length = 0;
    for (const key of Object.keys(TRANSLATOR_MAP)) delete TRANSLATOR_MAP[key];
    try {
      await withDeadline(fn());
      passed += 1;
    } catch (error) {
      failed += 1;
      reportError(
        `✗ ${name}\n    ${String((error && error.message) || error)
          .split('\n')
          .join('\n    ')}`,
      );
    }
  }
  report(`ai segmentation runner: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
