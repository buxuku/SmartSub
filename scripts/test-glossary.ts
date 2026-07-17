import {
  buildGlossaryPromptBlock,
  glossaryConflictFingerprint,
  injectGlossaryPromptBlock,
  matchGlossaryEntries,
  mergeGlossaryImportEntry,
  normalizeGlossaries,
  parseGlossaryContent,
  renderGlossarySystemPrompt,
  reorderGlossaries,
  resolveEnabledGlossaryEntries,
  selectGlossaryPromptEntries,
  serializeGlossaryEntries,
  textContainsGlossarySource,
} from '../main/glossary/core';
import { renderTemplate } from '../main/helpers/template';
import type {
  Glossary,
  GlossaryImportEntry,
  GlossaryImportNote,
} from '../types/glossary';
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

const missingNote: GlossaryImportNote = { kind: 'missing' };

function providedNote(value: string): GlossaryImportNote {
  return { kind: 'provided', value };
}

function imported(
  source: string,
  target: string,
  note: GlossaryImportNote = missingNote,
): GlossaryImportEntry {
  return { source, target, note };
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

function testGlossaryReordering(): void {
  const original = [
    glossary('a', 'A', 10, [entry('a1', 'Alice', 'A target')]),
    glossary('b', 'B', 20, [entry('b1', 'Alice', 'B target')]),
    glossary('c', 'C', 40, []),
  ];
  const snapshot = JSON.stringify(original);
  const movedDown = reorderGlossaries(original, 'a', 1);
  equal(
    movedDown.map((item) => [item.id, item.order]),
    [
      ['b', 0],
      ['a', 1],
      ['c', 2],
    ],
    'moving a glossary down rewrites the persisted priority order',
  );
  equal(
    normalizeGlossaries(movedDown).map((item) => item.id),
    ['b', 'a', 'c'],
    'normalization does not undo a glossary move',
  );
  equal(
    reorderGlossaries(original, 'c', -1).map((item) => item.id),
    ['a', 'c', 'b'],
    'moves the last glossary up',
  );
  equal(
    reorderGlossaries(original, 'a', -1).map((item) => item.id),
    ['a', 'b', 'c'],
    'moving the first glossary up is a boundary no-op',
  );
  equal(
    reorderGlossaries(original, 'c', 1).map((item) => item.id),
    ['a', 'b', 'c'],
    'moving the last glossary down is a boundary no-op',
  );
  equal(
    reorderGlossaries(original, 'missing', 1).map((item) => [
      item.id,
      item.order,
    ]),
    [
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ],
    'an unknown glossary is a normalized pure-function no-op',
  );
  equal(JSON.stringify(original), snapshot, 'reordering does not mutate input');
  equal(
    resolveEnabledGlossaryEntries(movedDown).entries.map((item) => item.target),
    ['B target'],
    'moving a glossary changes the winner for duplicate source terms',
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
  ok(
    textContainsGlossarySource('xa-a-a', 'a-a'),
    'finds a valid overlapping match after an invalid boundary',
  );
  ok(
    !textContainsGlossarySource('xa-a', 'a-a'),
    'still rejects an overlapping candidate without a left boundary',
  );
  ok(
    textContainsGlossarySource('xＡ-Ａ-Ａ', 'A-a'),
    'overlapping matches remain case-insensitive and NFKC-normalized',
  );
  ok(!textContainsGlossarySource('Alice', ''), 'empty terms never match');

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
  equal(
    matchGlossaryEntries(
      resolveEnabledGlossaryEntries([
        glossary('g', 'Phrases', 0, [entry('1', 'foo bar', '组合')]),
      ]).entries,
      ['foo', 'bar'],
    ),
    [],
    'matching never creates a term across subtitle boundaries',
  );
}

function testImportMergeSemantics(): void {
  const current = { source: 'Alice', target: '艾丽丝', note: 'lead role' };
  equal(
    mergeGlossaryImportEntry(current, imported('Alice', '艾丽丝')),
    { kind: 'skip', value: current },
    'a missing note column preserves an existing note and skips no-op updates',
  );
  equal(
    mergeGlossaryImportEntry(current, imported('Alice', '爱丽丝')),
    {
      kind: 'update',
      value: { source: 'Alice', target: '爱丽丝', note: 'lead role' },
    },
    'a missing note column preserves the note while updating the target',
  );
  equal(
    mergeGlossaryImportEntry(
      current,
      imported('Alice', '艾丽丝', providedNote('lead role')),
    ),
    { kind: 'skip', value: current },
    'an unchanged explicitly provided note is skipped',
  );
  equal(
    mergeGlossaryImportEntry(
      current,
      imported('Alice', '艾丽丝', providedNote('protagonist')),
    ),
    {
      kind: 'update',
      value: {
        source: 'Alice',
        target: '艾丽丝',
        note: 'protagonist',
      },
    },
    'an explicitly provided note overwrites the existing note',
  );
  equal(
    mergeGlossaryImportEntry(
      current,
      imported('Alice', '艾丽丝', providedNote('')),
    ),
    { kind: 'update', value: { source: 'Alice', target: '艾丽丝' } },
    'an explicitly empty note clears the existing note',
  );
  equal(
    mergeGlossaryImportEntry(
      { source: 'Bob', target: '鲍勃' },
      imported('Bob', '鲍勃', providedNote('   ')),
    ),
    { kind: 'skip', value: { source: 'Bob', target: '鲍勃' } },
    'an empty note is a no-op when the entry already has no note',
  );
  equal(
    mergeGlossaryImportEntry(undefined, imported('Bob', '鲍勃')),
    { kind: 'add', value: { source: 'Bob', target: '鲍勃' } },
    'a new two-column entry is added without a note',
  );
  equal(
    mergeGlossaryImportEntry(undefined, imported('', 'missing source')),
    { kind: 'invalid' },
    'invalid imported entries are rejected',
  );

  const first = mergeGlossaryImportEntry(
    undefined,
    imported('Alice', 'first', providedNote('one')),
  );
  const second =
    first.kind === 'add'
      ? mergeGlossaryImportEntry(
          first.value,
          imported('Alice', 'last', providedNote('two')),
        )
      : first;
  equal(
    second,
    {
      kind: 'update',
      value: { source: 'Alice', target: 'last', note: 'two' },
    },
    'duplicate imported sources use the last row',
  );

  const persistent = entry('persisted-id', 'Alice', 'old', 'old note');
  const merged = mergeGlossaryImportEntry(
    persistent,
    imported('Alice', 'new', providedNote('new note')),
  );
  const updated =
    merged.kind === 'update'
      ? { ...persistent, ...merged.value, updatedAt: 2 }
      : persistent;
  ok(
    updated.id === persistent.id &&
      updated.createdAt === persistent.createdAt &&
      updated.updatedAt === 2,
    'an imported update preserves identity and creation time',
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

  const cappedMatches = resolveEnabledGlossaryEntries([
    glossary(
      'cap',
      'Prompt cap',
      0,
      Array.from({ length: 101 }, (_, index) =>
        entry(String(index), `term-${index}`, `target-${index}`),
      ),
    ),
  ]).entries;
  const selection = selectGlossaryPromptEntries(cappedMatches);
  equal(selection.omittedCount, 1, 'reports terms omitted from the prompt');
  equal(
    selection.included.map((item) => item.source),
    cappedMatches.slice(0, 100).map((item) => item.source),
    'keeps the first 100 glossary matches in priority order',
  );
  const cappedBlock = buildGlossaryPromptBlock(selection.included);
  equal(
    (cappedBlock.match(/"source":/g) || []).length,
    100,
    'injects at most 100 glossary entries',
  );
  ok(
    cappedBlock.includes('"source": "term-99"') &&
      !cappedBlock.includes('"source": "term-100"'),
    'the prompt cap excludes only lower-priority overflow entries',
  );
}

function testConflictFingerprint(): void {
  const conflicts = resolveEnabledGlossaryEntries([
    glossary('first', 'First', 0, [entry('1', 'Alice', '艾丽丝')]),
    glossary('second', 'Second', 1, [entry('2', 'alice', '爱丽丝')]),
  ]).conflicts;
  const fingerprint = glossaryConflictFingerprint(conflicts);
  equal(
    glossaryConflictFingerprint(conflicts),
    fingerprint,
    'the same conflict set has a stable fingerprint',
  );
  ok(
    glossaryConflictFingerprint([
      {
        ...conflicts[0],
        kept: { ...conflicts[0].kept, target: 'new winner' },
      },
    ]) !== fingerprint,
    'the fingerprint changes when a conflict winner changes',
  );
  equal(
    glossaryConflictFingerprint([]),
    '',
    'an empty conflict set resets the fingerprint',
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
      imported('Alice', '艾丽丝', providedNote('lead, role')),
      imported('Dr. Smith', '史密斯博士', providedNote('line 1\nline 2')),
    ],
    'parses BOM, quoted commas, and quoted newlines in CSV',
  );

  const csvEntries = [
    { source: 'Alice', target: '艾丽丝', note: 'lead, role' },
    { source: 'Dr. Smith', target: '史密斯博士', note: 'line 1\nline 2' },
  ];
  const serialized = serializeGlossaryEntries(csvEntries, 'csv');
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
    [imported('Alice', '艾丽丝', providedNote('角色'))],
    'accepts localized CSV headers',
  );
  equal(
    parseGlossaryContent('source,target,note\na,b\nc,d,', 'csv'),
    [imported('a', 'b'), imported('c', 'd', providedNote(''))],
    'CSV distinguishes a missing note cell from an explicit empty note cell',
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
      imported('C++', 'C 加加', providedNote('language')),
      imported('Dr. Smith', '史密斯博士'),
      imported('cat', '猫'),
      imported('Alice', '艾丽丝'),
    ],
    'parses tab, arrow, and legacy equals TXT separators',
  );
  const txtEntries = [
    { source: 'C++', target: 'C 加加', note: 'language' },
    { source: 'Dr. Smith', target: '史密斯博士' },
  ];
  equal(
    parseGlossaryContent(serializeGlossaryEntries(txtEntries, 'txt'), 'txt'),
    [
      imported('C++', 'C 加加', providedNote('language')),
      imported('Dr. Smith', '史密斯博士', providedNote('')),
    ],
    'TXT serialization round-trips values with an explicit note column',
  );
  equal(
    parseGlossaryContent('source\ttarget\tnote\na\tb\nc\td\t', 'txt'),
    [imported('a', 'b'), imported('c', 'd', providedNote(''))],
    'TXT distinguishes a missing note cell from a trailing empty note cell',
  );
}

function main(): void {
  testNormalizationAndPriority();
  testGlossaryReordering();
  testPlainTextMatching();
  testImportMergeSemantics();
  testPromptInjection();
  testConflictFingerprint();
  testCsvImportExport();
  testTxtImportExport();

  console.log(`\nglossary tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
