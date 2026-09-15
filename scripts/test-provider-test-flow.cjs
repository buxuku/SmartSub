// Execute the production button handler without mounting the settings page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.join(
  __dirname,
  '../renderer/components/resources/ProvidersTab.tsx',
);
const source = ts.createSourceFile(
  filename,
  fs.readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const fragments = [];
function visit(node) {
  if (
    ts.isFunctionDeclaration(node) &&
    node.name?.text === 'isDetectSkippableError'
  ) {
    fragments.push(node.getText(source));
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'handleTestTranslation'
  ) {
    fragments.push(
      `const handleTestTranslation = ${node.initializer.getText(source)};`,
    );
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(fragments.length, 2, 'load both production test functions');
const handlerCode = ts.transpileModule(fragments.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

async function simulate(responses, hasStructuredOutput = true) {
  const calls = [];
  const results = [];
  const saved = [];
  const loading = [];
  const detecting = [];
  const successes = [];
  const provider = {
    id: 'Gemini',
    type: 'Gemini',
    structuredOutput: 'json_schema',
  };
  const context = vm.createContext({
    Error,
    getCurrentProvider: () => provider,
    TEST_LANGS: { source: 'en', target: 'zh' },
    isProviderConfigured: () => true,
    getCurrentProviderType: () => ({
      fields: hasStructuredOutput
        ? [{ key: 'structuredOutput', defaultValue: 'json_schema' }]
        : [],
    }),
    window: {
      ipc: {
        invoke: async (channel, args) => {
          assert.equal(channel, 'testTranslation');
          const index = calls.length;
          calls.push(args.provider.structuredOutput);
          if (hasStructuredOutput)
            assert.equal(args.provider.strictStructuredOutput, true);
          const response = responses[Math.min(index, responses.length - 1)];
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
    setTestResult: (result) => results.push(result),
    setIsTestLoading: (value) => loading.push(value),
    setDetectingMode: (value) => detecting.push(value),
    panelScrollRef: { current: null },
    STRUCTURED_OUTPUT_MODES: ['disabled', 'json_object', 'json_schema'],
    STRUCTURED_OUTPUT_LABELS: {
      disabled: 'Disabled',
      json_object: 'JSON Object',
      json_schema: 'JSON Schema',
    },
    t: (key) => key,
    formatProviderError: (error) => error.message,
    handleInputChange: (key, value) => saved.push([key, value]),
    toast: { success: (message) => successes.push(message) },
  });
  vm.runInContext(handlerCode, context);
  await vm.runInContext('handleTestTranslation()', context);
  assert.deepEqual(loading, [true, false]);
  assert.equal(detecting.at(-1), null);
  assert.equal(results.length, 1);
  return { calls, result: results[0], saved, successes };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function check(name, run) {
    try {
      await run();
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n${error.stack}`);
    }
  }

  for (const message of [
    "Error invoking remote method 'testTranslation': Error: OpenAI translation failed: Connection error.",
    'Azure OpenAI translation failed: Connection error.',
    'OpenAI translation failed: Request timed out.',
    'read ECONNRESET',
    'socket hang up',
    'Network Error',
    'fetch failed',
    'getaddrinfo ENOTFOUND example.invalid',
    'connect ECONNREFUSED 127.0.0.1:7890',
    '401 Unauthorized',
  ]) {
    await check(`stops after one request: ${message}`, async () => {
      const { calls, result, saved, successes } = await simulate([
        new Error(message),
      ]);
      assert.equal(calls.length, 1);
      assert.equal(result.status, 'error');
      assert.equal(result.error, message);
      assert.equal(result.triedAllModes, false);
      assert.deepEqual(saved, []);
      assert.deepEqual(successes, []);
    });
  }

  const unsupported = new Error(
    '400 response_format json_schema is unsupported',
  );
  await check(
    'network error during format detection stops remaining candidates',
    async () => {
      const network = new Error('OpenAI translation failed: Connection error.');
      const { calls, result, saved } = await simulate([unsupported, network]);
      assert.equal(calls.length, 2);
      assert.equal(result.status, 'error');
      assert.equal(result.error, network.message);
      assert.equal(result.triedAllModes, false);
      assert.deepEqual(saved, []);
    },
  );
  await check(
    'unsupported format still retries and saves the working mode',
    async () => {
      const { calls, result, saved, successes } = await simulate([
        unsupported,
        { translation: '\u4f60\u597d', analysis: { response_time_ms: 10 } },
      ]);
      assert.deepEqual(calls, ['json_schema', 'disabled']);
      assert.equal(result.status, 'success');
      assert.equal(result.translation, '\u4f60\u597d');
      assert.equal(result.autoSwitchedMode, 'disabled');
      assert.deepEqual(saved, [['structuredOutput', 'disabled']]);
      assert.equal(successes.length, 1);
    },
  );
  await check(
    'reports exhausted modes only after trying all candidates',
    async () => {
      const { calls, result, saved } = await simulate([unsupported]);
      assert.equal(calls.length, 3);
      assert.equal(result.status, 'error');
      assert.equal(result.triedAllModes, true);
      assert.deepEqual(saved, []);
    },
  );
  await check(
    'providers without structured output never probe formats',
    async () => {
      const { calls, result } = await simulate([unsupported], false);
      assert.equal(calls.length, 1);
      assert.equal(result.triedAllModes, false);
    },
  );
  await check(
    'successful first request does not rewrite provider settings',
    async () => {
      const { calls, result, saved } = await simulate([
        { translation: '\u4f60\u597d' },
      ]);
      assert.equal(calls.length, 1);
      assert.equal(result.status, 'success');
      assert.deepEqual(saved, []);
    },
  );
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
