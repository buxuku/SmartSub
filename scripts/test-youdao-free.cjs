'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
const repoRoot = path.resolve(__dirname, '..');
const noop = () => {};

// Everything the translator logs ends up here instead of the Electron log store.
const logs = [];
// A test can set this to make a log call misbehave (an unexpected internal error).
let onLog = null;
// While the chain section loads the real fallback orchestration and provider
// registry, `main/service` (every other translator) is replaced by this object.
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
  if (absolute === path.join(repoRoot, 'main/helpers/store')) {
    return { store: { get: () => undefined } };
  }
  if (absolute === path.join(repoRoot, 'main/helpers/glossaryManager')) {
    return {
      getActiveGlossaryResolution: noop,
      getTaskGlossaryResolution: noop,
      logGlossaryConflicts: noop,
      logGlossaryMatches: noop,
    };
  }
  if (absolute === path.join(repoRoot, 'main/helpers/fileUtils')) {
    return { ensureTempDir: noop };
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

const text = require('../main/service/youdaoFreeText.ts');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Plans a cue and returns what would be sent, so tests read like the spec.
const sent = (cue) => text.planCue(cue).paragraphs.map((p) => p.send);
// Plans a cue and restores it with the given translations.
const roundTrip = (cue, translations) =>
  text.restoreCue(text.planCue(cue), translations);

// ---------------------------------------------------------------------------
// Text handling: skip rule, lead/trail markers, brackets
// ---------------------------------------------------------------------------

test('lines without letters are kept and never sent', () => {
  for (const cue of ['...', '10:30', '♪', '[...]', '<i>♪</i>', '— —']) {
    const plan = text.planCue(cue);
    assert.deepEqual(plan.paragraphs, [], `nothing to send for ${cue}`);
    assert.equal(text.restoreCue(plan, []), cue);
  }
});

test('HTML tags wrapping a whole line are stripped and restored in place', () => {
  assert.deepEqual(sent("<i>Don't look back.</i>"), ["Don't look back."]);
  assert.equal(
    roundTrip("<i>Don't look back.</i>", ['不要回头看。']),
    '<i>不要回头看。</i>',
  );
  assert.equal(
    roundTrip('<b><i>Run!</i></b>', ['快跑！']),
    '<b><i>快跑！</i></b>',
  );
});

test('ASS override blocks in front of the text are restored in place', () => {
  assert.deepEqual(sent('{\\an8}Run!'), ['Run!']);
  assert.equal(roundTrip('{\\an8}Run!', ['快跑！']), '{\\an8}快跑！');
});

test('music notes at the edges are kept and only the lyric is translated', () => {
  assert.deepEqual(sent('♪ Never gonna give you up ♪'), [
    'Never gonna give you up',
  ]);
  assert.equal(
    roundTrip('♪ Never gonna give you up ♪', ['永远不会放弃你']),
    '♪ 永远不会放弃你 ♪',
  );
});

test('whole-line brackets keep their type and only the inside is translated', () => {
  assert.deepEqual(sent('[door slams]'), ['door slams']);
  assert.equal(roundTrip('[door slams]', ['关门声']), '[关门声]');
  assert.deepEqual(sent('(laughing)'), ['laughing']);
  assert.equal(roundTrip('(laughing)', ['笑']), '(笑)');
});

test('a bracket inside a longer line is left to the service', () => {
  assert.deepEqual(sent('[phone ringing] Hello?'), ['[phone ringing] Hello?']);
  assert.deepEqual(sent('(laughing) Stop it!'), ['(laughing) Stop it!']);
});

test('dialogue dashes are removed before sending and restored per line', () => {
  assert.deepEqual(sent('- Hello.\n- Hi there.'), ['Hello.', 'Hi there.']);
  assert.equal(
    roundTrip('- Hello.\n- Hi there.', ['你好。', '嗨。']),
    '- 你好。\n- 嗨。',
  );
  assert.equal(
    roundTrip('-Hello.\n–Hi there.', ['你好。', '嗨。']),
    '-你好。\n–嗨。',
  );
});

test('dashes in the translation are not stacked on top of the restored dash', () => {
  assert.equal(
    roundTrip('- Hello.\n- Hi there.', ['- 你好。', '- - 嗨。']),
    '- 你好。\n- 嗨。',
  );
});

test('lines without letters stay in place between translated lines', () => {
  const plan = text.planCue('Stop!\n...\nPut it down.');
  assert.deepEqual(
    plan.paragraphs.map((p) => p.send),
    ['Stop!', 'Put it down.'],
  );
  assert.equal(
    text.restoreCue(plan, ['停下！', '放下它。']),
    '停下！\n...\n放下它。',
  );
});

// ---------------------------------------------------------------------------
// Paragraph building
// ---------------------------------------------------------------------------

test('a sentence cut by a hard line break is translated as one paragraph', () => {
  assert.deepEqual(sent('I think we should\ngo home now.'), [
    'I think we should go home now.',
  ]);
  assert.equal(
    roundTrip('I think we should\ngo home now.', ['我想我们该回家了。']),
    '我想我们该回家了。',
  );
});

test('CJK continuations are joined without inserting a space', () => {
  assert.deepEqual(sent('我觉得我们应该\n回家了。'), [
    '我觉得我们应该回家了。',
  ]);
});

test('finished sentences and effect lines stay on their own lines', () => {
  assert.deepEqual(sent('Stop!\nPut it down.'), ['Stop!', 'Put it down.']);
  assert.deepEqual(sent('[phone ringing]\nHello?'), [
    'phone ringing',
    'Hello?',
  ]);
  assert.deepEqual(sent('Really?!\nYes.'), ['Really?!', 'Yes.']);
  assert.equal(
    roundTrip('Stop!\nPut it down.', ['停下！', '放下它。']),
    '停下！\n放下它。',
  );
});

test('closing quotes after the final punctuation still end the sentence', () => {
  assert.deepEqual(sent('He said "Stop."\nThen left.'), [
    'He said "Stop."',
    'Then left.',
  ]);
});

test('a dash line may continue onto a plain second line', () => {
  assert.deepEqual(sent('- I think we should\ngo home.\n- Fine.'), [
    'I think we should go home.',
    'Fine.',
  ]);
  assert.equal(
    roundTrip('- I think we should\ngo home.\n- Fine.', [
      '我们该回家了。',
      '好吧。',
    ]),
    '- 我们该回家了。\n- 好吧。',
  );
});

test('a merged paragraph uses the first line lead and the last line trail', () => {
  assert.equal(
    roundTrip('<i>I think we should\ngo home now.</i>', ['我想我们该回家了。']),
    '<i>我想我们该回家了。</i>',
  );
});

// ---------------------------------------------------------------------------
// Tag pairing
// ---------------------------------------------------------------------------

test('inline emphasis tags are dropped from the text', () => {
  assert.deepEqual(sent('He said <i>never</i> again.'), [
    'He said never again.',
  ]);
  assert.equal(
    roundTrip('He said <i>never</i> again.', ['他说再也不会了。']),
    '他说再也不会了。',
  );
});

test('a leading tag whose partner sits mid-line is dropped together with it', () => {
  assert.deepEqual(sent('<i>Hello</i> there.'), ['Hello there.']);
  assert.equal(roundTrip('<i>Hello</i> there.', ['你好呀。']), '你好呀。');
  assert.equal(
    roundTrip('{\\i1}Run{\\i0} away', ['快跑开']),
    '快跑开',
    'ASS toggles pair the same way',
  );
});

test('positioning blocks are restored even when an emphasis tag is dropped', () => {
  assert.equal(
    roundTrip('{\\an8}<i>Hello</i> there.', ['你好呀。']),
    '{\\an8}你好呀。',
  );
});

test('a tag whose partner is in another cue keeps the source shape', () => {
  assert.equal(roundTrip('<i>Line one', ['第一行']), '<i>第一行');
  assert.equal(roundTrip('Line two</i>', ['第二行']), '第二行</i>');
});

test('tags that pair across lines of one cue stay balanced', () => {
  assert.equal(
    roundTrip('<i>Stop!\nPut it down.</i>', ['停下！', '放下它。']),
    '<i>停下！\n放下它。</i>',
  );
});

// ---------------------------------------------------------------------------
// Echo comparison and Chinese post-processing
// ---------------------------------------------------------------------------

test('echo normalization ignores width, spacing and punctuation differences', () => {
  assert.equal(
    text.normalizeEcho('Hello, world!'),
    text.normalizeEcho('Hello，world！'),
  );
  assert.equal(text.normalizeEcho('(8) Go.'), text.normalizeEcho('（８） Go.'));
  assert.notEqual(
    text.normalizeEcho('Hello world'),
    text.normalizeEcho('Hello there'),
  );
});

test('Chinese output: trailing newline, punctuation next to Han and full-width digits', () => {
  const n = text.normalizeChineseTranslation;
  assert.equal(n('你好。\n'), '你好。');
  assert.equal(n('跑!'), '跑！');
  assert.equal(n('你好,世界?好:对;'), '你好，世界？好：对；');
  assert.equal(n('（８）号'), '（8）号');
  assert.equal(n('OK, 好的'), 'OK, 好的', 'punctuation not touching Han stays');
  assert.equal(n('共1,000人'), '共1,000人', 'digit separators stay');
  assert.equal(n('现在10:30'), '现在10:30');
  assert.equal(n('Hello!'), 'Hello!');
});

// ---------------------------------------------------------------------------
// Language mapping (live-probed 2026-10-13: every supportedLanguage code was
// tried as source and as target; codes the service rejects both ways are null)
// ---------------------------------------------------------------------------

test('youdao language column keeps only live-verified languages', () => {
  const {
    supportedLanguage,
    convertLanguageCode,
  } = require('../main/helpers/utils.ts');
  const verified = new Set([
    'zh',
    'zh-Hant',
    'en',
    'ja',
    'ko',
    'fr',
    'de',
    'es',
    'ru',
    'pt',
    'it',
    'nl',
    'hi',
    'th',
    'vi',
    'id',
    'ar',
  ]);
  for (const { value } of supportedLanguage) {
    const mapped = convertLanguageCode(value, 'youdao');
    if (verified.has(value)) {
      assert.equal(typeof mapped, 'string', `${value} should be supported`);
    } else {
      assert.equal(mapped, null, `${value} should map to null`);
    }
  }
  assert.equal(convertLanguageCode('zh', 'youdao'), 'zh-CHS');
  assert.equal(convertLanguageCode('zh-Hant', 'youdao'), 'zh-CHT');
  assert.equal(convertLanguageCode('en', 'youdao'), 'en');
  assert.equal(convertLanguageCode('tr', 'youdao'), null);
});

// ---------------------------------------------------------------------------
// Translator: a fake service that behaves like the real one (verifies the
// signature, answers with a decoy when it is wrong, wants the visitor cookie
// for multi-paragraph requests) so the tests exercise the real protocol.
// ---------------------------------------------------------------------------

const axios = require('axios');
const crypto = require('node:crypto');
const { isTaskCancelledError } = require('../main/helpers/taskContext.ts');
const youdao = require('../main/service/youdaoFree.ts');

const youdaoFree = youdao.default;
const yt = youdao.__test__;

const md5hex = (value) => crypto.createHash('md5').update(value).digest('hex');
const md5buf = (value) => crypto.createHash('md5').update(value).digest();

const VISITOR_COOKIE = 'OUTFOX_SEARCH_USER_ID=-1234567@203.0.113.7';
const PROBE_TEXT = 'Hello\nThank you';
const DECOY_TEXT = 'unrelated decoy sentence';

let providerCounter = 0;
const nextProof = (extra = {}) => ({
  id: `youdao-test-${(providerCounter += 1)}`,
  ...extra,
});
const call = (query, { to = 'zh', from = 'en', proof, options } = {}) =>
  youdaoFree(query, proof || nextProof(), from, to, options);

const withNewline = (value, index, total) =>
  index < total - 1 ? `${value}\n` : value;

// What the service returns for a valid request.
const defaultPayload = (paragraphs) => ({
  code: 0,
  type: 'en2zh-CHS',
  translateResult: paragraphs.map((paragraph, index) => {
    const src = withNewline(paragraph, index, paragraphs.length);
    if (paragraphs.join('\n') === PROBE_TEXT) {
      return [{ tgt: index === 0 ? '你好\n' : '谢谢你！', src }];
    }
    return [
      {
        tgt: withNewline(`T:${paragraph}`, index, paragraphs.length),
        src,
      },
    ];
  }),
});

// What the service returns when it dislikes the request: code 0, unrelated
// text and a flat translateResult instead of paragraphs of sentences.
const decoyPayload = (paragraphs) => ({
  code: 0,
  type: 'en2zh-CHS',
  translateResult: paragraphs.map((src) => ({ tgt: DECOY_TEXT, src })),
});

const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
const canceledError = () =>
  Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });

