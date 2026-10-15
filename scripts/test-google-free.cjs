'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Network guard: these tests talk to a fake service only. Any socket to a
// non-loopback host, DNS lookup or fetch is recorded, refused, and fails the
// run at the end even if the code under test swallowed the refusal.
// ---------------------------------------------------------------------------

const net = require('node:net');
const dns = require('node:dns');

const networkViolations = [];
const isLoopback = (host) =>
  !host || host === 'localhost' || host === '::1' || /^127\./.test(host);
const refuse = (what) => {
  networkViolations.push(what);
  throw new Error(`network guard: ${what} is not allowed in unit tests`);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // normalized arguments
  const options =
    first && typeof first === 'object'
      ? first
      : { port: first, host: typeof args[1] === 'string' ? args[1] : '' };
  if (!options.path && !isLoopback(options.host)) {
    refuse(`connect ${options.host}:${options.port}`);
  }
  return originalConnect.apply(this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) refuse(`DNS lookup of ${hostname}`);
  return originalLookup.call(this, hostname, ...rest);
};
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromiseLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) refuse(`DNS lookup of ${hostname}`);
  return originalPromiseLookup.call(this, hostname, ...rest);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input) {
  refuse(`fetch ${typeof input === 'string' ? input : input?.url}`);
};

// Everything the translator logs ends up here instead of the Electron log store.
const logs = [];
// A test can set this to make a log call misbehave (an unexpected internal error).
let onLog = null;
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
        const entry = {
          message: message instanceof Error ? message.message : String(message),
          type,
        };
        logs.push(entry);
        if (onLog) onLog(entry);
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

// Every item of a chunk answers a non-blank input, and the service returns the input itself for
// lines it cannot translate (♪, ..., {\an8}), so an empty item is a degraded answer, not a result.
// A live smoke on 2026-10-15 got 8 empty items out of 20 once; the other 12 were correct.
test('a response with any empty item is rejected as a whole', () => {
  for (const [name, data] of Object.entries({
    'one of two': ['一', ''],
    'first of two': ['', '二'],
    'all empty': ['', ''],
    'whitespace only': ['一', '  \n'],
    'pair with empty text': [
      ['一', 'en'],
      ['', 'en'],
    ],
  })) {
    const result = protocol.parseChromeResponse(data, 2);
    assert.equal(result.ok, false, name);
    assert(!('translations' in result), `${name}: no partial result`);
  }
  const partly = protocol.parseChromeResponse(['一', '', '三', ''], 4);
  assert.equal(partly.reason, '2 of 4 translations are empty');
  assert.doesNotMatch(partly.reason, /一|三/, 'the reason carries counts only');
});

// The lane asks again only when the rejection is about empty items: a degraded answer that the
// same request is expected to fix. A wrong count or shape is structural and goes straight to gtx.
test('a rejection that is only about empty items says how many items are empty', () => {
  assert.equal(
    protocol.parseChromeResponse(['一', '', '三', ''], 4).emptyItems,
    2,
  );
  assert.equal(protocol.parseChromeResponse(['', ''], 2).emptyItems, 2);
  assert.equal(
    protocol.parseChromeResponse(
      [
        ['一', 'en'],
        ['  ', 'en'],
      ],
      2,
    ).emptyItems,
    1,
  );
});

test('count, shape and non-array rejections never claim empty items', () => {
  for (const [name, data, expected] of [
    ['wrong count', ['一'], 2],
    ['wrong count that also has an empty item', ['一', ''], 3],
    ['not an array', '<html></html>', 2],
    ['bad item shape', ['一', 5], 2],
    ['bad item shape beside an empty item', ['', 5], 2],
  ]) {
    const result = protocol.parseChromeResponse(data, expected);
    assert.equal(result.ok, false, name);
    assert.equal(result.emptyItems, 0, name);
  }
});

