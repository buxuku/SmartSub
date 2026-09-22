// Offline integration tests: real SDK, proxy manager and translation pipeline.
// The reserved test host cannot resolve directly, even when a VPN/TUN is active.
const assert = require('node:assert/strict');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const testHost = 'smartsub-translation-proxy.invalid';
const translatedText = '\u4f60\u597d';
const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
const originalLookup = dns.lookup;
const originalHttpAgent = http.globalAgent;
const originalHttpsAgent = https.globalAgent;
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const logs = [];
const requests = [];
const servers = [];
const agents = new Set();
let settings = {};
let directLookups = 0;
let passed = 0;
let failed = 0;

const store = { get: (key) => (key === 'settings' ? settings : undefined) };
const noop = () => {};
const report = (message) => process.stdout.write(`${message}\n`);
const provider = (overrides = {}) => ({
  id: 'Gemini',
  name: 'Gemini',
  type: 'Gemini',
  isAi: true,
  apiUrl: `http://${testHost}/v1beta/openai/`,
  apiKey: 'test-placeholder-key',
  modelName: 'gemini-3.5-flash-lite',
  structuredOutput: 'json_schema',
  strictStructuredOutput: true,
  enableThinking: true,
  echoAnchoring: false,
  batchSize: 20,
  batchConcurrency: 1,
  requestInterval: 0,
  ...overrides,
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function respond(label) {
  return (req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ label, method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'test-completion',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ 1: translatedText }),
              },
            },
          ],
        }),
      );
    });
  };
}

function createProxy(label) {
  const proxy = http.createServer(respond(label));
  proxy.on('connect', (req, socket) => {
    requests.push({ label, method: 'CONNECT', url: req.url });
    // A deliberate proxy error proves routing without external TLS or credentials.
    socket.end('HTTP/1.1 502 Test Proxy Reached\r\nContent-Length: 0\r\n\r\n');
  });
  return proxy;
}

