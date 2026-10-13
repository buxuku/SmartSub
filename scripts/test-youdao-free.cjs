'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];

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
  assert.equal(text.restoreCue(plan, ['停下！', '放下它。']), '停下！\n...\n放下它。');
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
  assert.deepEqual(sent('我觉得我们应该\n回家了。'), ['我觉得我们应该回家了。']);
});

test('finished sentences and effect lines stay on their own lines', () => {
  assert.deepEqual(sent('Stop!\nPut it down.'), ['Stop!', 'Put it down.']);
  assert.deepEqual(sent('[phone ringing]\nHello?'), ['phone ringing', 'Hello?']);
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
    roundTrip('- I think we should\ngo home.\n- Fine.', ['我们该回家了。', '好吧。']),
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
  assert.deepEqual(sent('He said <i>never</i> again.'), ['He said never again.']);
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
  assert.equal(text.normalizeEcho('Hello, world!'), text.normalizeEcho('Hello，world！'));
  assert.equal(text.normalizeEcho('(8) Go.'), text.normalizeEcho('（８） Go.'));
  assert.notEqual(text.normalizeEcho('Hello world'), text.normalizeEcho('Hello there'));
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

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
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
