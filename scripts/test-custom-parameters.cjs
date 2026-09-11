// Run real parameter parsing, persistence and OpenAI transport without Electron
// user data or cloud credentials. Only Electron and i18n are substituted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { test, after } = require('node:test');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-parameters-'));
const ipcHandlers = new Map();
const originalLoad = Module._load;
const extensions = {
  '.ts': require.extensions['.ts'],
  '.tsx': require.extensions['.tsx'],
};
for (const ext of Object.keys(extensions)) {
  require.extensions[ext] = (module, filename) => {
    module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
  };
}
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return {
      app: { getPath: () => tempDir },
      ipcMain: {
        handle: (channel, handler) => ipcHandlers.set(channel, handler),
      },
    };
  if (request === 'next-i18next')
    return { useTranslation: () => ({ t: (key) => key }) };
  let resolved = request;
  if (request.startsWith('@/'))
    resolved = path.resolve(__dirname, '../renderer', request.slice(2));
  else if (/^(lib|hooks|components)\//.test(request))
    resolved = path.resolve(__dirname, '../renderer', request);
  return originalLoad.call(this, resolved, parent, isMain);
};

after(() => {
  Module._load = originalLoad;
  for (const [ext, original] of Object.entries(extensions)) {
    if (original) require.extensions[ext] = original;
    else delete require.extensions[ext];
  }
  // The only recursive removal is the isolated directory created by this test.
  assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tempDir).startsWith('smartsub-parameters-'));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const {
  inferTypeFromValue,
  resolveParameterType,
  parseDraftValue,
  formatValueForInput,
  validateJsonParameter,
  coerceParameterValue,
} = require('../renderer/lib/parameterValueUtils.ts');
const { ParameterProcessor } = require('../main/helpers/parameterProcessor.ts');
const nested = {
  type: 'enabled',
  options: {
    budget: 0,
    enabled: false,
    tags: ['中文', { weight: 0.5 }],
    optional: null,
  },
};
const provider = {
  id: 'deepseek',
  name: 'Deepseek',
  type: 'deepseek',
  isAi: true,
  apiKey: 'test-key',
  apiUrl: 'https://api.deepseek.com/v1',
  modelName: 'deepseek-chat',
};
const configuration = (bodyParameters) => ({
  headerParameters: {},
  bodyParameters,
  configVersion: '1.0.0',
  lastModified: 0,
});

test('imported and reopened objects retain their type and nested JSON through editing', () => {
  const imported = JSON.parse(
    JSON.stringify({ configuration: configuration({ thinking: nested }) }),
  );
  const value = imported.configuration.bodyParameters.thinking;
  assert.equal(inferTypeFromValue(value), 'object');
  const text = formatValueForInput(value, inferTypeFromValue(value));
  assert.ok(!text.includes('[object Object]'));
  assert.deepEqual(parseDraftValue(text, 'object'), nested);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseDraftValue(text, 'object'))),
    nested,
  );
  assert.equal(resolveParameterType({ type: 'object' }), 'object');
  assert.deepEqual(coerceParameterValue(text, { type: 'object' }), nested);
  // Explicitly switching to string preserves the JSON, not JS object coercion.
  assert.deepEqual(JSON.parse(formatValueForInput(nested, 'string')), nested);
});

test('object and array drafts reject malformed JSON, empty input and the wrong top-level shape', () => {
  for (const raw of [
    '',
    ' ',
    '{',
    '{"enabled":}',
    'null',
    '[]',
    'true',
    '42',
    '"text"',
  ]) {
    assert.notEqual(validateJsonParameter(raw, 'object'), null, raw);
    assert.throws(() => parseDraftValue(raw, 'object'), undefined, raw);
  }
  for (const raw of ['', '{', '{}', 'null', 'false', '1', '"text"']) {
    assert.notEqual(validateJsonParameter(raw, 'array'), null, raw);
    assert.throws(() => parseDraftValue(raw, 'array'), undefined, raw);
  }
  assert.equal(validateJsonParameter('{}', 'object'), null);
  assert.equal(validateJsonParameter('[]', 'array'), null);
  assert.deepEqual(parseDraftValue('{}', 'object'), {});
  assert.deepEqual(parseDraftValue('[{"enabled":false},null]', 'array'), [
    { enabled: false },
    null,
  ]);
});

test('existing scalar and array parameter behavior is preserved', () => {
  for (const [value, type] of [
    [0, 'integer'],
    [0.5, 'float'],
    [false, 'boolean'],
    ['text', 'string'],
    [[], 'array'],
  ]) {
    assert.equal(inferTypeFromValue(value), type);
    assert.deepEqual(
      parseDraftValue(formatValueForInput(value, type), type),
      value,
    );
  }
  assert.equal(inferTypeFromValue(null), 'string');
  assert.equal(coerceParameterValue(' 0.3 ', { type: 'float' }), 0.3);
  assert.equal(coerceParameterValue(' hello '), 'hello');
});

