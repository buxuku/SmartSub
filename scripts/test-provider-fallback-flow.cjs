// Offline integration tests using production adapters and batch handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const OpenAI = require('openai');
const axios = require('axios');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => path.resolve(__dirname, '..'),
        getPath: () => path.resolve(__dirname, '../node_modules/.cache'),
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (request.endsWith('/helpers/storeManager')) {
    return { logMessage: () => {}, store: { get: () => ({}) } };
  }
  if (request.endsWith('/helpers/glossaryManager')) {
    return { logGlossaryMatches: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require.extensions['.ts'] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  });
  module._compile(output.outputText, filename);
};

const {
  ProviderFallbackRunner,
  ProviderFallbackExhaustedError,
} = require('../main/translate/services/providerFallback.ts');
const translateWithOpenAI = require('../main/service/openai.ts').default;
const google = require('../main/service/google.ts').default;
const {
  handleAPIBatchTranslation,
} = require('../main/translate/services/api.ts');
const {
  handleAIBatchTranslation,
} = require('../main/translate/services/ai.ts');
const { isTaskCancelledError } = require('../main/helpers/taskContext.ts');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subtitles = Array.from({ length: 8 }, (_, index) => ({
  id: String(index + 1),
  startEndTime: '00:00:00,000 --> 00:00:01,000',
  content: [`Source sentence number ${index + 1}`],
}));

function translatedResponse(text, isAi) {
  if (!isAi) return text.map(() => 'translated');
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(JSON.parse(text)).map((id) => [
        id,
        { translation: '\u8bd1\u6587' },
      ]),
    ),
  );
}

function configWithRunner(primary, backup, resolveTranslator, signal) {
  return {
    provider: primary,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translator: resolveTranslator(primary),
    signal,
    fallbackRunner: new ProviderFallbackRunner({
      primary,
      fallbacks: [backup],
      resolveTranslator,
      signal,
      log: () => {},
    }),
  };
}

async function testRequestScheduling() {
  for (const isAi of [false, true]) {
    for (const concurrency of [1, 2]) {
      const suffix = `${isAi}-${concurrency}`;
      const primary = provider({
        id: `primary-${suffix}`,
        isAi,
        batchConcurrency: 6,
        echoAnchoring: false,
      });
      const backup = provider({
        id: `backup-${suffix}`,
        isAi,
        batchConcurrency: concurrency,
        requestInterval: 0.02,
      });
      const starts = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const config = configWithRunner(
        primary,
        backup,
        (candidate) => async (text) => {
          if (candidate.id === primary.id) {
            await delay(5);
            throw new Error('HTTP 429');
          }
          starts.push(Date.now());
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await delay(55);
          inFlight--;
          return translatedResponse(text, isAi);
        },
      );
      const handler = isAi
        ? handleAIBatchTranslation
        : handleAPIBatchTranslation;
      const results = await handler(subtitles, config, 1);
      assert.equal(results.length, subtitles.length);
      assert.equal(starts.length, subtitles.length);
      assert.equal(
        maxInFlight,
        concurrency,
        'backup concurrency should match its own limit',
      );
      assert(
        starts.slice(1).every((start, index) => start - starts[index] >= 19),
        'backup requests must be spaced apart',
      );
    }
  }
}

async function testQueuedCancellation() {
  const controller = new AbortController();
  const primary = provider({ id: 'cancel-primary', batchConcurrency: 1 });
  const backup = provider({ id: 'cancel-backup' });
  let calls = 0;
  let complete;
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const config = configWithRunner(
    primary,
    backup,
    () => async () => {
      calls++;
      await held;
      return 'ok';
    },
    controller.signal,
  );
  const run = () =>
    config.fallbackRunner.run((candidate, translator) =>
      translator('text', candidate, 'en', 'zh'),
    );
  const active = run();
  await delay(5);
  const queued = assert.rejects(run, isTaskCancelledError);
  controller.abort();
  await queued;
  complete();
  await active;
  assert.equal(calls, 1, 'cancelled queued request must not reach adapter');
  const next = configWithRunner(primary, backup, () => async () => 'next');
  assert.equal(
    await next.fallbackRunner.run((candidate, translator) =>
      translator('text', candidate, 'en', 'zh'),
    ),
    'next',
  );
}

