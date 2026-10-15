'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
const repoRoot = path.resolve(__dirname, '..');

// Everything the translator logs ends up here instead of the Electron log store.
const logs = [];
// While the chain section loads the real fallback orchestration, `main/service`
// (every other translator) is replaced by this object.
let chainServices = null;

Module._load = function (request, parent, isMain) {
  const absolute =
    request.startsWith('.') && parent
      ? path.resolve(path.dirname(parent.filename), request)
      : '';
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => repoRoot,
        getPath: () => path.join(repoRoot, 'node_modules/.cache'),
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  if (/helpers\/storeManager$/.test(request)) {
    return {
      store: { get: () => undefined },
      logMessage: (message, type = 'info') => {
        logs.push({
          message: message instanceof Error ? message.message : String(message),
          type,
        });
      },
    };
  }
  if (chainServices && absolute === path.join(repoRoot, 'main/service')) {
    return chainServices;
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
      resolveJsonModule: true,
    },
  });
  module._compile(output.outputText, filename);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Protocol module: pure functions (no I/O, no logging)
// ---------------------------------------------------------------------------

const protocol = require('../main/service/googleFreeProtocol.ts');

const BASE = 'client=dict-chrome-ex&sl=en&tl=zh-CN';
const queryOf = (texts, sl = 'en', tl = 'zh-CN') =>
  protocol.buildChromeQuery(texts, sl, tl);
// Decodes without URLSearchParams, so the encoder is not checked by itself.
const decodeValue = (value) => decodeURIComponent(value.replace(/\+/g, ' '));
const qValues = (query) =>
  query
    .split('&')
    .filter((part) => part.startsWith('q='))
    .map((part) => decodeValue(part.slice(2)));

test('the query repeats q for every text and never uses q[]', () => {
  const query = queryOf(['One.', 'Two.', 'Three.']);
  assert.equal(query, `${BASE}&q=One.&q=Two.&q=Three.`);
  assert(!query.includes('q[]') && !query.includes('q%5B'));
});

test('the query keeps client, sl and tl in front and honours auto', () => {
  assert.equal(
    queryOf(['Hi.'], 'auto', 'ja'),
    'client=dict-chrome-ex&sl=auto&tl=ja&q=Hi.',
  );
  assert.equal(queryOf([]), BASE);
});

test('special characters survive the encoding', () => {
  const texts = [
    'a b&c#d+e%f',
    'line one\nline two',
    'I ❤️ you 😊',
    '- Hello.\n- Hi there.',
    '100% sure? =yes/no;',
  ];
  const query = queryOf(texts);
  assert.equal(
    query,
    `${BASE}&q=a+b%26c%23d%2Be%25f&q=line+one%0Aline+two&q=I+%E2%9D%A4%EF%B8%8F+you+%F0%9F%98%8A` +
      '&q=-+Hello.%0A-+Hi+there.&q=100%25+sure%3F+%3Dyes%2Fno%3B',
  );
  assert.deepEqual(qValues(query), texts);
});

test('a text is cut to 5,000 characters before it is sent', () => {
  const long = `${'x'.repeat(5000)}TAIL`;
  assert.deepEqual(qValues(queryOf([long])), ['x'.repeat(5000)]);
  assert.equal(protocol.prepareText('y'.repeat(5000)).length, 5000);
  assert.equal(protocol.prepareText('y'.repeat(4999)).length, 4999);
});

test('cutting never splits an emoji and lone surrogates are replaced', () => {
  const straddling = `${'a'.repeat(4999)}😀b`;
  const prepared = protocol.prepareText(straddling);
  assert.equal(prepared, 'a'.repeat(4999));
  assert.doesNotThrow(() => encodeURIComponent(prepared));

  const lone = protocol.prepareText('bad \ud83d surrogate \ude00 here');
  assert.equal(lone, 'bad \ufffd surrogate \ufffd here');
  assert.doesNotThrow(() => queryOf(['x \ud83d y']));
  assert.equal(protocol.prepareText('ok 😀 pair'), 'ok 😀 pair');
});

