'use strict';

const assert = require('assert');
const {
  parseJsonResult,
  sanitizeJsonControlCharacters,
} = require('../extraResources/sherpa/vendor/json-result.js');

const rawResult = '{"text":"first\nsecond\t\u0000end","tokens":["first"]}';
assert.deepStrictEqual(parseJsonResult(rawResult), {
  text: 'first\nsecond\t\u0000end',
  tokens: ['first'],
});

const escapedResult = String.raw`{"text":"first\nsecond\t"}`;
assert.deepStrictEqual(parseJsonResult(escapedResult), {
  text: 'first\nsecond\t',
});

assert.strictEqual(parseJsonResult('{"text":"ok"}\u0000\n').text, 'ok');
assert.strictEqual(
  sanitizeJsonControlCharacters('{"text":"a\u000bb"}'),
  '{"text":"a\\u000bb"}',
);

console.log('sherpa JSON result tests: 4 passed');