async function main() {
  if (process.versions.electron) await require('electron').app.whenReady();
  const proxyModules = {
    'http-proxy-agent': await import('http-proxy-agent'),
    'https-proxy-agent': await import('https-proxy-agent'),
  };
  Module._load = function (request, parent, isMain) {
    const absolute =
      request.startsWith('.') && parent
        ? path.resolve(path.dirname(parent.filename), request)
        : '';
    if (proxyModules[request]) return proxyModules[request];
    if (request === 'electron' && !process.versions.electron)
      return {
        app: {
          getAppPath: () => repoRoot,
          getPath: () => path.join(repoRoot, 'node_modules/.cache'),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    if (absolute === path.join(repoRoot, 'main/helpers/store'))
      return { store };
    if (absolute === path.join(repoRoot, 'main/helpers/storeManager'))
      return {
        store,
        logMessage: (message, type = 'info') => logs.push({ message, type }),
      };
    if (absolute === path.join(repoRoot, 'main/helpers/glossaryManager'))
      return {
        getActiveGlossaryResolution: noop,
        logGlossaryConflicts: noop,
        logGlossaryMatches: noop,
      };
    if (absolute === path.join(repoRoot, 'main/helpers/fileUtils'))
      return { ensureTempDir: noop };
    if (absolute === path.join(repoRoot, 'main/service'))
      return {
        openaiTranslator: require('../main/service/openai.ts').default,
        azureOpenaiTranslator: require('../main/service/azureOpenai.ts')
          .default,
      };
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
  dns.lookup = function (hostname, options, callback) {
    if (hostname !== testHost) return originalLookup.apply(this, arguments);
    directLookups++;
    const cb = typeof options === 'function' ? options : callback;
    process.nextTick(
      cb,
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname,
      }),
    );
  };

  const {
    applyProxyFromSettings,
  } = require('../main/helpers/network/proxyManager.ts');
  const { testTranslation } = require('../main/translate/index.ts');
  const {
    TRANSLATOR_MAP,
  } = require('../main/translate/services/translationProvider.ts');
  const {
    handleAIBatchTranslation,
  } = require('../main/translate/services/ai.ts');
  const translateWithOpenAI = require('../main/service/openai.ts').default;
  const translateWithAzureOpenAI =
    require('../main/service/azureOpenai.ts').default;
  const {
    assertValidTestTranslation,
  } = require('../main/translate/utils/error.ts');
  const proxyA = await listen(createProxy('proxy-a'));
  const proxyB = await listen(createProxy('proxy-b'));
  const origin = await listen(http.createServer(respond('origin')));

  function configure(nextSettings) {
    settings = nextSettings;
    applyProxyFromSettings();
    if (http.globalAgent !== originalHttpAgent) agents.add(http.globalAgent);
    if (https.globalAgent !== originalHttpsAgent) agents.add(https.globalAgent);
  }

  async function check(name, run) {
    requests.length = logs.length = directLookups = 0;
    configure({ proxyMode: 'custom', proxyUrl: proxyA });
    console.log = console.warn = console.error = noop;
    try {
      await run();
      passed++;
      report(`PASS ${name}`);
    } catch (error) {
      failed++;
      report(`FAIL ${name}\n${error.stack}`);
    } finally {
      Object.assign(console, originalConsole);
    }
  }

  // Service requests use the existing scheduler hook to disable SDK retries.
  const requestOptions = { beforeRequest: async () => {} };
  const call = (translator, config) =>
    translator('{"1":"Hello"}', config, 'en', 'zh', requestOptions);
  for (const [name, translator, overrides] of [
    ['OpenAI/Gemini', translateWithOpenAI, {}],
    [
      'Azure OpenAI',
      translateWithAzureOpenAI,
      {
        type: 'azureopenai',
        id: 'azureopenai',
        apiUrl: `http://${testHost}/openai/deployments/test/chat/completions?api-version=2024-02-01`,
      },
    ],
  ]) {
    await check(`${name}: HTTP requests reach custom proxy`, async () => {
      const result = await call(translator, provider(overrides));
      assert.equal(JSON.parse(result)['1'], translatedText);
      assert.equal(directLookups, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].label, 'proxy-a');
      assert(requests[0].url.startsWith(`http://${testHost}/`));
      if (name === 'Azure OpenAI') {
        assert.equal(
          new URL(requests[0].url).pathname,
          '/openai/deployments/test/chat/completions',
        );
      }
    });
    await check(
      `${name}: HTTPS requests tunnel through custom proxy`,
      async () => {
        const config = provider(overrides);
        config.apiUrl = config.apiUrl.replace('http:', 'https:');
        await assert.rejects(call(translator, config), /502/);
        assert.equal(directLookups, 0);
        assert.deepEqual(requests, [
          { label: 'proxy-a', method: 'CONNECT', url: `${testHost}:443` },
        ]);
      },
    );
  }

  await check(
    'testTranslation returns the translated result through proxy',
    async () => {
      const result = await testTranslation(provider(), 'en', 'zh');
      assert.equal(result.translation, translatedText);
      assert.equal(result.analysis.test_completed, true);
      assert.equal(requests.length, 1);
      assert.equal(directLookups, 0);
    },
  );
  await check(
    'legacy useBatchTranslation flag still accepts structured results',
    async () => {
      const result = await testTranslation(
        provider({ useBatchTranslation: true }),
        'en',
        'zh',
      );
      assert.equal(result.translation, translatedText);
    },
  );
  await check(
    'proxy changes take effect for the next translation',
    async () => {
      await call(translateWithOpenAI, provider());
      configure({ proxyMode: 'custom', proxyUrl: proxyB });
      await call(translateWithOpenAI, provider());
      assert.deepEqual(
        requests.map((r) => r.label),
        ['proxy-a', 'proxy-b'],
      );
    },
  );
  await check(
    'default NO_PROXY preserves local HTTP endpoints and relative paths',
    async () => {
      const result = await call(
        translateWithOpenAI,
        provider({ apiUrl: `${origin}/v1` }),
      );
      assert.equal(JSON.parse(result)['1'], translatedText);
      assert.deepEqual(requests, [
        { label: 'origin', method: 'POST', url: '/v1/chat/completions' },
      ]);
    },
  );
  await check('custom NO_PROXY bypasses the configured proxy', async () => {
    configure({
      proxyMode: 'custom',
      proxyUrl: proxyA,
      proxyNoProxy: testHost,
    });
    await assert.rejects(
      call(translateWithOpenAI, provider()),
      /Connection error/,
    );
    assert.equal(requests.length, 0);
    assert.equal(directLookups, 1);
  });
  await check(
    'none restores direct HTTP requests after using a proxy',
    async () => {
      await call(translateWithOpenAI, provider());
      configure({ proxyMode: 'none' });
      assert.equal(http.globalAgent, originalHttpAgent);
      assert.equal(https.globalAgent, originalHttpsAgent);
      const result = await call(
        translateWithOpenAI,
        provider({ apiUrl: `${origin}/v1` }),
      );
      assert.equal(JSON.parse(result)['1'], translatedText);
      assert.deepEqual(
        requests.map((r) => r.label),
        ['proxy-a', 'origin'],
      );
      await assert.rejects(
        call(translateWithOpenAI, provider()),
        /Connection error/,
      );
    },
  );
  await check(
    'unreachable proxy fails instead of falling back to direct traffic',
    async () => {
      const closedServer = http.createServer();
      const closedUrl = await listen(closedServer);
      await new Promise((resolve) => closedServer.close(resolve));
      configure({
        proxyMode: 'custom',
        proxyUrl: closedUrl,
        proxyNoProxy: testHost,
      });
      await assert.rejects(
        call(translateWithOpenAI, provider({ apiUrl: `${origin}/v1` })),
        /Connection error/,
      );
      assert.equal(requests.length, 0);
    },
  );
  await check(
    'connection failure rejects testTranslation and logs zero successes',
    async () => {
      configure({ proxyMode: 'none' });
      await assert.rejects(
        testTranslation(provider(), 'en', 'zh'),
        /Connection error/,
      );
      assert(logs.some((l) => l.message.includes('\u6210\u529f 0 \u6761')));
    },
  );
  await check(
    'mixed batch totals use translationStatus and preserve failed source text',
    async () => {
      const subtitles = ['Hello', 'Second sentence'].map((text, i) => ({
        id: String(i + 1),
        startEndTime: '00:00:00,000 --> 00:00:01,000',
        content: [text],
      }));
      let calls = 0;
      const results = await handleAIBatchTranslation(
        subtitles,
        {
          provider: provider(),
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          translator: async () => {
            if (++calls === 1) return JSON.stringify({ 1: translatedText });
            throw new Error('Connection error.');
          },
        },
        1,
      );
      assert.equal(results[0].translationStatus, 'success');
      assert.equal(results[1].translationStatus, 'failed');
      assert.equal(results[1].targetContent, 'Second sentence');
      assert(logs.some((l) => l.message.includes('\u6210\u529f 1 \u6761')));
    },
  );
  await check(
    'non-AI translation test also rejects structured failure results',
    async () => {
      TRANSLATOR_MAP.testApi = async () => {
        throw new Error('Connection error.');
      };
      await assert.rejects(
        testTranslation(provider({ isAi: false, type: 'testApi' }), 'en', 'zh'),
        /Connection error/,
      );
    },
  );
  await check(
    'successful unchanged text is not mistaken for a failed translation',
    async () => {
      TRANSLATOR_MAP.testApi = async () => ['Hello'];
      const result = await testTranslation(
        provider({ isAi: false, type: 'testApi' }),
        'en',
        'en',
      );
      assert.equal(result.translation, 'Hello');
      assert.equal(result.analysis.test_completed, true);
      assert.throws(() => assertValidTestTranslation(''), /empty translation/);
      assert.throws(
        () =>
          assertValidTestTranslation('[\u7ffb\u8bd1\u5931\u8d25: test error]'),
        /test error/,
      );
    },
  );
  report(
    `${passed} passed, ${failed} failed (${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`})`,
  );
  return failed === 0 ? 0 : 1;
}

async function cleanup() {
  Object.assign(console, originalConsole);
  Module._load = originalLoad;
  dns.lookup = originalLookup;
  http.globalAgent = originalHttpAgent;
  https.globalAgent = originalHttpsAgent;
  if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
  else delete require.extensions['.ts'];
  for (const agent of agents) agent.destroy();
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
}

const watchdog = setTimeout(() => {
  report('FAIL test timeout');
  process.exit(1);
}, 45000);
main()
  .catch((error) => {
    report(error.stack);
    return 1;
  })
  .then(async (code) => {
    await cleanup();
    clearTimeout(watchdog);
    if (process.versions.electron) require('electron').app.exit(code);
    else process.exitCode = code;
  });