function installFakeYoudao({ issueCookie = true } = {}) {
  const key = {
    secretKey: 'unit-test-secret-0123456789abcdef',
    aesKey: 'unit-test-aes-key',
    aesIv: 'unit-test-aes-iv',
  };
  const log = { pages: [], keys: [], translations: [] };
  const saved = { get: axios.get, post: axios.post };
  const encrypt = (payload) => {
    const cipher = crypto.createCipheriv(
      'aes-128-cbc',
      md5buf(key.aesKey),
      md5buf(key.aesIv),
    );
    return Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]).toString('base64url');
  };
  // A test sets `respond` to take over an answer: return a payload object,
  // `{ raw }` for an arbitrary body, `{ throws }` for a transport error, or
  // undefined to keep the default behaviour.
  const server = {
    key,
    log,
    respond: null,
    restore() {
      axios.get = saved.get;
      axios.post = saved.post;
    },
  };

  axios.get = async (url, config = {}) => {
    if (url === 'https://fanyi.youdao.com/') {
      log.pages.push({ config });
      return {
        status: 200,
        headers: issueCookie
          ? { 'set-cookie': [`${VISITOR_COOKIE}; Domain=.youdao.com; Path=/`] }
          : {},
        data: '<html></html>',
      };
    }
    if (url === 'https://dict.youdao.com/webtranslate/key') {
      log.keys.push({ params: config.params, config });
      return { status: 200, data: { code: 0, msg: 'OK', data: key } };
    }
    throw new Error(`unexpected GET ${url}`);
  };

  axios.post = async (url, body, config = {}) => {
    assert.equal(url, 'https://dict.youdao.com/webtranslate');
    const form = new URLSearchParams(body);
    const text = form.get('i');
    const paragraphs = text.split('\n');
    const request = {
      form,
      config,
      text,
      paragraphs,
      at: Date.now(),
    };
    log.translations.push(request);
    if (config.signal?.aborted) throw canceledError();

    const expectedSign = md5hex(
      `client=${form.get('client')}&mysticTime=${form.get('mysticTime')}` +
        `&product=${form.get('product')}&key=${key.secretKey}`,
    );
    if (form.get('sign') !== expectedSign || form.get('keyid') !== 'webfanyi') {
      return { status: 200, data: encrypt(decoyPayload(paragraphs)) };
    }
    if (paragraphs.length > 1 && config.headers?.Cookie !== VISITOR_COOKIE) {
      return { status: 200, data: encrypt({ code: 50 }) };
    }
    const custom = server.respond ? await server.respond(request) : undefined;
    if (custom !== undefined) {
      if (custom.throws) throw custom.throws;
      if (custom.raw !== undefined) return { status: 200, data: custom.raw };
      return { status: 200, data: encrypt(custom) };
    }
    return { status: 200, data: encrypt(defaultPayload(paragraphs)) };
  };
  return server;
}

