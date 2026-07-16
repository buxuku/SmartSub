import {
  buildGlossaryPromptBlock,
  injectGlossaryPromptBlock,
  matchGlossaryEntries,
  normalizeGlossaries,
  parseGlossaryContent,
  renderGlossarySystemPrompt,
  resolveEnabledGlossaryEntries,
  serializeGlossaryEntries,
  textContainsGlossarySource,
} from '../main/glossary/core';
import { renderTemplate } from '../main/helpers/template';
import type { Glossary } from '../types/glossary';
import {
  defaultSystemPrompt,
  HISTORICAL_DEFAULT_PROMPTS,
} from '../types/provider';

let passed = 0;
let failed = 0;

function ok(value: unknown, name: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`x ${name}`);
  }
}

function equal<T>(actual: T, expected: T, name: string): void {
  const success = JSON.stringify(actual) === JSON.stringify(expected);
  ok(success, name);
  if (!success) {
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

function entry(id: string, source: string, target: string, note?: string) {
  return { id, source, target, note, createdAt: 1, updatedAt: 1 };
}

function glossary(
  id: string,
  name: string,
  order: number,
  entries: ReturnType<typeof entry>[],
  enabled = true,
): Glossary {
  return {
    id,
    name,
    order,
    enabled,
    entries,
    createdAt: 1,
    updatedAt: 1,
  };
}

function testNormalizationAndPriority(): void {
  const normalized = normalizeGlossaries([
    glossary('later', 'Later', 8, [entry('2', 'Alice', '后者')]),
    glossary('first', 'First', 1, [entry('1', 'Alice', '艾丽丝')]),
    glossary('off', 'Disabled', 0, [entry('3', 'Bob', '鲍勃')], false),
  ]);
  equal(
    normalized.map((item) => [item.id, item.order]),
    [
      ['off', 0],
      ['first', 1],
      ['later', 2],
    ],
    'normalizes glossary order stably',
  );

  const resolution = resolveEnabledGlossaryEntries(normalized);
  equal(
    resolution.entries.map((item) => [item.source, item.target]),
    [['Alice', '艾丽丝']],
    'disabled libraries are ignored and first enabled duplicate wins',
  );
  ok(resolution.conflicts.length === 1, 'reports cross-library conflicts');
  ok(
    resolution.conflicts[0].kept.glossaryName === 'First' &&
      resolution.conflicts[0].ignored.glossaryName === 'Later',
    'conflict records kept and ignored libraries',
  );
}

function testPlainTextMatching(): void {
  ok(
    textContainsGlossarySource('Alice arrived', 'alice'),
    'matches case-insensitively',
  );
  ok(
    textContainsGlossarySource('ALICE arrived', 'Ａｌｉｃｅ'),
    'matches NFKC full-width forms',
  );
  ok(
    textContainsGlossarySource('I use C++ daily', 'C++'),
    'matches C++ as plain text',
  );
  ok(
    textContainsGlossarySource('Hello, Dr. Smith.', 'Dr. Smith'),
    'matches punctuation-containing terms',
  );
  ok(
    textContainsGlossarySource('爱丽丝去了仙境', '爱丽丝'),
    'matches CJK substrings',
  );
  ok(
    !textContainsGlossarySource('category', 'cat'),
    'does not match inside longer Latin words',
  );
  ok(
    textContainsGlossarySource('a cat!', 'cat'),
    'matches a standalone Latin word',
  );

  const resolution = resolveEnabledGlossaryEntries([
    glossary('g', 'Characters', 0, [
      entry('1', 'Alice', '艾丽丝'),
      entry('2', 'Bob', '鲍勃'),
    ]),
  ]);
  equal(
    matchGlossaryEntries(resolution.entries, ['Bob meets someone']).map(
      (item) => item.source,
    ),
    ['Bob'],
    'a batch includes only terms matched in its source subtitles',
  );
}

function testPromptInjection(): void {
  const matches = resolveEnabledGlossaryEntries([
    glossary('g', 'Show', 0, [entry('1', 'price', '$&', 'keep "$"')]),
  ]).entries;
  const block = buildGlossaryPromptBlock(matches);
  ok(
    block.includes('"target": "$&"'),
    'prompt JSON preserves replacement-like text literally',
  );
  ok(
    block.includes('"note": "keep \\"$\\""'),
    'prompt JSON escapes notes safely',
  );
  equal(
    injectGlossaryPromptBlock('Before\n${glossary}\nAfter', block),
    `Before\n${block}\nAfter`,
    'replaces the glossary template variable in place',
  );
  equal(
    injectGlossaryPromptBlock('Custom system prompt', block),
    `Custom system prompt\n\n${block}`,
    'appends matches for legacy custom prompts without the variable',
  );
  equal(
    injectGlossaryPromptBlock('Before ${glossary} After', ''),
    'Before  After',
    'removes the variable cleanly when a batch has no matches',
  );

  const literalTemplateToken = buildGlossaryPromptBlock(
    resolveEnabledGlossaryEntries([
      glossary('tokens', 'Literal tokens', 0, [
        entry('2', 'template token', '${content}'),
      ]),
    ]).entries,
  );
  ok(
    injectGlossaryPromptBlock('${glossary}', literalTemplateToken).includes(
      '"target": "${content}"',
    ),
    'keeps template-looking text literal when the glossary is injected last',
  );
  equal(
    renderTemplate('Term: ${value}', { value: '$& ${content}' }),
    'Term: $& ${content}',
    'template replacement keeps dollar patterns literal',
  );
  equal(
    renderTemplate('${content}|${glossary}', {
      content: 'literal ${glossary}',
      glossary: 'BLOCK',
    }),
    'literal ${glossary}|BLOCK',
    'template values are not recursively interpreted',
  );
  equal(
    renderGlossarySystemPrompt(
      'Input: ${content}\n${glossary}',
      { content: 'literal ${glossary}' },
      literalTemplateToken,
    ),
    `Input: literal \${glossary}\n${literalTemplateToken}`,
    'system prompt replaces only the original glossary placeholder',
  );
  equal(
    renderGlossarySystemPrompt(
      'Input: ${content}',
      { content: 'literal ${glossary}' },
      literalTemplateToken,
    ),
    `Input: literal \${glossary}\n\n${literalTemplateToken}`,
    'legacy prompts append glossary data without rewriting inserted content',
  );
  ok(
    defaultSystemPrompt.includes('${glossary}'),
    'the current default system prompt exposes the glossary variable',
  );
  ok(
    HISTORICAL_DEFAULT_PROMPTS.some(
      (prompt) => !prompt.includes('${glossary}'),
    ),
    'the provider migration recognizes pre-glossary default prompts',
  );
}

function testCsvImportExport(): void {
  const parsed = parseGlossaryContent(
    '\uFEFFsource,target,note\r\n"Alice","艾丽丝","lead, role"\r\n"Dr. Smith","史密斯博士","line 1\nline 2"',
    'csv',
  );
  equal(
    parsed,
    [
      { source: 'Alice', target: '艾丽丝', note: 'lead, role' },
      { source: 'Dr. Smith', target: '史密斯博士', note: 'line 1\nline 2' },
    ],
    'parses BOM, quoted commas, and quoted newlines in CSV',
  );

  const serialized = serializeGlossaryEntries(parsed, 'csv');
  equal(
    parseGlossaryContent(serialized, 'csv'),
    parsed,
    'CSV serialization round-trips glossary entries',
  );

  const localized = parseGlossaryContent(
    '原文,期望译文,备注\nAlice,艾丽丝,角色',
    'csv',
  );
  equal(
    localized,
    [{ source: 'Alice', target: '艾丽丝', note: '角色' }],
    'accepts localized CSV headers',
  );
}

function testTxtImportExport(): void {
  const parsed = parseGlossaryContent(
    'source\ttarget\tnote\nC++\tC 加加\tlanguage\nDr. Smith -> 史密斯博士\ncat→猫\nAlice = 艾丽丝',
    'txt',
  );
  equal(
    parsed,
    [
      { source: 'C++', target: 'C 加加', note: 'language' },
      { source: 'Dr. Smith', target: '史密斯博士' },
      { source: 'cat', target: '猫' },
      { source: 'Alice', target: '艾丽丝' },
    ],
    'parses tab, arrow, and legacy equals TXT separators',
  );
  equal(
    parseGlossaryContent(serializeGlossaryEntries(parsed, 'txt'), 'txt'),
    parsed,
    'TXT serialization round-trips glossary entries',
  );
}

function main(): void {
  testNormalizationAndPriority();
  testPlainTextMatching();
  testPromptInjection();
  testCsvImportExport();
  testTxtImportExport();

  console.log(`\nglossary tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