test('a response without empty items is still accepted', () => {
  assert.deepEqual(protocol.parseChromeResponse(['一', '♪', '...'], 3), {
    ok: true,
    translations: ['一', '♪', '...'],
  });
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

// ---------------------------------------------------------------------------
// Translator: a fake service that answers like the two real endpoints
// ---------------------------------------------------------------------------

const axios = require('axios');
const { isTaskCancelledError } = require('../main/helpers/taskContext.ts');
const { isConfigurationError } = require('../main/translate/utils/error.ts');
const {
  TRANSLATION_REQUEST_TIMEOUT,
} = require('../main/translate/constants/index.ts');
const { convertLanguageCode } = require('../main/helpers/utils.ts');
const rateLimiter = require('../main/translate/utils/rateLimiter.ts');
const google = require('../main/service/googleFree.ts');

const googleFree = google.default;
const gt = google.__test__;

const CHROME_URL = 'https://translate.googleapis.com/translate_a/t';
const GTX_URL = 'https://translate.googleapis.com/translate_a/single';
const BODY_MARKER = 'BODY-MARKER-5522';
const SORRY_BODY =
  '<html><body>Our systems have detected unusual traffic from your computer network. ' +
  `<a href="/sorry/index?continue=x">About this page</a> ${BODY_MARKER}</body></html>`;

const httpError = (status, data) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
const canceledError = () =>
  Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
const timeoutError = () =>
  Object.assign(new Error('timeout of 15000ms exceeded'), {
    code: 'ECONNABORTED',
  });
// A handler returns undefined (default answer), { data } or { throws }.
const blocked = (status = 429) => ({ throws: httpError(status, SORRY_BODY) });
const failing = (status = 500) => ({ throws: httpError(status, 'oops') });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultChrome = (request) =>
  request.sl === 'auto'
    ? request.texts.map((text) => [`C:${text}`, 'en'])
    : request.texts.map((text) => `C:${text}`);
const defaultGtx = (request) => [
  [[`G:${request.texts[0]}`, request.texts[0], null, null, 10]],
  null,
  'en',
];

function installFakeGoogle() {
  const saved = { get: axios.get };
  const log = { requests: [] };
  const server = {
    log,
    events: [],
    chrome: null,
    gtx: null,
    of: (lane) => log.requests.filter((request) => request.lane === lane),
    restore() {
      axios.get = saved.get;
    },
  };

  axios.get = async (url, config = {}) => {
    const parsed = new URL(url);
    const endpoint = `${parsed.origin}${parsed.pathname}`;
    const params = new URLSearchParams(parsed.search);
    for (const [key, value] of Object.entries(config.params || {})) {
      params.append(key, String(value));
    }
    const lane =
      endpoint === CHROME_URL ? 'chrome' : endpoint === GTX_URL ? 'gtx' : null;
    if (!lane) throw new Error(`unexpected GET ${url}`);
    const request = {
      lane,
      url,
      config,
      at: Date.now(),
      search: parsed.search,
      client: params.get('client'),
      sl: params.get('sl'),
      tl: params.get('tl'),
      texts: params.getAll('q'),
    };
    log.requests.push(request);
    server.events.push(`request:${lane}`);
    if (config.signal?.aborted) throw canceledError();

    const custom = server[lane] ? await server[lane](request) : undefined;
    if (custom !== undefined) {
      if (custom.throws) throw custom.throws;
      return { status: 200, data: custom.data };
    }
    return {
      status: 200,
      data: lane === 'chrome' ? defaultChrome(request) : defaultGtx(request),
    };
  };
  return server;
}

let providerCounter = 0;
const nextProof = (extra = {}) => ({
  id: `google-test-${(providerCounter += 1)}`,
  ...extra,
});
const call = (query, { from = 'en', to = 'zh', proof, options } = {}) =>
  googleFree(query, proof || nextProof(), from, to, options);

async function withServer(fn) {
  gt.reset();
  logs.length = 0;
  onLog = null;
  const server = installFakeGoogle();
  try {
    await fn(server);
  } finally {
    server.restore();
    onLog = null;
    gt.reset();
  }
}

function useFakeClock() {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  return {
    advance(ms) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

// `assert.rejects` matches a RegExp against "Error: <message>", so NETWORK_ERROR is not
// anchored; NETWORK_PREFIX and rejectsMessage check the message itself.
const NETWORK_ERROR = /Google free translate failed \(network\)/;
const NETWORK_PREFIX = /^Google free translate failed \(network\)/;
const rejectsMessage = (fn, pattern) =>
  assert.rejects(fn, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
const MINUTE = 60_000;
const lines = (count, prefix = 'Line') =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}.`);
const coolFor = (lane) => gt.laneState(lane).coolUntil - Date.now();

// -- lanes: the structure and the fixed order ---------------------------------

test('the module exports its availability hook and test helpers', () => {
  assert.equal(typeof google.getGoogleFreeAvailability, 'function');
  assert.equal(typeof google.__test__?.reset, 'function');
  assert.equal(typeof google.__test__?.laneState, 'function');
});

test('a healthy chrome lane translates a batch in one request and gtx is never asked', () =>
  withServer(async (server) => {
    const batch = [
      "I can't believe you did that.",
      'Where are we going tomorrow?',
      'Please close the door.',
      'Okay.',
      'Thank you.',
    ];
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
    );
    assert.equal(server.log.requests.length, 1);
    const [request] = server.log.requests;
    assert.equal(request.lane, 'chrome');
    assert.equal(request.client, 'dict-chrome-ex');
    assert.equal(request.sl, 'en');
    assert.equal(request.tl, convertLanguageCode('zh', 'google'));
    assert.deepEqual(request.texts, batch);
    assert(!request.search.includes('q[]') && !request.search.includes('q%5B'));
    assert.equal(server.of('gtx').length, 0);
  }));

test('a string query returns a string', () =>
  withServer(async () => {
    assert.equal(await call('Hello world.'), 'C:Hello world.');
  }));

test('line breaks inside a text survive on both lanes', () =>
  withServer(async (server) => {
    assert.deepEqual(await call(['Hello\nWorld']), ['C:Hello\nWorld']);
    gt.reset();
    server.chrome = () => blocked();
    assert.deepEqual(await call(['Hello\nWorld']), ['G:Hello\nWorld']);
  }));

test('special characters reach the service exactly as written', () =>
  withServer(async (server) => {
    const texts = [
      'a b&c#d+e%f',
      'line one\nline two',
      'I ❤️ you 😊',
      '- Hello.\n- Hi there.',
      '100% sure? =yes/no;',
    ];
    assert.deepEqual(
      await call(texts),
      texts.map((text) => `C:${text}`),
    );
    assert.deepEqual(server.log.requests[0].texts, texts);
  }));

test('blank lines are not sent and keep their place', () =>
  withServer(async (server) => {
    assert.deepEqual(await call(['One.', '', 'Two.', '   ', 'Three.']), [
      'C:One.',
      '',
      'C:Two.',
      '   ',
      'C:Three.',
    ]);
    assert.deepEqual(server.log.requests[0].texts, ['One.', 'Two.', 'Three.']);
  }));

test('a batch of only blank lines sends nothing', () =>
  withServer(async (server) => {
    assert.deepEqual(await call(['', '  ', '\n']), ['', '  ', '\n']);
    assert.equal(await call(''), '');
    assert.deepEqual(await call([]), []);
    assert.equal(server.log.requests.length, 0);
  }));

test('a text longer than 5,000 characters is cut before it is sent on both lanes', () =>
  withServer(async (server) => {
    const long = `${'x'.repeat(5000)}TAIL`;
    await call([long]);
    assert.equal(server.log.requests[0].lane, 'chrome');
    assert.deepEqual(server.log.requests[0].texts, ['x'.repeat(5000)]);
    gt.reset();
    server.log.requests.length = 0;
    server.chrome = () => blocked();
    await call([long]);
    assert.deepEqual(server.of('gtx')[0].texts, ['x'.repeat(5000)]);
  }));

test('a long batch is split into requests of at most 50 texts', () =>
  withServer(async (server) => {
    const batch = lines(120);
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
    );
    assert.deepEqual(
      server.of('chrome').map((request) => request.texts.length),
      [50, 50, 20],
    );
    assert.deepEqual(
      server.of('chrome').flatMap((request) => request.texts),
      batch,
    );
  }));

test('long texts are split by the byte budget', () =>
  withServer(async (server) => {
    const batch = Array.from(
      { length: 20 },
      (_, i) => `${i}${'a'.repeat(2499)}`,
    );
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
    );
    assert.equal(server.of('chrome').length, 10);
    for (const request of server.of('chrome')) {
      assert.equal(request.texts.length, 2);
      assert(request.url.length - CHROME_URL.length - 1 <= 6000);
    }
  }));

test('an empty or auto source language asks the service to detect it', () =>
  withServer(async (server) => {
    for (const from of ['', 'auto']) {
      server.log.requests.length = 0;
      assert.deepEqual(await call(['Hello.', 'Bye.'], { from }), [
        'C:Hello.',
        'C:Bye.',
      ]);
      assert.equal(server.log.requests[0].sl, 'auto');
    }
    server.chrome = () => blocked();
    gt.reset();
    server.log.requests.length = 0;
    assert.deepEqual(await call(['Hello.'], { from: 'auto' }), ['G:Hello.']);
    assert.equal(server.of('gtx')[0].sl, 'auto');
  }));

test('an unsupported target language fails before any request', () =>
  withServer(async (server) => {
    await rejectsMessage(
      () => call(['Hello.'], { to: 'yue' }),
      /^not supported language$/,
    );
    assert.equal(server.log.requests.length, 0);
    assert.equal(
      isConfigurationError(new Error('not supported language')),
      true,
    );
  }));

// -- switching lanes -------------------------------------------------------------

test('a blocked chrome lane hands the chunk to gtx, line by line', () =>
  withServer(async (server) => {
    server.chrome = () => blocked();
    const batch = ['One.', 'Two.', 'Three.'];
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `G:${text}`),
    );
    assert.equal(server.of('chrome').length, 1);
    assert.equal(server.of('gtx').length, 3);
    for (const request of server.of('gtx')) {
      // exactly the request the old per-line implementation sent
      assert.equal(request.url, GTX_URL);
      assert.deepEqual(request.config.params, {
        client: 'gtx',
        sl: 'en',
        tl: convertLanguageCode('zh', 'google'),
        dt: 't',
        q: request.texts[0],
      });
      assert.equal(request.texts.length, 1);
    }
    assert(gt.laneState('chrome').coolUntil > 0, 'chrome is cooling down');
  }));

test('a block in the middle of a call sends the rest of the call to gtx without asking chrome', () =>
  withServer(async (server) => {
    let chromeCalls = 0;
    server.chrome = () => ((chromeCalls += 1) === 2 ? blocked() : undefined);
    const batch = lines(120);
    const result = await call(batch);
    assert.deepEqual(
      result.slice(0, 50),
      batch.slice(0, 50).map((t) => `C:${t}`),
    );
    assert.deepEqual(
      result.slice(50),
      batch.slice(50).map((t) => `G:${t}`),
    );
    assert.equal(server.of('chrome').length, 2, 'the third chunk skips chrome');
    assert.equal(server.of('gtx').length, 70);
  }));

test('chrome serves everything while gtx is blocked and gtx is never asked', () =>
  withServer(async (server) => {
    server.gtx = () => blocked();
    const batch = lines(120);
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
    );
    assert.equal(server.of('gtx').length, 0);
    assert.equal(gt.laneState('chrome').coolUntil, 0);
    assert.equal(gt.laneState('gtx').coolUntil, 0);
  }));

test('a wrong count or a bad shape sends the whole chunk to gtx without asking chrome again', () =>
  withServer(async (server) => {
    const answers = {
      'wrong count': () => ({ data: ['只有一条'] }),
      'html page': () => ({ data: '<html><body>hello</body></html>' }),
      'json object': () => ({ data: { error: 'nope' } }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      gt.reset();
      server.log.requests.length = 0;
      server.chrome = answer;
      const batch = ['One.', 'Two.', 'Three.'];
      assert.deepEqual(
        await call(batch),
        batch.map((text) => `G:${text}`),
        name,
      );
      assert.equal(server.of('chrome').length, 1, name);
      assert.equal(server.of('gtx').length, 3, name);
      assert.equal(gt.laneState('chrome').failures, 1, name);
      assert.equal(
        gt.laneState('chrome').coolUntil,
        0,
        `${name}: not cooling yet`,
      );
    }
  }));

// Empty items are the one rejection that is asked for again: the glitch of 2026-10-15 did not come
// back when the same 20 lines were sent five more times.
test('an answer that stays degraded after the second ask sends the whole chunk to gtx as one failure', () =>
  withServer(async (server) => {
    const answers = {
      'all empty': (request) => ({ data: request.texts.map(() => '') }),
      'one empty': (request) => ({
        data: request.texts.map((text, i) => (i === 1 ? '' : `C:${text}`)),
      }),
      'one blank': (request) => ({
        data: request.texts.map((text, i) => (i === 2 ? ' \n' : `C:${text}`)),
      }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      gt.reset();
      server.log.requests.length = 0;
      server.chrome = answer;
      const batch = ['One.', 'Two.', 'Three.'];
      assert.deepEqual(
        await call(batch),
        batch.map((text) => `G:${text}`),
        name,
      );
      assert.equal(
        server.of('chrome').length,
        2,
        `${name}: asked once more, not twice`,
      );
      assert.equal(server.of('gtx').length, 3, name);
      assert.equal(
        gt.laneState('chrome').failures,
        1,
        `${name}: one failure, not two`,
      );
      assert.equal(
        gt.laneState('chrome').coolUntil,
        0,
        `${name}: not cooling yet`,
      );
    }
  }));

test('a degraded answer is asked for again once and the clean second answer is used', () =>
  withServer(async (server) => {
    // the shape of the live observation: 8 empty answers among 20, the rest fine
    const emptyAt = new Set([6, 7, 9, 12, 13, 16, 17, 19]);
    let asked = 0;
    server.chrome = (request) => {
      asked += 1;
      return asked === 1
        ? {
            data: request.texts.map((text, i) =>
              emptyAt.has(i) ? '' : `C:${text}`,
            ),
          }
        : undefined; // the default, clean answer
    };
    const batch = lines(20);
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
      'every line comes from the second answer',
    );
    assert.equal(server.of('chrome').length, 2);
    assert.equal(server.of('gtx').length, 0);
    const [first, second] = server.of('chrome');
    assert.equal(second.url, first.url, 'the same request is sent again');
    assert.equal(gt.laneState('chrome').failures, 0);
    assert.equal(gt.laneState('chrome').coolUntil, 0);
    assert.deepEqual(logs, [], 'asking again writes no log line');
  }));

test('every chunk gets its own second ask', () =>
  withServer(async (server) => {
    // 60 lines are two chunks (50 + 10); asks 1 and 3 are degraded, asks 2 and 4 are clean
    let asked = 0;
    server.chrome = (request) => {
      asked += 1;
      return asked % 2 === 1
        ? {
            data: request.texts.map((text, i) => (i === 0 ? '' : `C:${text}`)),
          }
        : undefined;
    };
    const batch = lines(60);
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `C:${text}`),
    );
    assert.equal(server.of('chrome').length, 4);
    assert.equal(server.of('gtx').length, 0);
    assert.equal(gt.laneState('chrome').failures, 0);
  }));

test('the second ask is preceded by an acquire on the shared key', () =>
  withServer(async (server) => {
    const realAcquire = rateLimiter.acquire;
    rateLimiter.acquire = async (key, cfg, signal) => {
      server.events.push(`acquire:${key}`);
      return realAcquire(key, cfg, signal);
    };
    try {
      const proof = nextProof();
      let asked = 0;
      server.chrome = (request) => {
        asked += 1;
        return asked === 1 ? { data: request.texts.map(() => '') } : undefined;
      };
      await call(['One.', 'Two.'], { proof });
      const key = `acquire:googleFree:${proof.id}`;
      assert.deepEqual(server.events, [
        key,
        'request:chrome',
        key,
        'request:chrome',
      ]);
    } finally {
      rateLimiter.acquire = realAcquire;
    }
  }));

test('cancelling while the second ask waits for the rate limiter stops it without a failure', () =>
  withServer(async (server) => {
    const controller = new AbortController();
    const proof = nextProof({ requestInterval: 1 });
    server.chrome = (request) => {
      setTimeout(() => controller.abort(), 100);
      return { data: request.texts.map(() => '') };
    };
    const started = Date.now();
    await assert.rejects(
      () =>
        call(['One.', 'Two.'], {
          proof,
          options: { signal: controller.signal },
        }),
      (error) => isTaskCancelledError(error),
    );
    assert(Date.now() - started < 700, 'did not wait out the interval');
    assert.equal(server.of('chrome').length, 1, 'the second ask is not sent');
    assert.equal(server.of('gtx').length, 0, 'no fallback after a cancel');
    assert.equal(gt.laneState('chrome').failures, 0);
    assert.equal(gt.laneState('chrome').coolUntil, 0);
  }));

test('a second ask that fails counts as the one failure of the chunk', () =>
  withServer(async (server) => {
    let asked = 0;
    server.chrome = (request) => {
      asked += 1;
      return asked === 1 ? { data: request.texts.map(() => '') } : failing(500);
    };
    const batch = ['One.', 'Two.'];
    assert.deepEqual(
      await call(batch),
      batch.map((text) => `G:${text}`),
    );
    assert.equal(server.of('chrome').length, 2);
    assert.equal(server.of('gtx').length, 2);
    assert.equal(gt.laneState('chrome').failures, 1);
  }));

test('a second ask that is blocked cools the lane as a block', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      let asked = 0;
      server.chrome = (request) => {
        asked += 1;
        return asked === 1 ? { data: request.texts.map(() => '') } : blocked();
      };
      const batch = ['One.', 'Two.'];
      assert.deepEqual(
        await call(batch),
        batch.map((text) => `G:${text}`),
      );
      assert.equal(server.of('chrome').length, 2);
      assert.equal(gt.laneState('chrome').level, 1);
      assert.equal(coolFor('chrome'), 10 * MINUTE);
      const warnings = logs.filter((entry) => entry.type === 'warning');
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0].message,
        /chrome lane blocked, cooling down for 600 s/,
      );
    } finally {
      clock.restore();
    }
  }));

test('a probe whose first answer is degraded recovers the lane when the second ask is clean', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      clock.advance(10 * MINUTE + 1000);
      const before = server.of('chrome').length;
      let asked = 0;
      server.chrome = (request) => {
        asked += 1;
        return asked === 1 ? { data: request.texts.map(() => '') } : undefined;
      };
      assert.deepEqual(await call(['Back.']), ['C:Back.']);
      assert.equal(server.of('chrome').length - before, 2);
      assert.equal(gt.laneState('chrome').coolUntil, 0);
      assert.equal(gt.laneState('chrome').probing, false);
      const recovered = logs.filter((entry) =>
        /chrome lane recovered/.test(entry.message),
      );
      assert.equal(recovered.length, 1);
    } finally {
      clock.restore();
    }
  }));

test('a probe whose second ask is degraded too fails once, cools for 120 s and keeps the block level', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      clock.advance(10 * MINUTE + 1000);
      const before = server.of('chrome').length;
      server.chrome = (request) => ({ data: request.texts.map(() => '') });
      assert.deepEqual(await call(['Two.']), ['G:Two.']);
      assert.equal(server.of('chrome').length - before, 2);
      assert.equal(coolFor('chrome'), 120_000);
      assert.equal(gt.laneState('chrome').level, 1);
      assert.equal(gt.laneState('chrome').probing, false);
    } finally {
      clock.restore();
    }
  }));

test('the probe slot is held until the second ask ends', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      clock.advance(10 * MINUTE + 1000);

      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let asked = 0;
      server.chrome = (request) => {
        asked += 1;
        if (asked === 1) return { data: request.texts.map(() => '') };
        return gate.then(() => undefined); // answered cleanly once released
      };
      const probe = call(['Probe.']);
      // the blocked call + the probe's two asks; bounded, so a missing second ask fails fast
      for (let i = 0; i < 200 && server.of('chrome').length < 3; i += 1) {
        await sleep(5);
      }
      assert.equal(server.of('chrome').length, 3, 'the probe asked twice');
      // chrome is still held by the probe: another call goes straight to gtx
      assert.deepEqual(await call(['Other.']), ['G:Other.']);
      assert.equal(server.of('chrome').length, 3);
      release();
      assert.deepEqual(await probe, ['C:Probe.']);
      assert.equal(gt.laneState('chrome').coolUntil, 0);
    } finally {
      clock.restore();
    }
  }));

test('a batch answered with some empty lines never reaches the output as empty lines', () =>
  withServer(async (server) => {
    // the shape of the live observation: 8 empty answers among 20, the rest fine, both times
    const emptyAt = new Set([6, 7, 9, 12, 13, 16, 17, 19]);
    server.chrome = (request) => ({
      data: request.texts.map((text, i) => (emptyAt.has(i) ? '' : `C:${text}`)),
    });
    const batch = lines(20);
    const result = await call(batch);
    assert.deepEqual(
      result,
      batch.map((text) => `G:${text}`),
      'the whole chunk is translated again, line by line',
    );
    assert(
      result.every((line) => line.trim() !== ''),
      'no empty line is returned',
    );
    assert.equal(server.of('chrome').length, 2, 'asked once more, not twice');
    assert.equal(server.of('gtx').length, 20);
  }));

test('a batch answered with some empty lines fails the call when gtx is blocked, instead of returning them', () =>
  withServer(async (server) => {
    server.chrome = (request) => ({
      data: request.texts.map((text, i) => (i % 3 === 0 ? '' : `C:${text}`)),
    });
    server.gtx = () => blocked();
    await rejectsMessage(() => call(lines(6)), NETWORK_PREFIX);
  }));

test('when gtx fails halfway the chunk fails and chrome is not asked again', () =>
  withServer(async (server) => {
    server.chrome = () => blocked();
    let gtxCalls = 0;
    server.gtx = () => ((gtxCalls += 1) === 3 ? failing(500) : undefined);
    await assert.rejects(
      () => call(['One.', 'Two.', 'Three.', 'Four.']),
      NETWORK_ERROR,
    );
    assert.equal(server.of('chrome').length, 1);
    assert.equal(server.of('gtx').length, 3);
    assert.equal(gt.laneState('gtx').failures, 1);
  }));

test('both lanes failing is a network-class error without partial results', () =>
  withServer(async (server) => {
    server.chrome = () => failing(500);
    server.gtx = () => failing(500);
    await assert.rejects(
      () => call(['One.', 'Two.']),
      (error) => {
        assert.match(error.message, NETWORK_PREFIX);
        assert.match(
          error.message,
          /chrome lane: HTTP 500; gtx lane: HTTP 500/,
        );
        assert.equal(isConfigurationError(error), false);
        return true;
      },
    );
    // 403 and 429 abuse pages would read like authentication errors without the prefix
    gt.reset();
    server.chrome = () => blocked(403);
    server.gtx = () => blocked(429);
    await assert.rejects(
      () => call(['One.', 'Two.']),
      (error) => {
        assert.match(error.message, NETWORK_PREFIX);
        assert.match(error.message, /403/);
        assert.equal(isConfigurationError(error), false);
        return true;
      },
    );
  }));

test('with both lanes cooling down nothing is sent and the error says when to retry', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      server.gtx = () => blocked();
      await assert.rejects(() => call(['One.']), NETWORK_ERROR);
      const before = server.log.requests.length;
      await rejectsMessage(
        () => call(['Two.']),
        /^Google free translate failed \(network\): temporarily unavailable \(both lanes cooling down, retry in 600 s\)$/,
      );
      clock.advance(100_000);
      await assert.rejects(() => call(['Three.']), /retry in 500 s\)$/);
      assert.equal(
        server.log.requests.length,
        before,
        'no request while cooling',
      );
    } finally {
      clock.restore();
    }
  }));

// -- lane health --------------------------------------------------------------------

test('a blocked answer cools the lane for 10 minutes straight away', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      assert.equal(coolFor('chrome'), 10 * MINUTE);
      assert.equal(gt.laneState('chrome').level, 1);
      assert.equal(gt.laneState('chrome').failures, 0);
      const before = server.of('chrome').length;
      await call(['Two.']);
      await call(['Three.']);
      assert.equal(
        server.of('chrome').length,
        before,
        'no request while cooling',
      );
    } finally {
      clock.restore();
    }
  }));

test('requests that are blocked together count as one block, not two', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      server.chrome = async () => {
        await gate;
        return blocked();
      };
      // two calls are in flight on chrome when Google answers both with a block
      const first = call(['One.']);
      const second = call(['Two.']);
      await sleep(20);
      assert.equal(server.of('chrome').length, 2, 'both were in flight');
      release();
      assert.deepEqual(await first, ['G:One.']);
      assert.deepEqual(await second, ['G:Two.']);
      assert.equal(gt.laneState('chrome').level, 1);
      assert.equal(coolFor('chrome'), 10 * MINUTE);
      assert.equal(
        logs.filter((entry) => /chrome lane blocked/.test(entry.message))
          .length,
        1,
      );
    } finally {
      clock.restore();
    }
  }));

test('every further block doubles the cooldown up to 60 minutes', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      assert.equal(coolFor('chrome'), 10 * MINUTE);
      for (const minutes of [20, 40, 60, 60, 60]) {
        clock.advance(coolFor('chrome') + 1000);
        await call(['Probe.']);
        assert.equal(coolFor('chrome'), minutes * MINUTE, `${minutes} min`);
      }
    } finally {
      clock.restore();
    }
  }));

test('a 429 or 403 without the abuse-page marker is an ordinary failure', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      let status = 429;
      server.chrome = () => ({
        throws: httpError(status, 'Too many requests'),
      });
      await call(['One.']);
      assert.equal(gt.laneState('chrome').coolUntil, 0);
      assert.equal(gt.laneState('chrome').failures, 1);
      status = 403;
      await call(['Two.']);
      assert.equal(gt.laneState('chrome').coolUntil, 0);
      assert.equal(gt.laneState('chrome').failures, 2);
      await call(['Three.']);
      assert.equal(coolFor('chrome'), 120_000);
      assert.equal(gt.laneState('chrome').level, 0, 'not a block');
      assert.equal(server.of('chrome').length, 3);
    } finally {
      clock.restore();
    }
  }));

test('three timeouts in a row cool the lane for 120 seconds', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => ({ throws: timeoutError() });
      for (let i = 0; i < 3; i += 1) await call(['One.']);
      assert.equal(coolFor('chrome'), 120_000);
      await call(['Four.']);
      assert.equal(server.of('chrome').length, 3, 'cooling, not asked');

      // a failed probe cools it down again for 120 s
      clock.advance(121_000);
      await call(['Probe.']);
      assert.equal(server.of('chrome').length, 4);
      assert.equal(coolFor('chrome'), 120_000);
    } finally {
      clock.restore();
    }
  }));

test('a success in between resets the failure count', () =>
  withServer(async (server) => {
    const handler = (request) =>
      request.texts[0] === 'ok' ? undefined : failing(500);
    server.chrome = handler;
    await call(['bad']);
    await call(['bad']);
    assert.equal(gt.laneState('chrome').failures, 2);
    await call(['ok']);
    assert.equal(gt.laneState('chrome').failures, 0);
    await call(['bad']);
    await call(['bad']);
    assert.equal(gt.laneState('chrome').failures, 2);
    assert.equal(gt.laneState('chrome').coolUntil, 0);
  }));

test('after the cooldown only one call probes the lane', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      clock.advance(10 * MINUTE + 1000);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      server.chrome = async () => {
        await gate;
        return undefined;
      };
      const chromeBefore = server.of('chrome').length;
      const probing = call(['Probe.']);
      await sleep(20);
      assert.equal(gt.laneState('chrome').probing, true);
      assert.deepEqual(await call(['Other.']), ['G:Other.']);
      assert.equal(
        server.of('chrome').length,
        chromeBefore + 1,
        'only the probe reached chrome',
      );
      release();
      assert.deepEqual(await probing, ['C:Probe.']);
      assert.deepEqual(
        { ...gt.laneState('chrome') },
        { failures: 0, level: 0, coolUntil: 0, probing: false },
      );
    } finally {
      clock.restore();
    }
  }));

test('a successful probe brings chrome back and the recovery is logged once', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      clock.advance(10 * MINUTE + 1000);
      server.chrome = null;
      assert.deepEqual(await call(['Back.']), ['C:Back.']);
      assert.deepEqual(await call(['Again.']), ['C:Again.']);
      const recovered = logs.filter((entry) =>
        /chrome lane recovered/.test(entry.message),
      );
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].type, 'info');
      assert.equal(gt.laneState('chrome').level, 0);
    } finally {
      clock.restore();
    }
  }));

test('cancelling a probe is not a failure and frees the probe slot', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      const coolUntil = gt.laneState('chrome').coolUntil;
      clock.advance(10 * MINUTE + 1000);

      const controller = new AbortController();
      server.chrome = () => {
        controller.abort();
        return { throws: canceledError() };
      };
      await assert.rejects(
        () => call(['Probe.'], { options: { signal: controller.signal } }),
        (error) => isTaskCancelledError(error),
      );
      const state = gt.laneState('chrome');
      assert.equal(state.probing, false);
      assert.equal(state.failures, 0);
      assert.equal(state.level, 1, 'the backoff level is untouched');
      assert.equal(state.coolUntil, coolUntil, 'the cooldown is not extended');

      server.chrome = null;
      assert.deepEqual(await call(['Probe again.']), ['C:Probe again.']);
      assert.equal(gt.laneState('chrome').coolUntil, 0);
    } finally {
      clock.restore();
    }
  }));

test('a probe that fails after a block cools the lane for 120 s and keeps the block level', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['One.']);
      assert.equal(gt.laneState('chrome').failures, 0);
      clock.advance(10 * MINUTE + 1000);

      // the probe meets an ordinary failure: one failure is enough to cool a probe
      server.chrome = () => failing(500);
      assert.deepEqual(await call(['Two.']), ['G:Two.']);
      assert.equal(coolFor('chrome'), 120_000);
      assert.equal(gt.laneState('chrome').level, 1);
      assert.equal(gt.laneState('chrome').probing, false);

      // chrome is left alone until the 120 s have passed
      const chromeBefore = server.of('chrome').length;
      assert.deepEqual(await call(['Three.']), ['G:Three.']);
      assert.equal(server.of('chrome').length, chromeBefore);
    } finally {
      clock.restore();
    }
  }));

test('availability follows the lanes: one usable lane is enough', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      assert.deepEqual(google.getGoogleFreeAvailability(), { available: true });

      server.chrome = () => blocked();
      await call(['One.']);
      assert.deepEqual(google.getGoogleFreeAvailability(), { available: true });

      // chrome has 300 s left when gtx fails three times and cools for 120 s
      clock.advance(300_000);
      server.gtx = () => ({ throws: timeoutError() });
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => call(['Two.']), NETWORK_ERROR);
      }
      assert.equal(coolFor('chrome'), 300_000);
      assert.equal(coolFor('gtx'), 120_000);
      assert.deepEqual(google.getGoogleFreeAvailability(), {
        available: false,
        retryAfterMs: 120_000,
      });
      await rejectsMessage(
        () => call(['Blocked.']),
        /\(both lanes cooling down, retry in 120 s\)$/,
      );

      // gtx is ready for a probe: available again, and a probe in flight is not
      clock.advance(121_000);
      assert.deepEqual(google.getGoogleFreeAvailability(), { available: true });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      server.gtx = async () => {
        await gate;
        return undefined;
      };
      const probing = call(['Three.']);
      await sleep(20);
      assert.deepEqual(google.getGoogleFreeAvailability(), {
        available: false,
        retryAfterMs: 0,
      });
      release();
      assert.deepEqual(await probing, ['G:Three.']);
      assert.deepEqual(google.getGoogleFreeAvailability(), { available: true });
    } finally {
      clock.restore();
    }
  }));

test('lane state lives in memory and starts clean', () =>
  withServer(async (server) => {
    server.chrome = () => blocked();
    await call(['One.']);
    assert(gt.laneState('chrome').coolUntil > 0);
    gt.reset();
    for (const lane of ['chrome', 'gtx']) {
      assert.deepEqual(
        { ...gt.laneState(lane) },
        { failures: 0, level: 0, coolUntil: 0, probing: false },
      );
    }
  }));

// -- rate limit, timeouts, cancellation -------------------------------------------

test('every HTTP request on both lanes is preceded by an acquire on the shared key', () =>
  withServer(async (server) => {
    const realAcquire = rateLimiter.acquire;
    rateLimiter.acquire = async (key, cfg, signal) => {
      server.events.push(`acquire:${key}`);
      return realAcquire(key, cfg, signal);
    };
    try {
      const proof = nextProof();
      server.chrome = () => blocked();
      await call(['One.', 'Two.', 'Three.'], { proof });
      const key = `acquire:googleFree:${proof.id}`;
      assert.deepEqual(server.events, [
        key,
        'request:chrome',
        key,
        'request:gtx',
        key,
        'request:gtx',
        key,
        'request:gtx',
      ]);
    } finally {
      rateLimiter.acquire = realAcquire;
    }
  }));

test('the provider id is part of the rate key and defaults to googleFree', () =>
  withServer(async (server) => {
    const realAcquire = rateLimiter.acquire;
    const keys = [];
    rateLimiter.acquire = async (key, cfg, signal) => {
      keys.push(key);
      return realAcquire(key, cfg, signal);
    };
    try {
      await googleFree(['One.'], {}, 'en', 'zh');
      await googleFree(['One.'], { id: 'googleFree' }, 'en', 'zh');
      assert.deepEqual(keys, [
        'googleFree:googleFree',
        'googleFree:googleFree',
      ]);
    } finally {
      rateLimiter.acquire = realAcquire;
    }
  }));

test('requests on both lanes respect the provider request interval', () =>
  withServer(async (server) => {
    const proof = nextProof({ requestInterval: 0.06 });
    server.chrome = () => blocked();
    await call(['One.', 'Two.'], { proof });
    const times = server.log.requests.map((request) => request.at);
    assert.equal(times.length, 3, 'one chrome request, two gtx requests');
    for (let i = 1; i < times.length; i += 1) {
      assert(
        times[i] - times[i - 1] >= 50,
        `gap ${i}: ${times[i] - times[i - 1]}ms`,
      );
    }
  }));

test('chrome has a 15 s timeout and gtx keeps the global one', () =>
  withServer(async (server) => {
    server.chrome = () => blocked();
    await call(['One.']);
    assert.equal(server.of('chrome')[0].config.timeout, 15_000);
    assert.equal(
      server.of('gtx')[0].config.timeout,
      TRANSLATION_REQUEST_TIMEOUT,
    );
    assert.equal(TRANSLATION_REQUEST_TIMEOUT, 60_000);
  }));

test('requests use the two known clients, one User-Agent and no extra headers', () =>
  withServer(async (server) => {
    server.chrome = (request) =>
      request.texts[0] === 'second' ? blocked() : undefined;
    await call(['first']);
    await call(['second']);
    assert.deepEqual(
      [...new Set(server.log.requests.map((request) => request.client))].sort(),
      ['dict-chrome-ex', 'gtx'],
    );
    const agents = new Set();
    for (const request of server.log.requests) {
      assert.deepEqual(Object.keys(request.config.headers), ['User-Agent']);
      agents.add(request.config.headers['User-Agent']);
    }
    assert.equal(agents.size, 1);
    assert.match([...agents][0], /^Mozilla\/5\.0 .*Chrome\//);
  }));

test('a call that is already cancelled never reaches the network', () =>
  withServer(async (server) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => call(['Hello.'], { options: { signal: controller.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert.equal(server.log.requests.length, 0);
  }));

test('cancelling during a request ends the call and is not a failure', () =>
  withServer(async (server) => {
    const controller = new AbortController();
    let seenSignal;
    server.chrome = (request) => {
      seenSignal = request.config.signal;
      controller.abort();
      return { throws: canceledError() };
    };
    await assert.rejects(
      () => call(['Hello.'], { options: { signal: controller.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert.equal(
      seenSignal,
      controller.signal,
      'the signal reaches the request',
    );
    assert.equal(server.of('gtx').length, 0, 'no fallback after a cancel');
    assert.equal(gt.laneState('chrome').failures, 0);
    assert.equal(gt.laneState('chrome').coolUntil, 0);
  }));

test('an answer that arrives after the cancellation is dropped', () =>
  withServer(async (server) => {
    const late = new AbortController();
    server.chrome = () => {
      late.abort();
      return undefined;
    };
    await assert.rejects(
      () => call(['Hello.'], { options: { signal: late.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert.equal(gt.laneState('chrome').failures, 0);
  }));

test('cancelling while the rate limiter waits stops the next request', () =>
  withServer(async (server) => {
    const controller = new AbortController();
    const proof = nextProof({ requestInterval: 1 });
    server.chrome = () => {
      setTimeout(() => controller.abort(), 100);
      return undefined;
    };
    const started = Date.now();
    await assert.rejects(
      () => call(lines(60), { proof, options: { signal: controller.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert(Date.now() - started < 700, 'did not wait out the interval');
    assert.equal(server.of('chrome').length, 1);
  }));

// -- errors and privacy -----------------------------------------------------------

test('an unexpected internal error is still reported as a network-class failure', () =>
  withServer(async (server) => {
    server.chrome = () => blocked();
    onLog = (entry) => {
      if (/cooling down/.test(entry.message)) {
        throw new TypeError('internal boom');
      }
    };
    await assert.rejects(
      () => call(['One.']),
      (error) => {
        assert.match(
          error.message,
          /^Google free translate failed \(network\).*internal boom/,
        );
        assert.equal(isConfigurationError(error), false);
        return true;
      },
    );
    assert(gt.laneState('chrome').coolUntil > 0, 'the state was still updated');
  }));

test('logs and errors never contain subtitle text, translations, URLs or response bodies', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      const marker = 'ZXQ-MARKER-7731';
      const messages = [];
      const capture = async (promise) => {
        try {
          await promise;
        } catch (error) {
          messages.push(error.message);
        }
      };
      server.chrome = () => blocked();
      await capture(call([`${marker} one.`, `${marker} two.`]));
      server.gtx = () => failing(500);
      await capture(call([`${marker} three.`]));
      gt.reset();
      server.chrome = () => blocked(403);
      server.gtx = () => blocked();
      await capture(call([`${marker} four.`]));
      clock.advance(11 * MINUTE);
      server.chrome = null;
      server.gtx = null;
      await capture(call([`${marker} five.`]));

      const everything = [
        ...logs.map((entry) => entry.message),
        ...messages,
      ].join('\n');
      assert(logs.length > 0 && messages.length > 0, 'something was logged');
      for (const secret of [
        marker,
        BODY_MARKER,
        'translate_a',
        'googleapis',
        'dict-chrome-ex',
        'client=',
        'q=',
        'Sorry',
      ]) {
        assert(!everything.includes(secret), `leaked: ${secret}`);
      }
    } finally {
      clock.restore();
    }
  }));

test('a lane change is logged once, not once per batch', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      await call(['First.']);
      for (let i = 0; i < 20; i += 1) await call([`Batch ${i}.`]);
      const entered = logs.filter((entry) =>
        /chrome lane blocked, cooling down for 600 s/.test(entry.message),
      );
      assert.equal(entered.length, 1);
      assert.equal(entered[0].type, 'warning');
      assert.equal(
        logs.filter((entry) => /chrome lane/.test(entry.message)).length,
        1,
      );
      assert.equal(
        logs.filter((entry) => /gtx lane/.test(entry.message)).length,
        0,
      );

      clock.advance(11 * MINUTE);
      server.chrome = null;
      await call(['Back.']);
      for (let i = 0; i < 5; i += 1) await call([`Later ${i}.`]);
      assert.equal(
        logs.filter((entry) => /chrome lane recovered/.test(entry.message))
          .length,
        1,
      );
    } finally {
      clock.restore();
    }
  }));

test('ordinary failures log their cooldown once and classify it as a failure', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => ({ throws: timeoutError() });
      for (let i = 0; i < 6; i += 1) await call(['One.']);
      const entries = logs.filter((entry) =>
        /chrome lane failure, cooling down for 120 s/.test(entry.message),
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0].type, 'warning');
    } finally {
      clock.restore();
    }
  }));

// ---------------------------------------------------------------------------
// autoFree chain: the real fallback orchestration with fake sibling sources, so
// skipping a cooling Google and using it again after recovery run end to end.
// ---------------------------------------------------------------------------

const siblingCalls = [];
const fakeSibling = (name) => async (list) => {
  siblingCalls.push({ name, list });
  return list.map((item) => `${name}:${item}`);
};
chainServices = {
  youdaoFreeTranslator: fakeSibling('youdao'),
  bingFreeTranslator: fakeSibling('bing'),
  googleFreeTranslator: googleFree,
  deeplxTranslator: fakeSibling('deeplx'),
};
const {
  createFallbackTranslator,
} = require('../main/translate/services/fallback.ts');
chainServices = null;

const chainProof = {
  id: 'autoFree',
  fallbackChain: 'googleFree,deeplx',
  apiUrl: 'http://127.0.0.1:1188/translate',
};
const autoFree = createFallbackTranslator(['googleFree', 'deeplx']);
const runChain = (list, proof = chainProof) =>
  autoFree(list, proof, 'en', 'zh');
const attemptedSources = () =>
  logs
    .filter((entry) => entry.message.startsWith('autoFree trying source: '))
    .map((entry) => entry.message.slice('autoFree trying source: '.length));

test('autoFree skips Google without a request while both lanes cool down and uses it again after recovery', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      siblingCalls.length = 0;
      server.chrome = () => blocked();
      server.gtx = () => blocked();

      // both lanes fail on this batch: Google is tried, fails, deeplx answers
      assert.deepEqual(await runChain(['Hello.']), ['deeplx:Hello.']);
      assert(
        logs.some(
          (entry) =>
            entry.type === 'warning' &&
            /^autoFree source googleFree failed: Google free translate failed \(network\)/.test(
              entry.message,
            ),
        ),
      );

      // now both lanes cool down: skipped quietly, no request
      const before = server.log.requests.length;
      logs.length = 0;
      assert.deepEqual(await runChain(['Hello again.']), [
        'deeplx:Hello again.',
      ]);
      assert.equal(
        server.log.requests.length,
        before,
        'no request while cooling',
      );
      const skip = logs.find((entry) =>
        entry.message.startsWith('autoFree skip googleFree'),
      );
      assert(skip, 'the skip is logged');
      assert.equal(skip.type, 'info');
      assert.match(
        skip.message,
        /^autoFree skip googleFree: cooling down \(retry in 600 s\)$/,
      );
      assert.deepEqual(attemptedSources(), ['deeplx']);

      // recovery: the cooldown ends, the probe succeeds and Google is used again
      clock.advance(10 * MINUTE + 1000);
      server.chrome = null;
      server.gtx = null;
      logs.length = 0;
      assert.deepEqual(await runChain(['Back.']), ['C:Back.']);
      assert.deepEqual(attemptedSources(), ['googleFree']);
      assert(!logs.some((entry) => /fell back/.test(entry.message)));
    } finally {
      clock.restore();
    }
  }));

test('autoFree keeps using Google while one lane still works', () =>
  withServer(async (server) => {
    const clock = useFakeClock();
    try {
      server.chrome = () => blocked();
      assert.deepEqual(await runChain(['One.']), ['G:One.']);
      logs.length = 0;
      assert.deepEqual(await runChain(['Two.']), ['G:Two.']);
      assert.deepEqual(attemptedSources(), ['googleFree']);
      assert(!logs.some((entry) => entry.message.startsWith('autoFree skip')));
    } finally {
      clock.restore();
    }
  }));

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
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  dns.promises.lookup = originalPromiseLookup;
  globalThis.fetch = originalFetch;
  if (networkViolations.length) {
    console.error(
      `not ok - the tests touched the network: ${networkViolations.join(', ')}`,
    );
    failed += 1;
  }
  if (failed) {
    console.error(`${failed} of ${tests.length} google free tests failed`);
    process.exit(1);
  }
  console.log(`google free tests passed (${tests.length})`);
})();
