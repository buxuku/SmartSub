/**
 * 通读摘要纯函数单测（无 electron）。
 * 运行：yarn test:summary
 */
import {
  defaultSummaryPrompt,
  resolveSummaryPrompt,
  SUMMARY_GLOSSARY_HEADING,
  SUMMARY_BLOCK_HEADING,
} from '../types/summaryPrompt';
import {
  buildSummaryInput,
  buildSummaryInstructions,
  buildSummaryGlossaryBlock,
  estimateSummaryBatches,
  shouldSkipTrivialSummary,
  settleSummaryText,
} from '../main/helpers/episodeSummaryCore';
import {
  buildSummaryPromptBlock,
  renderGlossarySystemPrompt,
  renderTranslationSystemPrompt,
} from '../main/glossary/core';
import { defaultSystemPrompt } from '../types/provider';

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

// ── resolveSummaryPrompt ──────────────────────────────────────────────────

equal(
  resolveSummaryPrompt(undefined),
  defaultSummaryPrompt,
  'empty store falls back to factory prompt',
);
equal(
  resolveSummaryPrompt('   '),
  defaultSummaryPrompt,
  'whitespace store falls back to factory prompt',
);
equal(
  resolveSummaryPrompt('custom draft'),
  'custom draft',
  'non-empty store is kept as-is',
);
ok(
  defaultSummaryPrompt.includes('${sourceLanguage}') &&
    defaultSummaryPrompt.includes('${targetLanguage}'),
  'factory prompt keeps language variables',
);
ok(
  !defaultSummaryPrompt.includes('一整集英文字幕'),
  'factory prompt is not hardcoded to English episodes',
);

// ── buildSummaryInput ─────────────────────────────────────────────────────

equal(
  buildSummaryInput([
    { id: '0', text: 'Hello' },
    { id: '1', text: 'Line A\nLine B' },
  ]),
  '0\tHello\n1\tLine A / Line B',
  'summary input is id<TAB>text with newlines flattened',
);

// ── buildSummaryInstructions ──────────────────────────────────────────────

{
  const inst = buildSummaryInstructions({
    prompt: '当前${sourceLanguage}→${targetLanguage}',
    sourceLanguage: '法语',
    targetLanguage: '简体中文',
  });
  ok(inst.includes('当前法语→简体中文'), 'summary instructions replace language vars');
  ok(
    !inst.includes(SUMMARY_GLOSSARY_HEADING),
    'no glossary heading when block is empty',
  );
}

{
  const inst = buildSummaryInstructions({
    prompt: 'base',
    sourceLanguage: '英语',
    targetLanguage: '简体中文',
    glossaryBlock: buildSummaryGlossaryBlock([
      {
        id: '1',
        source: 'Alice',
        target: '艾丽丝',
        createdAt: 0,
        updatedAt: 0,
        glossaryId: 'g',
        glossaryName: 'G',
        glossaryOrder: 0,
        entryOrder: 0,
      },
    ]),
  });
  ok(
    inst.includes(SUMMARY_GLOSSARY_HEADING),
    'summary glossary uses the summary-only heading',
  );
  ok(inst.includes('Alice') && inst.includes('艾丽丝'), 'summary glossary lists terms');
  ok(
    !inst.includes('必须遵守，不得另译'),
    'summary glossary heading is not the translation heading',
  );
}

// ── settleSummaryText ─────────────────────────────────────────────────────

equal(
  settleSummaryText('  hello  '),
  { ok: true, text: 'hello' },
  'string response is trimmed',
);
equal(
  settleSummaryText(['part A', 'part B']),
  { ok: true, text: 'part A\npart B' },
  'string[] response is joined then trimmed',
);
equal(
  settleSummaryText('   '),
  { ok: false, error: 'empty' },
  'blank response degrades as empty',
);
equal(
  settleSummaryText('<think>reasoning'),
  { ok: false, error: 'empty-after-think-strip' },
  'unclosed think tag that swallows the body degrades',
);
ok(
  settleSummaryText('<think>hide</think>\nVisible summary').ok === true &&
    (settleSummaryText('<think>hide</think>\nVisible summary') as { text: string })
      .text === 'Visible summary',
  'closed think tags are stripped and remaining text kept',
);