test('chunk planning keeps a short batch in one request and skips blank lines', () => {
  const chunks = protocol.planChromeChunks(
    ['One.', '', 'Two.', '   ', 'Three.'],
    'en',
    'zh-CN',
  );
  assert.deepEqual(chunks, [
    { indexes: [0, 2, 4], texts: ['One.', 'Two.', 'Three.'] },
  ]);
  assert.deepEqual(protocol.planChromeChunks([], 'en', 'zh-CN'), []);
  assert.deepEqual(
    protocol.planChromeChunks(['', '  ', '\n'], 'en', 'zh-CN'),
    [],
  );
});

test('a request holds at most 50 texts', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `Line ${i}.`);
  const chunks = protocol.planChromeChunks(lines, 'en', 'zh-CN');
  assert.deepEqual(
    chunks.map((chunk) => chunk.texts.length),
    [50, 50, 20],
  );
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.indexes),
    lines.map((_, i) => i),
    'order is kept',
  );
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.texts),
    lines,
  );
  assert.equal(
    protocol.planChromeChunks(lines.slice(0, 50), 'en', 'zh-CN').length,
    1,
  );
  assert.equal(
    protocol.planChromeChunks(lines.slice(0, 51), 'en', 'zh-CN').length,
    2,
  );
});

test('a request stays within 6,000 bytes of query string', () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `${String.fromCharCode(97 + i)}${'a'.repeat(2499)}`,
  );
  const chunks = protocol.planChromeChunks(lines, 'en', 'zh-CN');
  assert.equal(chunks.length, 10);
  for (const chunk of chunks) {
    assert.equal(chunk.texts.length, 2);
    assert(queryOf(chunk.texts).length <= 6000);
  }
});

test('the byte budget includes client, sl and tl and is inclusive', () => {
  const base = queryOf([]).length;
  const half = (6000 - base - 2 * '&q='.length) / 2;
  assert(Number.isInteger(half), 'the fixture sizes line up');
  const exact = ['a'.repeat(half), 'b'.repeat(half)];
  assert.equal(queryOf(exact).length, 6000);
  assert.equal(protocol.planChromeChunks(exact, 'en', 'zh-CN').length, 1);

  const over = ['a'.repeat(half), 'b'.repeat(half + 1)];
  assert.equal(queryOf(over).length, 6001);
  assert.equal(protocol.planChromeChunks(over, 'en', 'zh-CN').length, 2);

  // a longer language code eats into the budget
  const longer = protocol.planChromeChunks(exact, 'en', 'zh-CN-extra-long');
  assert.equal(longer.length, 2);
});

test('an oversize line goes out alone and is not split', () => {
  const big = '中'.repeat(780); // 780 * 9 = 7,020 encoded bytes
  assert(queryOf([big]).length > 7000);
  const chunks = protocol.planChromeChunks(
    ['Short one.', 'Short two.', big, 'Short three.'],
    'en',
    'zh-CN',
  );
  assert.deepEqual(chunks, [
    { indexes: [0, 1], texts: ['Short one.', 'Short two.'] },
    { indexes: [2], texts: [big] },
    { indexes: [3], texts: ['Short three.'] },
  ]);
});

test('texts in a chunk are the truncated ones that would be sent', () => {
  const chunks = protocol.planChromeChunks(
    ['a'.repeat(6000), 'next'],
    'en',
    'zh-CN',
  );
  assert.equal(chunks[0].texts[0].length, 5000);
});

test('responses with plain strings are accepted', () => {
  assert.deepEqual(protocol.parseChromeResponse(['一', '二'], 2), {
    ok: true,
    translations: ['一', '二'],
  });
});

test('responses with [text, language] pairs are accepted and the language is ignored', () => {
  assert.deepEqual(
    protocol.parseChromeResponse(
      [
        ['一', 'en'],
        ['二', 'fr'],
      ],
      2,
    ),
    { ok: true, translations: ['一', '二'] },
  );
  assert.deepEqual(protocol.parseChromeResponse([['一', 'en']], 1), {
    ok: true,
    translations: ['一'],
  });
});