async function testExhaustionStopsBatches() {
  for (const isAi of [false, true]) {
    const primary = provider({
      id: `exhaustion-primary-${isAi}`,
      isAi,
      echoAnchoring: false,
      batchConcurrency: 3,
    });
    const backup = provider({ id: `exhaustion-backup-${isAi}`, isAi });
    const calls = [];
    const saved = [];
    const progress = [];
    const config = configWithRunner(
      primary,
      backup,
      (candidate) => async (text) => {
        const id = isAi
          ? Object.keys(JSON.parse(text))[0]
          : String(
              subtitles.findIndex((item) => item.content[0] === text[0]) + 1,
            );
        calls.push([candidate.id, id]);
        if (candidate.id === primary.id && id !== '2') {
          await delay(id === '1' ? 5 : 50);
          return translatedResponse(text, isAi);
        }
        await delay(10);
        throw new Error('HTTP 503');
      },
    );
    const handler = isAi ? handleAIBatchTranslation : handleAPIBatchTranslation;
    await assert.rejects(
      () =>
        handler(
          subtitles,
          config,
          1,
          (value) => progress.push(value),
          async (results) => {
            saved.push(...results);
          },
          2,
        ),
      ProviderFallbackExhaustedError,
    );
    assert.deepEqual(
      saved.map((item) => item.id),
      ['1', '3', '4'],
      'successful in-flight batches must survive the failed gap in order',
    );
    assert(
      saved.every(
        (item) => !item.targetContent.startsWith('[\u7ffb\u8bd1\u5931\u8d25:'),
      ),
    );
    assert(progress.every((value) => value < 100));
    const completedCalls = calls.length;
    const completedWrites = saved.length;
    await delay(60);
    assert.equal(
      calls.length,
      completedCalls,
      'no requests should continue after rejection',
    );
    assert.equal(
      saved.length,
      completedWrites,
      'no writes should continue after rejection',
    );
    assert(
      calls.every(([, id]) => Number(id) <= 4),
      'remaining batches must not start after exhaustion',
    );
  }
}

async function testRepairExhaustion() {
  const primary = provider({ id: 'repair-primary', echoAnchoring: false });
  const backup = provider({ id: 'repair-backup' });
  let calls = 0;
  const saved = [];
  const config = configWithRunner(primary, backup, () => async () => {
    if (++calls <= 2) return '{}';
    throw new Error('HTTP 429');
  });
  await assert.rejects(
    () =>
      handleAIBatchTranslation(
        subtitles.slice(0, 1),
        config,
        1,
        undefined,
        async (results) => {
          saved.push(...results);
        },
        2,
      ),
    ProviderFallbackExhaustedError,
  );
  assert.equal(
    calls,
    4,
    'repair exhaustion must not trigger another batch retry',
  );
  assert.deepEqual(
    saved,
    [],
    'repair exhaustion must not become a failed placeholder',
  );
}

async function testRepairRequestsAreScheduled() {
  const primary = provider({
    id: 'repair-limit-primary',
    echoAnchoring: false,
  });
  const backup = provider({ id: 'repair-limit-backup', requestInterval: 0.02 });
  const starts = [];
  const config = configWithRunner(primary, backup, (candidate) => async () => {
    if (candidate.id === primary.id) throw new Error('HTTP 429');
    starts.push(Date.now());
    return starts.length < 4 ? '{}' : '{"1":{"translation":"\\u8bd1\\u6587"}}';
  });
  const result = await handleAIBatchTranslation(
    subtitles.slice(0, 1),
    config,
    1,
  );
  assert.equal(result[0].targetContent, '\u8bd1\u6587');
  assert.equal(
    starts.length,
    4,
    'whole-batch retry and targeted repair should run on backup',
  );
  assert(
    starts.slice(1).every((start, index) => start - starts[index] >= 19),
    'alignment retries and targeted repairs must also be rate limited',
  );
}

async function testLatePrimarySuccessDoesNotRewindFallback() {
  const primary = provider({ id: 'late-primary', batchConcurrency: 2 });
  const backup = provider({ id: 'late-backup' });
  let complete;
  const held = new Promise((resolve) => {
    complete = resolve;
  });
  const config = configWithRunner(
    primary,
    backup,
    (candidate) => async (text) => {
      if (candidate.id === primary.id && text === 'slow') {
        await held;
        return 'primary-result';
      }
      if (candidate.id === primary.id) throw new Error('HTTP 429');
      return 'backup-result';
    },
  );
  const run = (text) =>
    config.fallbackRunner.run((candidate, translator) =>
      translator(text, candidate, 'en', 'zh'),
    );
  const slow = run('slow');
  assert.equal(await run('fast'), 'backup-result');
  complete();
  assert.equal(await slow, 'primary-result');
  assert.equal(config.fallbackRunner.currentProvider.id, backup.id);
  assert.equal(await run('next'), 'backup-result');
}

function provider(overrides = {}) {
  return {
    id: 'primary',
    name: 'Primary',
    type: 'openai',
    isAi: true,
    apiKey: 'test-key',
    apiUrl: 'https://example.test/v1',
    modelName: 'test-model',
    structuredOutput: 'disabled',
    ...overrides,
  };
}