async function withServer(options, fn) {
  yt.reset();
  logs.length = 0;
  const server = installFakeYoudao(options);
  try {
    await fn(server);
  } finally {
    server.restore();
    yt.reset();
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

const realRequests = (server) =>
  server.log.translations.filter((request) => request.text !== PROBE_TEXT);
const NETWORK_ERROR = /Youdao free translate failed \(network\)/;

test('requests follow the web client protocol', () =>
  withServer({}, async (server) => {
    assert.deepEqual(await call(['Hello world.']), ['T:Hello world.']);

    assert.equal(server.log.pages.length, 1);
    assert.equal(server.log.keys.length, 1);
    const keyParams = server.log.keys[0].params;
    assert.equal(keyParams.keyid, 'webfanyi-key-getter-2025');
    assert.equal(
      keyParams.sign,
      md5hex(
        `client=fanyideskweb&mysticTime=${keyParams.mysticTime}` +
          `&product=webfanyi&key=${yt.KEY_GETTER_SECRET}`,
      ),
    );

    assert.equal(server.log.translations.length, 2, 'probe + one request');
    const [probe, request] = server.log.translations;
    assert.equal(probe.text, PROBE_TEXT);
    assert.equal(request.text, 'Hello world.');
    assert.equal(request.form.get('from'), 'en');
    assert.equal(request.form.get('to'), 'zh-CHS');
    assert.equal(request.form.get('keyid'), 'webfanyi');
    assert.equal(request.config.headers.Cookie, VISITOR_COOKIE);
    assert.equal(
      request.config.headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );
    assert.equal(request.config.timeout, 15000);
  }));

test('credentials are built once, shared by concurrent calls and rebuilt after 30 minutes', () =>
  withServer({}, async (server) => {
    const clock = useFakeClock();
    try {
      await Promise.all([call(['One.']), call(['Two.'])]);
      assert.equal(server.log.pages.length, 1);
      assert.equal(server.log.keys.length, 1);
      assert.equal(
        server.log.translations.filter((r) => r.text === PROBE_TEXT).length,
        1,
      );

      await call(['Three.']);
      clock.advance(29 * 60 * 1000);
      await call(['Four.']);
      assert.equal(server.log.pages.length, 1, 'reused inside the cap');

      clock.advance(2 * 60 * 1000);
      await call(['Five.']);
      assert.equal(server.log.pages.length, 2, 'rebuilt after the cap');
      assert.equal(server.log.keys.length, 2);
    } finally {
      clock.restore();
    }
  }));

test('the visitor cookie is the one the site issued and is never fabricated', () =>
  withServer({ issueCookie: false }, async (server) => {
    await assert.rejects(() => call(['Hello world.']), NETWORK_ERROR);
    assert(
      server.log.translations.every(
        (r) => r.config.headers?.Cookie === undefined,
      ),
      'no cookie header was invented',
    );
    assert.equal(server.log.translations.length, 1, 'only the probe went out');
  }));

test('a decoy answer to the probe stops the call before subtitle text is sent', () =>
  withServer({}, async (server) => {
    server.respond = (request) =>
      request.text === PROBE_TEXT
        ? decoyPayload(request.paragraphs)
        : undefined;
    await assert.rejects(
      () => call(['Secret subtitle line.']),
      /Youdao free translate failed \(network\).*probe/i,
    );
    assert.deepEqual(
      server.log.translations.map((r) => r.text),
      [PROBE_TEXT],
    );
  }));

test('a probe answered with the wrong words fails the session', () =>
  withServer({}, async (server) => {
    server.respond = (request) =>
      request.text === PROBE_TEXT
        ? {
            code: 0,
            translateResult: [
              [{ tgt: '苹果\n', src: 'Hello\n' }],
              [{ tgt: '香蕉', src: 'Thank you' }],
            ],
          }
        : undefined;
    await assert.rejects(() => call(['Hello world.']), /probe/i);
    assert.deepEqual(
      server.log.translations.map((r) => r.text),
      [PROBE_TEXT],
    );
  }));

test('code 50 rebuilds the credentials and retries once', () =>
  withServer({}, async (server) => {
    let failed = false;
    server.respond = (request) => {
      if (request.text !== PROBE_TEXT && !failed) {
        failed = true;
        return { code: 50 };
      }
      return undefined;
    };
    assert.deepEqual(await call(['Hello world.']), ['T:Hello world.']);
    assert.equal(server.log.pages.length, 2);
    assert.equal(server.log.keys.length, 2);
    assert.deepEqual(
      server.log.translations.map((r) => r.text),
      [PROBE_TEXT, 'Hello world.', PROBE_TEXT, 'Hello world.'],
    );
  }));

test('a decoy translation is never returned: rebuild once, then fail', () =>
  withServer({}, async (server) => {
    server.respond = (request) =>
      request.text === PROBE_TEXT
        ? undefined
        : decoyPayload(request.paragraphs);
    await assert.rejects(() => call(['Hello world.']), NETWORK_ERROR);
    assert.equal(realRequests(server).length, 2, 'retried exactly once');
    assert.equal(server.log.pages.length, 2);
    assert(!logs.some((entry) => entry.message.includes(DECOY_TEXT)));

    // and a decoy that disappears after the rebuild is recovered from
    let first = true;
    server.respond = (request) => {
      if (request.text === PROBE_TEXT) return undefined;
      if (first) {
        first = false;
        return decoyPayload(request.paragraphs);
      }
      return undefined;
    };
    yt.reset();
    assert.deepEqual(await call(['Hello world.']), ['T:Hello world.']);
  }));

test('an empty result or an unreadable body rebuilds the credentials and retries once', () =>
  withServer({}, async (server) => {
    const bad = [
      { code: 0, translateResult: [[{ tgt: '', src: 'Hello world.' }]] },
      { raw: 'not-a-valid-encrypted-body' },
    ];
    for (const answer of bad) {
      yt.reset();
      server.log.translations.length = 0;
      let used = false;
      server.respond = (request) => {
        if (request.text === PROBE_TEXT || used) return undefined;
        used = true;
        return answer;
      };
      assert.deepEqual(await call(['Hello world.']), ['T:Hello world.']);
      assert.equal(realRequests(server).length, 2);
    }

    yt.reset();
    server.respond = (request) =>
      request.text === PROBE_TEXT ? undefined : { raw: 'still-unreadable' };
    await assert.rejects(() => call(['Hello world.']), NETWORK_ERROR);
  }));

test('HTTP errors and timeouts are network errors without a rebuild', () =>
  withServer({}, async (server) => {
    for (const status of [429, 403, 500]) {
      yt.reset();
      server.log.translations.length = 0;
      server.respond = (request) =>
        request.text === PROBE_TEXT ? undefined : { throws: httpError(status) };
      await assert.rejects(
        () => call(['Hello world.']),
        new RegExp(`Youdao free translate failed \\(network\\).*${status}`),
      );
      assert.equal(realRequests(server).length, 1, `no retry for ${status}`);
    }

    yt.reset();
    server.respond = (request) =>
      request.text === PROBE_TEXT
        ? undefined
        : {
            throws: Object.assign(new Error('timeout of 15000ms exceeded'), {
              code: 'ECONNABORTED',
            }),
          };
    await assert.rejects(() => call(['Hello world.']), /\(network\).*timeout/);
  }));

test('a whole batch goes out as one newline-joined request and keeps its order', () =>
  withServer({}, async (server) => {
    const cues = Array.from({ length: 30 }, (_, i) => `Line ${i}.`);
    assert.deepEqual(
      await call(cues),
      cues.map((cue) => `T:${cue}`),
    );
    assert.equal(realRequests(server).length, 1);
    assert.equal(realRequests(server)[0].text, cues.join('\n'));
  }));

test('a response with the wrong paragraph count downgrades the batch to single requests', () =>
  withServer({}, async (server) => {
    const cues = Array.from({ length: 30 }, (_, i) => `Line ${i}.`);
    server.respond = (request) => {
      if (request.text === PROBE_TEXT || request.paragraphs.length === 1) {
        return undefined;
      }
      const payload = defaultPayload(request.paragraphs);
      payload.translateResult.pop();
      return payload;
    };
    assert.deepEqual(
      await call(cues),
      cues.map((cue) => `T:${cue}`),
    );
    assert.equal(realRequests(server).length, 1 + 30);
    assert(logs.some((entry) => /align/i.test(entry.message)));
  }));

test('an echo that does not match its input downgrades the batch', () =>
  withServer({}, async (server) => {
    const cues = ['First.', 'Second.', 'Third.'];
    server.respond = (request) => {
      if (request.text === PROBE_TEXT || request.paragraphs.length === 1) {
        return undefined;
      }
      const payload = defaultPayload(request.paragraphs);
      payload.translateResult[1][0].src = 'Something else.\n';
      return payload;
    };
    assert.deepEqual(
      await call(cues),
      cues.map((cue) => `T:${cue}`),
    );
    assert.equal(realRequests(server).length, 1 + 3);
  }));

test('when single requests are still misaligned the call fails without partial results', () =>
  withServer({}, async (server) => {
    server.respond = (request) => {
      if (request.text === PROBE_TEXT) return undefined;
      if (request.paragraphs.length > 1) {
        const payload = defaultPayload(request.paragraphs);
        payload.translateResult.pop();
        return payload;
      }
      return {
        code: 0,
        translateResult: [[{ tgt: '译文', src: 'Different text.' }]],
      };
    };
    await assert.rejects(() => call(['First.', 'Second.']), NETWORK_ERROR);
  }));

test('long input is split into requests of at most 5,000 characters', () =>
  withServer({}, async (server) => {
    const cues = Array.from(
      { length: 120 },
      (_, i) => `${String(i).padStart(3, '0')}${'a'.repeat(96)}.`,
    );
    const result = await call(cues);
    assert.equal(result.length, cues.length);
    assert.deepEqual(
      result,
      cues.map((cue) => `T:${cue}`),
    );
    const requests = realRequests(server);
    assert(requests.length >= 3, 'needs several requests');
    assert(requests.every((request) => request.text.length <= 5000));
    assert.equal(
      requests.map((request) => request.text).join('\n'),
      cues.join('\n'),
    );
  }));

test('width and punctuation differences in the echo do not trigger a downgrade', () =>
  withServer({}, async (server) => {
    server.respond = (request) =>
      request.text === 'Hello, world!\nBye.'
        ? {
            code: 0,
            translateResult: [
              [{ tgt: '你好，世界！\n', src: 'Hello，world！\n' }],
              [{ tgt: '再见。', src: 'Bye.' }],
            ],
          }
        : undefined;
    assert.deepEqual(await call(['Hello, world!', 'Bye.']), [
      '你好，世界！',
      '再见。',
    ]);
    assert.equal(server.log.translations.length, 2, 'probe + one request');
  }));

test('unsupported languages fail before any request, including credential setup', () =>
  withServer({}, async (server) => {
    await assert.rejects(
      () => call(['Hello.'], { from: 'tr', to: 'zh' }),
      /not supported language/,
    );
    await assert.rejects(
      () => call(['Hello.'], { from: 'en', to: 'pl' }),
      /not supported language/,
    );
    assert.equal(server.log.pages.length, 0);
    assert.equal(server.log.keys.length, 0);
    assert.equal(server.log.translations.length, 0);
  }));

test('service codes 21 and 40 mean unsupported language: no rebuild, no failure count', () =>
  withServer({}, async (server) => {
    for (const code of [40, 21, 40, 21]) {
      server.respond = (request) =>
        request.text === PROBE_TEXT ? undefined : { code };
      await assert.rejects(
        () => call(['Hello.'], { from: 'auto' }),
        /not supported language/,
      );
    }
    assert.equal(server.log.pages.length, 1, 'credentials not rebuilt');
    assert.equal(yt.breakerState().failures, 0);
    assert.equal(
      realRequests(server).length,
      4,
      'still requesting, no cooldown',
    );
  }));

test('subtitle markers are protected end to end and all-skipped input stays offline', () =>
  withServer({}, async (server) => {
    const result = await call(['<i>Hello</i>', '- Hi.\n- Bye.', '...']);
    assert.deepEqual(result, ['<i>T:Hello</i>', '- T:Hi.\n- T:Bye.', '...']);
    assert.equal(realRequests(server)[0].text, 'Hello\nHi.\nBye.');

    server.log.pages.length = 0;
    server.log.keys.length = 0;
    server.log.translations.length = 0;
    yt.reset();
    assert.deepEqual(await call(['...', '10:30', '♪']), ['...', '10:30', '♪']);
    assert.equal(server.log.pages.length, 0);
    assert.equal(server.log.keys.length, 0);
    assert.equal(server.log.translations.length, 0);
  }));

test('a string query returns a string', () =>
  withServer({}, async () => {
    assert.equal(await call('Hello world.'), 'T:Hello world.');
  }));

test('Chinese targets are normalized and other targets are left alone', () =>
  withServer({}, async (server) => {
    server.respond = (request) =>
      request.text === 'Run!'
        ? { code: 0, translateResult: [[{ tgt: '跑!', src: 'Run!' }]] }
        : request.text === 'Go!'
          ? { code: 0, translateResult: [[{ tgt: '私,', src: 'Go!' }]] }
          : undefined;
    assert.deepEqual(await call(['Run!'], { to: 'zh' }), ['跑！']);
    assert.deepEqual(await call(['Go!'], { to: 'ja' }), ['私,']);
  }));

test('consecutive failures open a 120 s cooldown that one probe request ends', () =>
  withServer({}, async (server) => {
    const clock = useFakeClock();
    try {
      server.respond = (request) =>
        request.text === PROBE_TEXT ? undefined : { throws: httpError(500) };
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => call(['Hello.']), /\(network\).*500/);
      }
      assert.equal(youdao.getYoudaoFreeAvailability().available, false);

      const before = server.log.translations.length;
      await assert.rejects(
        () => call(['Hello.']),
        /Youdao free translate failed \(network\).*cool/i,
      );
      assert.equal(
        server.log.translations.length,
        before,
        'no request while cooling',
      );

      clock.advance(121_000);
      assert.equal(youdao.getYoudaoFreeAvailability().available, true);
      await assert.rejects(() => call(['Hello.']), /500/);
      assert.equal(
        youdao.getYoudaoFreeAvailability().available,
        false,
        'failed probe cools down again',
      );

      clock.advance(121_000);
      server.respond = null;
      assert.deepEqual(await call(['Hello.']), ['T:Hello.']);
      assert.equal(youdao.getYoudaoFreeAvailability().available, true);
      assert.equal(yt.breakerState().failures, 0);
    } finally {
      clock.restore();
    }
  }));

