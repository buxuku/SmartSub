/// <reference path="./test-globals.d.ts" />
import {
  collectAIJsonCandidates,
  parseAITranslationResponse,
  stripAIThinkingContent,
} from '../main/translate/utils/aiResponseParser';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function throws(fn: () => unknown, name: string): void {
  try {
    fn();
    failed++;
    console.error(`✗ ${name}\n    expected error`);
  } catch {
    passed++;
  }
}

eq(
  stripAIThinkingContent('<think>reasoning</think>{"1":"你好"}'),
  '{"1":"你好"}',
  'strip: closed think without trailing newline',
);

eq(
  collectAIJsonCandidates('说明文字\n{"1":"你好"}')[0],
  '{"1":"你好"}',
  'candidate: extracts object from prefixed text',
);

eq(
  parseAITranslationResponse('{"1":"你好"}'),
  { '1': '你好' },
  'parse: raw json object',
);

eq(
  parseAITranslationResponse('<think>reasoning</think>{"1":"你好"}'),
  { '1': '你好' },
  'parse: closed think without newline',
);

eq(
  parseAITranslationResponse('<think>reasoning\n{"1":"你好"}'),
  { '1': '你好' },
  'parse: unclosed think before json',
);

eq(
  parseAITranslationResponse('```JSON\r\n{"1":"你好"}\r\n```'),
  { '1': '你好' },
  'parse: uppercase fenced json with CRLF',
);

eq(
  parseAITranslationResponse('```\n{"1":"你好"}\n```'),
  { '1': '你好' },
  'parse: unlabeled fenced json',
);

eq(
  parseAITranslationResponse('<result>{"1":"你好"}</result>'),
  { '1': '你好' },
  'parse: result tag',
);

eq(
  parseAITranslationResponse('Here is the JSON:\n{"1":"你好"}'),
  { '1': '你好' },
  'parse: prefixed explanation',
);

eq(
  parseAITranslationResponse('{"1":"hello\nworld"}'),
  { '1': 'hello\nworld' },
  'parse: repairs bare newline inside string',
);

eq(
  parseAITranslationResponse('{"1":{"translation":"你好"}}'),
  { '1': '你好' },
  'parse: nested translation value',
);

throws(
  () => parseAITranslationResponse('[{"id":"1","targetContent":"你好"}]'),
  'parse: rejects arrays',
);

throws(
  () =>
    parseAITranslationResponse(
      'Here is the JSON:\n[{"id":"1","targetContent":"你好"}]',
    ),
  'parse: rejects prefixed arrays',
);

throws(
  () => parseAITranslationResponse('there is no json here'),
  'parse: rejects responses without json',
);

if (failed > 0) {
  console.error(
    `AI response parser tests failed: ${failed}/${passed + failed}`,
  );
  process.exit(1);
}

console.log(`AI response parser tests passed: ${passed}`);