async function testAdapterErrors() {
  const originalCreate = OpenAI.Chat.Completions.prototype.create;
  const originalPost = axios.post;
  try {
    const cases = [
      [translateWithOpenAI, new OpenAI.APIConnectionError({}), 'openai'],
      [translateWithOpenAI, new OpenAI.APIConnectionTimeoutError(), 'openai'],
      [
        google,
        Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: {
              error: {
                message: 'API key not valid. Please pass a valid API key.',
              },
            },
          },
        }),
        'google',
      ],
    ];
    for (const [adapter, failure, type] of cases) {
      OpenAI.Chat.Completions.prototype.create = async () => {
        throw failure;
      };
      axios.post = async () => {
        throw failure;
      };
      const calls = [];
      const primary = provider({ type });
      const runner = new ProviderFallbackRunner({
        primary,
        fallbacks: [provider({ id: 'backup', type })],
        resolveTranslator:
          (candidate) =>
          async (...args) => {
            calls.push(candidate.id);
            return candidate.id === 'primary' ? adapter(...args) : 'translated';
          },
        log: () => {},
      });
      assert.equal(
        await runner.run((candidate, translator) =>
          translator('hello', candidate, 'en', 'zh'),
        ),
        'translated',
      );
      assert.deepEqual(calls, ['primary', 'backup']);
    }
  } finally {
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    axios.post = originalPost;
  }
}

async function testQwenCloneRequestParameters() {
  const originalCreate = OpenAI.Chat.Completions.prototype.create;
  const requests = [];
  OpenAI.Chat.Completions.prototype.create = async (request) => {
    requests.push(request);
    return { choices: [{ message: { content: 'translated' } }] };
  };
  try {
    const primary = provider({
      id: 'qwen',
      type: 'qwen',
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen-plus',
      enableThinking: false,
      customParameters: {
        headerParameters: {},
        bodyParameters: { top_k: 10, enable_thinking: true },
        configVersion: '1.0.0',
        lastModified: 0,
      },
    });
    for (const id of ['qwen', 'provider_qwen_copy']) {
      await translateWithOpenAI('hello', { ...primary, id }, 'en', 'zh');
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.top_k, 10);
      assert.equal(
        request.enable_thinking,
        true,
        'custom parameters must retain priority over derived defaults',
      );
    }
  } finally {
    OpenAI.Chat.Completions.prototype.create = originalCreate;
  }
}

async function main() {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await testAdapterErrors();
    await testRequestScheduling();
    await testQueuedCancellation();
    await testExhaustionStopsBatches();
    await testRepairExhaustion();
    await testRepairRequestsAreScheduled();
    await testLatePrimarySuccessDoesNotRewindFallback();
    await testQwenCloneRequestParameters();
    await testRealSdkRequestScheduling();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    Module._load = originalLoad;
    if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
    else delete require.extensions['.ts'];
  }
  console.log('provider fallback integration tests passed');
}

async function testRealSdkRequestScheduling() {
  const http = require('node:http');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, at: Date.now() });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/primary')) {
      res.writeHead(429);
      return res.end(JSON.stringify({ error: { message: 'rate limit' } }));
    }
    if (body.response_format?.type === 'json_schema') {
      res.writeHead(400);
      return res.end(
        JSON.stringify({ error: { message: 'response_format unsupported' } }),
      );
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"1":"translated"}' } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const primary = provider({
      id: 'sdk-primary',
      apiUrl: `${base}/primary/v1`,
    });
    const backup = provider({
      id: 'sdk-backup',
      apiUrl: `${base}/backup/v1`,
      structuredOutput: 'json_schema',
      requestInterval: 0.05,
    });
    const runner = new ProviderFallbackRunner({
      primary,
      fallbacks: [backup],
      resolveTranslator: () => translateWithOpenAI,
      log: () => {},
    });
    await runner.run((candidate, translator) =>
      translator('{"1":"hello"}', candidate, 'en', 'zh', {
        responseJsonSchema: {
          type: 'object',
          properties: { 1: { type: 'string' } },
        },
      }),
    );
    assert.equal(
      calls.filter((call) => call.path.startsWith('/primary')).length,
      1,
      'SDK must not retry 429 outside the fallback scheduler',
    );
    const backups = calls.filter((call) => call.path.startsWith('/backup'));
    assert.equal(
      backups.length,
      2,
      'schema compatibility fallback should remain available',
    );
    assert(
      backups[1].at - backups[0].at >= 49,
      'schema downgrade must respect provider request spacing',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
