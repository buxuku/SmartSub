/// <reference path="./test-globals.d.ts" />
import {
  collectAIJsonCandidates,
  parseAIAnchoredTranslationResponse,
  parseAITranslationResponse,
  stripAIThinkingContent,
} from '../main/translate/utils/aiResponseParser';
import {
  normalizeForComparison,
  textSimilarity,
} from '../main/translate/utils/similarity';

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

// ---- 回显锚定协议: {id: {src, tr}} ----

eq(
  parseAITranslationResponse('{"1":{"src":"Hello","tr":"你好"}}'),
  { '1': '你好' },
  'parse: echo protocol degrades to tr string in legacy parser',
);

eq(
  parseAIAnchoredTranslationResponse('{"1":{"src":"Hello","tr":"你好"}}'),
  { '1': { translation: '你好', srcEcho: 'Hello', hasEcho: true } },
  'anchored: extracts src echo and translation',
);

eq(
  parseAIAnchoredTranslationResponse('{"1":"你好"}'),
  { '1': { translation: '你好', hasEcho: false } },
  'anchored: plain string degrades to no-echo entry',
);

eq(
  parseAIAnchoredTranslationResponse(
    '{"1":{"src":"Hello","tr":"你好"},"2":"世界"}',
  ),
  {
    '1': { translation: '你好', srcEcho: 'Hello', hasEcho: true },
    '2': { translation: '世界', hasEcho: false },
  },
  'anchored: mixed forms handled per entry',
);

eq(
  parseAIAnchoredTranslationResponse('{"1":{"tr":"你好"}}'),
  { '1': { translation: '你好', hasEcho: false } },
  'anchored: tr without src has no echo',
);

eq(
  parseAIAnchoredTranslationResponse('{"1":{"translation":"你好"}}'),
  { '1': { translation: '你好', hasEcho: false } },
  'anchored: legacy nested translation key degrades to no-echo',
);

eq(
  parseAIAnchoredTranslationResponse(
    '<think>plan</think>```json\n{"1":{"src":"Hi","tr":"嗨"}}\n```',
  ),
  { '1': { translation: '嗨', srcEcho: 'Hi', hasEcho: true } },
  'anchored: think tag + fenced json',
);

eq(
  parseAIAnchoredTranslationResponse('{"1":{"src":"Hello","tr":""}}'),
  { '1': { translation: '', srcEcho: 'Hello', hasEcho: true } },
  'anchored: keeps empty translation for caller-side validation',
);

throws(
  () => parseAIAnchoredTranslationResponse('[1,2]'),
  'anchored: rejects arrays',
);

// ---- 相似度工具 ----

eq(
  normalizeForComparison('Hello,  World!'),
  'helloworld',
  'similarity: normalization strips punctuation and case',
);

eq(textSimilarity('Hello world', 'Hello world'), 1, 'similarity: identical');

eq(
  textSimilarity('I want to give you a little tip', '') === 0,
  true,
  'similarity: empty side yields 0',
);

eq(
  textSimilarity(
    'Traditionally, when we make use of ReactJS',
    'Traditionally when we make use of ReactJS',
  ) > 0.95,
  true,
  'similarity: punctuation differences stay high',
);

eq(
  textSimilarity(
    'Traditionally, when we make use of ReactJS',
    'Examples of dynamic apps would be like arabineb.com or Instagram',
  ) < 0.5,
  true,
  'similarity: unrelated lines stay low',
);

eq(
  textSimilarity(
    'to build a website, we use ReactJS specifically',
    'we use ReactJS specifically when we need to make a highly interactive or a very dynamic kind of application',
  ) < 0.75,
  true,
  'similarity: merged echo falls below threshold',
);

if (failed > 0) {
  console.error(
    `AI response parser tests failed: ${failed}/${passed + failed}`,
  );
  process.exit(1);
}

console.log(`AI response parser tests passed: ${passed}`);