// ── skip guards ───────────────────────────────────────────────────────────

ok(shouldSkipTrivialSummary(19, 10), '19 cues skip regardless of batch size');
ok(
  !shouldSkipTrivialSummary(20, 10),
  '20 cues + batchSize 10 → 2 batches, do not skip',
);
ok(
  !shouldSkipTrivialSummary(300, 200),
  'batchSize 200 is capped at 100 so 300 cues are 3 batches',
);
ok(
  shouldSkipTrivialSummary(80, 200),
  '80 cues fit in one capped batch of 100, skip',
);
ok(
  shouldSkipTrivialSummary(12, 3),
  '12 cues / batchSize 3 is 4 batches but still below cue floor',
);
equal(estimateSummaryBatches(300, 200), 3, 'estimate uses schema cap of 100');
equal(estimateSummaryBatches(20, 10), 2, '20 / 10 = 2 batches');

// ── injection ─────────────────────────────────────────────────────────────

{
  const withPlaceholder = 'Head\n${summary}\nTail';
  const rendered = renderTranslationSystemPrompt(
    withPlaceholder,
    { sourceLanguage: '英语', targetLanguage: '中文' },
    { summary: buildSummaryPromptBlock('CONTEXT') },
  );
  ok(rendered.includes('CONTEXT'), 'placeholder ${summary} is replaced in place');
  ok(
    !rendered.endsWith('CONTEXT'),
    'placeholder replacement does not also append',
  );
  ok(
    rendered.includes(SUMMARY_BLOCK_HEADING),
    'summary block keeps the data-not-instruction heading',
  );
}

{
  const noPlaceholder = 'Head only';
  const rendered = renderTranslationSystemPrompt(
    noPlaceholder,
    {},
    { summary: buildSummaryPromptBlock('APPENDED') },
  );
  ok(
    rendered.includes('Head only') && rendered.includes('APPENDED'),
    'missing ${summary} appends the summary block',
  );
}

{
  const template = defaultSystemPrompt;
  const without = renderTranslationSystemPrompt(
    template,
    { sourceLanguage: '英语', targetLanguage: '中文', content: '{}' },
    {},
  );
  const emptySummary = renderTranslationSystemPrompt(
    template,
    { sourceLanguage: '英语', targetLanguage: '中文', content: '{}' },
    { summary: '' },
  );
  equal(
    emptySummary,
    without,
    'empty summary leaves system prompt byte-identical',
  );
  equal(
    renderGlossarySystemPrompt(
      template,
      { sourceLanguage: '英语', targetLanguage: '中文', content: '{}' },
      '',
    ),
    without,
    'legacy glossary wrapper stays equivalent when no extra blocks',
  );
}

{
  const rendered = renderTranslationSystemPrompt(
    'Lang=${targetLanguage}',
    { targetLanguage: '中文' },
    { summary: buildSummaryPromptBlock('see ${targetLanguage} later') },
  );
  ok(
    rendered.includes('see ${targetLanguage} later'),
    'summary body ${targetLanguage} is not expanded again',
  );
  ok(rendered.startsWith('Lang=中文'), 'template vars still render once');
}

{
  const rendered = renderTranslationSystemPrompt(
    'BASE',
    {},
    {
      glossary: '# Terminology glossary for this batch\nGLOSS',
      summary: buildSummaryPromptBlock('SUM'),
    },
  );
  const g = rendered.indexOf('GLOSS');
  const s = rendered.indexOf('SUM');
  ok(g >= 0 && s > g, 'glossary block is appended before the summary block');
}

equal(buildSummaryPromptBlock(''), '', 'empty summary builds no block');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
