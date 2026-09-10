'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
const axios = require('axios');

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.ts'] = function transpile(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
    },
  });
  module._compile(output.outputText, filename);
};

const bing = require('../main/service/bingFree.ts').default;
const bingTest = require('../main/service/bingFree.ts').__test__;
const deeplx = require('../main/service/deeplx.ts').default;
const deeplxTest = require('../main/service/deeplx.ts').__test__;

const session = (ig, iid, key, token) =>
  `TranslatorWebTelemetry.init({"ig":"${ig}"}); var params_AbusePreventionHelper = [${key},"${token}",3600000]; <div data-iid="${iid}">`;

async function testBingUsesCurrentWebProtocol() {
  bingTest.resetSession();
  const requests = [];
  const savedGet = axios.get;
  const savedPost = axios.post;
  axios.get = async () => ({
    data: session('A1B2C3', 'translator.5023', 123, 'token-1'),
  });
  axios.post = async (url, body, config) => {
    requests.push({ url, body, config });
    const form = new URLSearchParams(body);
    return {
      data: [
        {
          translations: [
            { text: `translated:${form.get('text')}`, to: form.get('to') },
          ],
        },
      ],
    };
  };

  try {
    const result = await bing(
      ['Hello', 'How are you?'],
      { id: 'bingFree-test' },
      'en',
      'zh',
    );
    assert.deepEqual(result, ['translated:Hello', 'translated:How are you?']);
    assert.equal(requests.length, 2);
    assert(
      requests.every(({ url }) => url === 'https://www.bing.com/ttranslatev3'),
    );
    const form = new URLSearchParams(requests[0].body);
    assert.equal(form.get('fromLang'), 'en');
    assert.equal(form.get('to'), 'zh-Hans');
    assert.equal(form.get('key'), '123');
    assert.equal(form.get('token'), 'token-1');
    assert.equal(requests[0].config.params.IID, 'translator.5023');
    assert.equal(requests[0].config.params.IG, 'A1B2C3');
    assert.equal(
      requests[0].config.headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );

    bingTest.resetSession();
    requests.length = 0;
    await bing('Hello', { id: 'bing-auto-test' }, 'auto', 'zh');
    assert.equal(
      new URLSearchParams(requests[0].body).get('fromLang'),
      'auto-detect',
    );
  } finally {
    axios.get = savedGet;
    axios.post = savedPost;
  }
}

async function testBingRefreshesExpiredSession() {
  bingTest.resetSession();
  let pageRequests = 0;
  let translationRequests = 0;
  const savedGet = axios.get;
  const savedPost = axios.post;
  axios.get = async () => {
    pageRequests += 1;
    return {
      data:
        pageRequests === 1
          ? session('AABBCC', 'translator.5023', 1, 'expired')
          : session('DDEEFF', 'translator.5023', 2, 'fresh'),
    };
  };
  axios.post = async (_url, _body, config) => {
    translationRequests += 1;
    if (translationRequests === 1) {
      return { data: { statusCode: 205 } };
    }
    assert.equal(config.params.IG, 'DDEEFF');
    return { data: [{ translations: [{ text: 'ok' }] }] };
  };

  try {
    assert.equal(
      await bing('Hello', { id: 'bing-refresh-test' }, 'en', 'zh'),
      'ok',
    );
    assert.equal(pageRequests, 2);
    assert.equal(translationRequests, 2);
  } finally {
    axios.get = savedGet;
    axios.post = savedPost;
  }
}

async function testDeepLXResponseShapesAnd429() {
  assert.equal(deeplxTest.getTranslationText({ data: 'legacy' }), 'legacy');
  assert.equal(
    deeplxTest.getTranslationText({ translations: [{ text: 'v2' }] }),
    'v2',
  );

  const savedPost = axios.post;
  const requests = [];
  axios.post = async (url, body, config) => {
    requests.push({ url, body, config });
    return { data: { translations: [{ text: '你好' }] } };
  };
  try {
    assert.deepEqual(
      await deeplx(
        ['Hello', 'World'],
        { id: 'deeplx-test', apiUrl: 'http://127.0.0.1:1188/translate' },
        'en',
        'zh',
      ),
      ['你好', '你好'],
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'http://127.0.0.1:1188/translate');
    assert.deepEqual(requests[0].body, {
      text: 'Hello',
      source_lang: 'EN',
      target_lang: 'ZH',
    });
    assert.deepEqual(
      deeplxTest.buildRequestBody(
        'http://127.0.0.1:1188/v2/translate/',
        'Hello',
        'EN',
        'ZH',
      ),
      { text: ['Hello'], source_lang: 'EN', target_lang: 'ZH' },
    );
  } finally {
    axios.post = savedPost;
  }

  axios.post = async () => {
    const error = new Error('Request failed with status code 429');
    error.response = { status: 429, data: { message: 'too many requests' } };
    throw error;
  };
  try {
    await assert.rejects(
      () =>
        deeplx(
          'Hello',
          { id: 'deeplx-429-test', apiUrl: 'http://127.0.0.1:1188/translate' },
          'en',
          'zh',
        ),
      /DeepLX rate limited.*HTTP 429/,
    );
  } finally {
    axios.post = savedPost;
  }
}

Promise.resolve()
  .then(testBingUsesCurrentWebProtocol)
  .then(testBingRefreshesExpiredSession)
  .then(testDeepLXResponseShapesAnd429)
  .then(() => console.log('free translator tests passed (3)'))
  .finally(() => {
    require.extensions['.ts'] = originalTsLoader;
    Module._load = originalLoad;
  });