test('a partly empty answer is kept, an all-empty one is rejected', () => {
  assert.deepEqual(protocol.parseChromeResponse(['一', ''], 2), {
    ok: true,
    translations: ['一', ''],
  });
  for (const data of [
    ['', ''],
    ['  ', '\n'],
    [
      ['', 'en'],
      ['', 'en'],
    ],
  ]) {
    const result = protocol.parseChromeResponse(data, 2);
    assert.equal(result.ok, false, JSON.stringify(data));
  }
});

test('a wrong count is a protocol failure without partial results', () => {
  for (const data of [['一'], ['一', '二', '三'], []]) {
    const result = protocol.parseChromeResponse(data, 2);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert(result.reason.length > 0);
    assert(!('translations' in result));
  }
});

test('anything that is not an array of strings or pairs is a protocol failure', () => {
  const bad = [
    undefined,
    null,
    'plain text',
    '<html><body>Sorry</body></html>',
    42,
    { error: 'nope' },
    [null, '二'],
    ['一', 2],
    ['一', {}],
    ['一', []],
    [[1, 'en'], '二'],
    [['一', 'en'], undefined],
  ];
  for (const data of bad) {
    const result = protocol.parseChromeResponse(data, 2);
    assert.equal(result.ok, false, JSON.stringify(data));
  }
});

const SORRY_PAGE =
  '<html><body>Our systems have detected unusual traffic from your computer network. ' +
  '<a href="/sorry/index?continue=x">About this page</a></body></html>';

test('429 and 403 with an abuse-page marker are blocked', () => {
  for (const status of [429, 403]) {
    assert.equal(protocol.isAbusePage(status, SORRY_PAGE), true);
    assert.equal(
      protocol.isAbusePage(status, 'sent by automated queries'),
      true,
    );
    assert.equal(
      protocol.isAbusePage(status, 'redirect to /sorry/index'),
      true,
    );
  }
});

test('marker matching ignores case and also reads parsed object bodies', () => {
  assert.equal(protocol.isAbusePage(429, 'UNUSUAL TRAFFIC detected'), true);
  assert.equal(protocol.isAbusePage(429, 'Automated Queries'), true);
  assert.equal(
    protocol.isAbusePage(429, {
      error: { message: 'detected unusual traffic from your network' },
    }),
    true,
  );
  assert.equal(protocol.isAbusePage(403, [{ note: 'see /SORRY/ page' }]), true);
});

test('a plain 429 or 403, other statuses and unreadable bodies are not blocked', () => {
  assert.equal(protocol.isAbusePage(429, 'Too many requests'), false);
  assert.equal(protocol.isAbusePage(403, 'Forbidden'), false);
  assert.equal(protocol.isAbusePage(200, SORRY_PAGE), false);
  assert.equal(protocol.isAbusePage(500, SORRY_PAGE), false);
  assert.equal(protocol.isAbusePage(undefined, SORRY_PAGE), false);
  assert.equal(protocol.isAbusePage(429, undefined), false);
  assert.equal(protocol.isAbusePage(429, null), false);
  const circular = {};
  circular.self = circular;
  assert.equal(protocol.isAbusePage(429, circular), false);
});

const TEST_TIMEOUT_MS = 20_000;

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              Object.assign(
                new Error(`timed out after ${TEST_TIMEOUT_MS} ms`),
                { timedOut: true },
              ),
            );
          }, TEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
      if (error.timedOut) {
        // A hung test leaves its mocks and fake clock behind, so the results
        // after it would be noise. A silent exit would also look like a pass.
        process.exit(1);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  require.extensions['.ts'] = originalTsLoader;
  Module._load = originalLoad;
  if (failed) {
    console.error(`${failed} of ${tests.length} google free tests failed`);
    process.exit(1);
  }
  console.log(`google free tests passed (${tests.length})`);
})();