test('only one call probes while the cooldown is ending', () =>
  withServer({}, async (server) => {
    const clock = useFakeClock();
    try {
      server.respond = (request) =>
        request.text === PROBE_TEXT ? undefined : { throws: httpError(500) };
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => call(['Hello.']), /500/);
      }
      clock.advance(121_000);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      server.respond = async (request) => {
        if (request.text === PROBE_TEXT) return undefined;
        await gate;
        return undefined;
      };
      const probing = call(['Hello.']);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(() => call(['Other.']), /cool|probe/i);
      release();
      assert.deepEqual(await probing, ['T:Hello.']);
    } finally {
      clock.restore();
    }
  }));

test('a success in between resets the failure count', () =>
  withServer({}, async (server) => {
    const failing = (request) =>
      request.text === PROBE_TEXT ? undefined : { throws: httpError(500) };
    server.respond = failing;
    await assert.rejects(() => call(['Hello.']), /500/);
    await assert.rejects(() => call(['Hello.']), /500/);
    server.respond = null;
    await call(['Hello.']);
    server.respond = failing;
    await assert.rejects(() => call(['Hello.']), /500/);
    await assert.rejects(() => call(['Hello.']), /500/);
    assert.equal(youdao.getYoudaoFreeAvailability().available, true);
    assert.equal(yt.breakerState().failures, 2);
  }));