test('native thinking objects and unknown nested parameters reach request processing intact', () => {
  for (const candidate of [
    provider,
    { ...provider, type: 'doubao' },
    { ...provider, type: 'openai' },
  ]) {
    const config = configuration({
      thinking: nested,
      extra_body: { enabled: false, items: [0, null] },
    });
    const before = JSON.stringify(config);
    const result = ParameterProcessor.processCustomParameters(
      { ...candidate, customParameters: config },
      { thinking: { type: 'disabled' } },
    );
    assert.deepEqual(result.body, config.bodyParameters);
    assert.deepEqual(result.validationErrors, []);
    assert.deepEqual(result.skippedParameters, []);
    assert.equal(JSON.stringify(config), before);
    assert.ok(!('enable_thinking' in result.body));
  }
});

test('legacy thinking strings keep provider conversion and enum validation', () => {
  for (const value of ['enabled', 'disabled', 'auto']) {
    const config = configuration({ thinking: value });
    const doubao = ParameterProcessor.processCustomParameters(
      { ...provider, type: 'doubao', customParameters: config },
      {},
    );
    assert.deepEqual(doubao.body, { thinking: { type: value } });
    const qwen = ParameterProcessor.processCustomParameters(
      { ...provider, type: 'qwen', customParameters: config },
      {},
    );
    assert.deepEqual(qwen.body, { enable_thinking: value !== 'disabled' });
  }
  for (const value of [
    'invalid',
    '[object Object]',
    ['disabled'],
    null,
    false,
    1,
  ]) {
    const result = ParameterProcessor.processCustomParameters(
      { ...provider, customParameters: configuration({ thinking: value }) },
      {},
    );
    assert.deepEqual(result.body, {});
    assert.ok(result.validationErrors.length > 0);
    assert.deepEqual(result.skippedParameters, ['body:thinking']);
  }
  const numeric = ParameterProcessor.validateParameter(
    'temperature',
    { value: 0.3 },
    provider,
  );
  assert.equal(numeric.isValid, false);
});

test('the actual parameter table renders imported objects in a JSON textarea', () => {
  const {
    ParameterKvTable,
  } = require('../renderer/components/ParameterKvTable.tsx');
  const html = renderToStaticMarkup(
    React.createElement(ParameterKvTable, {
      entries: [
        ['thinking', nested],
        ['temperature', 0.3],
      ],
      parameterTypes: {},
      onCommitNew() {},
      onUpdate() {},
      onRemove() {},
      onTypeChange() {},
    }),
  );
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('table.objectHint'));
  assert.ok(html.includes('&quot;enabled&quot;'));
  assert.ok(html.includes('&quot;optional&quot;:null'));
  assert.ok(!html.includes('[object Object]'));
});

test('save IPC, disk reload and real OpenAI SDK HTTP requests preserve nested objects in all output modes', async () => {
  const {
    ConfigurationManager,
    configurationManager,
  } = require('../main/service/configurationManager.ts');
  const saved = await ipcHandlers.get('config-manager:save')(
    null,
    provider.id,
    configuration({
      thinking: nested,
      extra_body: { entries: [null, 0, false] },
    }),
  );
  assert.equal(saved.success, true);
  const reloaded = new ConfigurationManager();
  const config = await reloaded.getConfiguration(provider.id);
  assert.deepEqual(config.bodyParameters.thinking, nested);
  assert.deepEqual(
    (await configurationManager.getConfiguration(provider.id)).bodyParameters,
    config.bodyParameters,
  );
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'test',
        object: 'chat.completion',
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"0":"你好"}' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const translate = require('../main/service/openai.ts').default;
    for (const mode of ['disabled', 'json_object', 'json_schema']) {
      const result = await translate(
        'Hello',
        {
          ...provider,
          providerType: provider.type,
          apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
          customParameters: config,
          structuredOutput: mode,
        },
        'en',
        'zh',
        {
          responseJsonSchema: {
            type: 'object',
            properties: { 0: { type: 'string' } },
            required: ['0'],
            additionalProperties: false,
          },
        },
      );
      assert.equal(result, '{"0":"你好"}');
      const request = requests.at(-1);
      assert.equal(request.url, '/v1/chat/completions');
      assert.deepEqual(request.body.thinking, nested);
      assert.deepEqual(
        request.body.extra_body,
        config.bodyParameters.extra_body,
      );
      assert.ok(!('enable_thinking' in request.body));
      assert.equal(
        request.body.response_format?.type,
        mode === 'disabled' ? undefined : mode,
      );
    }
    assert.equal(requests.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