test('requests respect the provider request interval', () =>
  withServer({}, async (server) => {
    const proof = nextProof({ requestInterval: 0.06 });
    await Promise.all([
      call(['One.'], { proof }),
      call(['Two.'], { proof }),
      call(['Three.'], { proof }),
    ]);
    const times = server.log.translations.map((request) => request.at);
    assert(times.length >= 4, 'probe plus three requests');
    for (let i = 1; i < times.length; i += 1) {
      assert(
        times[i] - times[i - 1] >= 50,
        `gap ${i}: ${times[i] - times[i - 1]}ms`,
      );
    }
  }));

test('cancellation ends the call with the task cancelled error and is not a failure', () =>
  withServer({}, async (server) => {
    const controller = new AbortController();
    let seenSignal;
    server.respond = (request) => {
      if (request.text === PROBE_TEXT) return undefined;
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
    assert.equal(yt.breakerState().failures, 0);

    // an already cancelled signal never reaches the network
    const before = server.log.translations.length;
    await assert.rejects(
      () => call(['Hello.'], { options: { signal: controller.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert.equal(server.log.translations.length, before);

    // an answer that arrives after the cancellation is dropped, not returned
    const late = new AbortController();
    server.respond = (request) => {
      if (request.text !== PROBE_TEXT) late.abort();
      return undefined;
    };
    await assert.rejects(
      () => call(['Hello.'], { options: { signal: late.signal } }),
      (error) => isTaskCancelledError(error),
    );
    assert.equal(yt.breakerState().failures, 0);
  }));

test('an unexpected internal error is still reported as a network-class failure', () =>
  withServer({}, async () => {
    onLog = (entry) => {
      if (entry.message.includes('session established')) {
        throw new TypeError('internal boom');
      }
    };
    try {
      await assert.rejects(
        () => call(['Hello.']),
        /Youdao free translate failed \(network\).*internal boom/,
      );
    } finally {
      onLog = null;
    }
    assert.equal(yt.breakerState().failures, 1);
  }));

test('cancelling during credential setup ends that call and leaves the setup to the others', () =>
  withServer({}, async (server) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.respond = async (request) => {
      if (request.text === PROBE_TEXT) await gate;
      return undefined;
    };
    const controller = new AbortController();
    const cancelled = call(['One.'], {
      options: { signal: controller.signal },
    });
    const patient = call(['Two.']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(
      () => cancelled,
      (error) => isTaskCancelledError(error),
    );
    release();
    assert.deepEqual(await patient, ['T:Two.']);
    assert.equal(server.log.pages.length, 1, 'one shared setup');
    assert.equal(yt.breakerState().failures, 0);
  }));

test('logs and errors never contain subtitle text, translations, cookie, keys or signatures', () =>
  withServer({}, async (server) => {
    const marker = 'ZXQ-MARKER-7731';
    const messages = [];
    const capture = async (promise) => {
      try {
        await promise;
      } catch (error) {
        messages.push(error.message);
      }
    };
    server.respond = (request) =>
      request.text === `${marker} line.`
        ? {
            code: 0,
            translateResult: [[{ tgt: `${marker} 译文`, src: request.text }]],
          }
        : undefined;
    await capture(call([`${marker} line.`]));

    server.respond = (request) =>
      request.text === PROBE_TEXT
        ? undefined
        : {
            code: 0,
            translateResult: [{ tgt: `${marker} decoy`, src: request.text }],
          };
    yt.reset();
    await capture(call([`${marker} second.`]));

    server.respond = (request) =>
      request.text === PROBE_TEXT ? undefined : { throws: httpError(500) };
    yt.reset();
    await capture(call([`${marker} third.`]));

    const everything = [
      ...logs.map((entry) => entry.message),
      ...messages,
    ].join('\n');
    assert(logs.length > 0, 'events are logged');
    const secrets = [
      marker,
      '1234567',
      '203.0.113.7',
      server.key.secretKey,
      server.key.aesKey,
      server.key.aesIv,
      ...server.log.translations.map((request) => request.form.get('sign')),
    ];
    for (const secret of secrets) {
      assert(!everything.includes(secret), `leaked: ${secret}`);
    }
  }));

// ---------------------------------------------------------------------------
// autoFree chain: the real fallback orchestration and provider registry with
// fake sibling sources, so registration, default order, skipping and error
// aggregation are exercised end to end. Youdao itself is the real translator
// talking to the fake service above.
// ---------------------------------------------------------------------------

const siblings = { bing: null, google: null, deeplx: null };
const siblingCalls = [];
const fakeSibling = (name) => async (list, proof, from, to, options) => {
  siblingCalls.push({ name, proof, list });
  return siblings[name](list, proof, from, to, options);
};

chainServices = {
  bingFreeTranslator: fakeSibling('bing'),
  googleFreeTranslator: fakeSibling('google'),
  deeplxTranslator: fakeSibling('deeplx'),
  youdaoFreeTranslator: youdaoFree,
};
const {
  TRANSLATOR_MAP,
  DEFAULT_FREE_FALLBACK_CHAIN,
} = require('../main/translate/services/translationProvider.ts');
chainServices = null;

const autoFree = (
  query,
  { from = 'en', to = 'zh', proof = {}, options } = {},
) =>
  TRANSLATOR_MAP.autoFree(
    query,
    { id: 'autoFree', ...proof },
    from,
    to,
    options,
  );
const attemptedSources = () =>
  logs
    .filter((entry) => entry.message.startsWith('autoFree trying source: '))
    .map((entry) => entry.message.slice('autoFree trying source: '.length));
const failingYoudao = (request) =>
  request.text === PROBE_TEXT ? undefined : { throws: httpError(500) };

function withChain(fn) {
  return withServer({}, async (server) => {
    siblingCalls.length = 0;
    siblings.bing = (list) => list.map((item) => `bing:${item}`);
    siblings.google = (list) => list.map((item) => `google:${item}`);
    siblings.deeplx = (list) => list.map((item) => `deeplx:${item}`);
    await fn(server);
  });
}

test('youdaoFree is registered and leads the default free chain', () => {
  assert.equal(TRANSLATOR_MAP.youdaoFree, youdaoFree);
  assert.deepEqual(DEFAULT_FREE_FALLBACK_CHAIN, [
    'youdaoFree',
    'bingFree',
    'googleFree',
    'deeplx',
  ]);
});

test('autoFree without a fallbackChain tries the default order and aggregates the failures', () =>
  withChain(async (server) => {
    server.respond = failingYoudao;
    siblings.bing = () => {
      throw new Error('Bing free translate failed (network): 429');
    };
    siblings.google = () => {
      throw new Error('Google free translate failed (network): timeout');
    };
    await assert.rejects(
      () => autoFree(['Hello.']),
      (error) => {
        assert.match(
          error.message,
          /^All free translation sources failed \(network\)/,
        );
        for (const part of [
          'youdaoFree: Youdao free translate failed (network)',
          'bingFree: Bing free translate failed (network): 429',
          'googleFree: Google free translate failed (network): timeout',
          'deeplx: no endpoint',
        ]) {
          assert(error.message.includes(part), `missing: ${part}`);
        }
        return true;
      },
    );
    assert.deepEqual(attemptedSources(), [
      'youdaoFree',
      'bingFree',
      'googleFree',
    ]);
  }));

test('a working Youdao answers first and the later sources are not called', () =>
  withChain(async () => {
    const result = await autoFree(['Hello.'], {
      proof: { fallbackChain: 'youdaoFree,bingFree' },
    });
    assert.deepEqual(result, ['T:Hello.']);
    assert.equal(siblingCalls.length, 0);
    assert.deepEqual(attemptedSources(), ['youdaoFree']);
    assert(!logs.some((entry) => entry.message.includes('fell back')));
  }));

test('a Youdao failure falls back to Bing and the fallback is logged', () =>
  withChain(async (server) => {
    server.respond = failingYoudao;
    const result = await autoFree(['Hello.'], {
      proof: { fallbackChain: 'youdaoFree,bingFree' },
    });
    assert.deepEqual(result, ['bing:Hello.']);
    assert.deepEqual(attemptedSources(), ['youdaoFree', 'bingFree']);
    assert.equal(
      realRequests(server).length,
      1,
      'Youdao really was asked first',
    );
    assert(
      logs.some((entry) => entry.message === 'autoFree fell back to bingFree'),
    );
    assert.equal(siblingCalls[0].proof.id, 'bingFree');
  }));

test('an unsupported source language routes to Bing without touching Youdao', () =>
  withChain(async (server) => {
    const result = await autoFree(['Merhaba.'], {
      from: 'tr',
      proof: { fallbackChain: 'youdaoFree,bingFree' },
    });
    assert.deepEqual(result, ['bing:Merhaba.']);
    assert.deepEqual(attemptedSources(), ['youdaoFree', 'bingFree']);
    assert(
      logs.some(
        (entry) =>
          entry.message ===
          'autoFree source youdaoFree failed: not supported language',
      ),
      'Youdao was tried and refused the language',
    );
    assert.equal(
      server.log.pages.length,
      0,
      'not even credentials were requested',
    );
    assert.equal(server.log.translations.length, 0);
    assert.equal(yt.breakerState().failures, 0, 'not a service failure');
  }));

test('a Youdao in cooldown is skipped without a request', () =>
  withChain(async (server) => {
    const clock = useFakeClock();
    try {
      server.respond = failingYoudao;
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => call(['Hello.']), /500/);
      }
      const before = server.log.translations.length;
      logs.length = 0;

      const result = await autoFree(['Hello.'], {
        proof: { fallbackChain: 'youdaoFree,bingFree' },
      });
      assert.deepEqual(result, ['bing:Hello.']);
      assert.equal(
        server.log.translations.length,
        before,
        'no request while cooling',
      );
      assert(
        logs.some(
          (entry) =>
            entry.type === 'info' &&
            entry.message.startsWith('autoFree skip youdaoFree: cooling down'),
        ),
        'the skip is an info line, not a warning',
      );
      assert.deepEqual(attemptedSources(), ['bingFree']);

      // the reason is part of the aggregated error when nothing else works
      siblings.bing = () => {
        throw new Error('Bing free translate failed (network): down');
      };
      await assert.rejects(
        () =>
          autoFree(['Hello.'], {
            proof: { fallbackChain: 'youdaoFree,bingFree' },
          }),
        /All free translation sources failed \(network\).*youdaoFree: cooling down/,
      );
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
                {
                  timedOut: true,
                },
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
    console.error(`${failed} of ${tests.length} youdao free tests failed`);
    process.exit(1);
  }
  console.log(`youdao free tests passed (${tests.length})`);
})();
