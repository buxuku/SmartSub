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
  shouldUseEpisodeSummary,
  computeSummaryFingerprint,
  decideSummaryReuse,
  clearedSummaryFields,
  disabledSummaryPatch,
  isSummaryStageActive,
  resolveResumeSummaryState,
} from '../main/helpers/episodeSummaryCore';
import {
  buildSummaryPromptBlock,
  renderGlossarySystemPrompt,
  renderTranslationSystemPrompt,
} from '../main/glossary/core';
import { defaultSystemPrompt } from '../types/provider';
import { createDebouncedPersist } from '../renderer/lib/debouncedPersist';
import { equal, ok, reportSummaryTests } from './summaryTestHarness';
import { runSummaryCapTests } from './test-summary-cap';
import { runSummaryProviderTests } from './test-summary-provider';
import { runSummaryUsageTests } from './test-summary-usage';

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
ok(
  !defaultSummaryPrompt.includes('使用表内译名'),
  'factory prompt does not ask the summary to use glossary translations',
);
ok(
  defaultSummaryPrompt.includes('源字幕中的写法') &&
    defaultSummaryPrompt.includes('不要') &&
    defaultSummaryPrompt.includes('表内译文'),
  'factory prompt keeps source proper nouns; glossary is not for rewriting the summary',
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
  ok(
    inst.includes('当前法语→简体中文'),
    'summary instructions replace language vars',
  );
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
  ok(
    inst.includes('Alice') && inst.includes('艾丽丝'),
    'summary glossary lists terms',
  );
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
    (
      settleSummaryText('<think>hide</think>\nVisible summary') as {
        text: string;
      }
    ).text === 'Visible summary',
  'closed think tags are stripped and remaining text kept',
);

// ── debounced summary-prompt persistence ─────────────────────────────────

{
  const persisted: string[] = [];
  const writer = createDebouncedPersist<string>((value) => {
    persisted.push(value);
  }, 400);

  writer.schedule('first draft');
  writer.schedule('latest draft');
  equal(persisted, [], 'debounced prompt edits do not persist immediately');

  writer.flush();
  equal(
    persisted,
    ['latest draft'],
    'page-exit flush persists the latest pending prompt edit',
  );

  writer.flush();
  equal(persisted, ['latest draft'], 'flush is a no-op with no pending edit');
}

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
  ok(
    rendered.includes('CONTEXT'),
    'placeholder ${summary} is replaced in place',
  );
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

// ── shouldUseEpisodeSummary ───────────────────────────────────────────────

ok(
  shouldUseEpisodeSummary(
    { generateSummary: true },
    { episodeSummary: '  本集讲了撤退  ' },
  ),
  'injects summary only when generateSummary is on and text is non-empty',
);
ok(
  !shouldUseEpisodeSummary(
    { generateSummary: false },
    { episodeSummary: '旧摘要' },
  ),
  'generateSummary false ignores a non-empty episodeSummary',
);
ok(
  !shouldUseEpisodeSummary(undefined, { episodeSummary: '旧摘要' }),
  'missing generateSummary ignores a non-empty episodeSummary',
);
ok(
  !shouldUseEpisodeSummary({ generateSummary: true }, { episodeSummary: '   ' }),
  'blank episodeSummary is not injected',
);
ok(
  !shouldUseEpisodeSummary({ generateSummary: true }, {}),
  'missing episodeSummary is not injected',
);

// ── computeSummaryFingerprint ─────────────────────────────────────────────

{
  const base = {
    source: '1\n2',
    prompt: '提示${sourceLanguage}',
    providerId: 'prov-1',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
  };
  const fingerprint = computeSummaryFingerprint(base);
  equal(
    fingerprint,
    '520fac0d4efbe907e1195d87df15a46f41a25b50',
    'fingerprint is sha1 of the five fields in order',
  );
  equal(
    computeSummaryFingerprint(base),
    fingerprint,
    'same fingerprint inputs produce the same hash',
  );
  ok(
    /^[0-9a-f]{40}$/.test(fingerprint),
    'fingerprint is lowercase sha1 hex',
  );
  const changed = [
    ['source', { source: '1\n2x' }],
    ['prompt', { prompt: '提示${targetLanguage}' }],
    ['providerId', { providerId: 'prov-2' }],
    ['sourceLanguage', { sourceLanguage: 'fr' }],
    ['targetLanguage', { targetLanguage: 'zh-TW' }],
  ] as const;
  for (const [field, patch] of changed) {
    ok(
      computeSummaryFingerprint({ ...base, ...patch }) !== fingerprint,
      `changing ${field} changes the fingerprint`,
    );
  }
  ok(
    computeSummaryFingerprint({
      ...base,
      source: 'a","',
      prompt: 'b',
    }) !==
      computeSummaryFingerprint({
        ...base,
        source: 'a',
        prompt: '","b',
      }),
    'json array encoding keeps adjacent fields unambiguous',
  );
}

// ── decideSummaryReuse ────────────────────────────────────────────────────

equal(
  decideSummaryReuse({
    existing: '  本集摘要  ',
    storedHash: 'abc',
    fingerprint: 'abc',
  }),
  'reuse',
  'reuses when trimmed summary is non-empty and hash matches',
);
equal(
  decideSummaryReuse({
    existing: '旧摘要',
    storedHash: undefined,
    fingerprint: 'abc',
  }),
  'regenerate',
  'legacy summary with no storedHash regenerates',
);
equal(
  decideSummaryReuse({
    existing: '旧摘要',
    storedHash: '',
    fingerprint: 'abc',
  }),
  'regenerate',
  'empty storedHash regenerates',
);
equal(
  decideSummaryReuse({
    existing: '旧摘要',
    storedHash: 'abc',
    fingerprint: 'xyz',
  }),
  'regenerate',
  'hash mismatch regenerates',
);
equal(
  decideSummaryReuse({
    existing: '   ',
    storedHash: 'abc',
    fingerprint: 'abc',
  }),
  'regenerate',
  'blank summary regenerates even when the hash matches',
);
equal(
  decideSummaryReuse({
    existing: '',
    storedHash: 'abc',
    fingerprint: 'abc',
  }),
  'regenerate',
  'empty summary regenerates',
);

// ── clearedSummaryFields ──────────────────────────────────────────────────

{
  const patch = clearedSummaryFields();
  for (const key of [
    'episodeSummary',
    'summaryUsage',
    'summarySourceHash',
  ] as const) {
    ok(key in patch, `cleared patch keeps ${key}`);
    equal(patch[key], undefined, `${key} is cleared to undefined`);
  }
  const merged = {
    episodeSummary: '旧摘要',
    summaryUsage: { output_tokens: 3 },
    summarySourceHash: 'old-hash',
    fileName: 'keep',
    ...patch,
  };
  ok(
    merged.episodeSummary === undefined &&
      merged.summaryUsage === undefined &&
      merged.summarySourceHash === undefined &&
      merged.fileName === 'keep',
    'spreading the cleared patch overwrites stale summary fields',
  );
}

// ── disabledSummaryPatch ──────────────────────────────────────────────────

{
  const patch = disabledSummaryPatch();
  for (const key of [
    'episodeSummary',
    'summaryUsage',
    'summarySourceHash',
    'summarizeEpisode',
    'summarizeEpisodeError',
  ] as const) {
    ok(key in patch, `disabled summary patch keeps ${key}`);
    equal(patch[key], undefined, `disabled summary patch clears ${key}`);
  }
  const merged = {
    episodeSummary: '旧摘要',
    summaryUsage: { output_tokens: 3 },
    summarySourceHash: 'old-hash',
    summarizeEpisode: 'done' as const,
    summarizeEpisodeError: 'skipped-trivial',
    fileName: 'keep',
    ...patch,
  };
  ok(
    merged.summarizeEpisode === undefined &&
      merged.summarizeEpisodeError === undefined &&
      merged.episodeSummary === undefined &&
      merged.summaryUsage === undefined &&
      merged.summarySourceHash === undefined &&
      merged.fileName === 'keep',
    'spreading the disabled patch clears stage status and the error tooltip',
  );
}

// ── isSummaryStageActive ──────────────────────────────────────────────────

ok(
  !isSummaryStageActive({
    generateSummary: true,
    taskType: 'generateOnly',
    translateProvider: 'openai',
  }),
  'generateOnly with summary on does not run the summary stage',
);
ok(
  !isSummaryStageActive({
    generateSummary: true,
    taskType: 'translateOnly',
    translateProvider: '-1',
  }),
  'translateOnly with provider -1 does not run the summary stage',
);
ok(
  isSummaryStageActive({
    generateSummary: true,
    taskType: 'generateAndTranslate',
    translateProvider: 'openai',
  }),
  'generateAndTranslate with a real provider runs the summary stage',
);
ok(
  isSummaryStageActive({
    generateSummary: true,
    taskType: 'translateOnly',
    translateProvider: 'openai',
  }),
  'translateOnly with a real provider runs the summary stage',
);
ok(
  !isSummaryStageActive({
    generateSummary: false,
    taskType: 'generateAndTranslate',
    translateProvider: 'openai',
  }),
  'summary off does not run the summary stage',
);
ok(
  !isSummaryStageActive({
    taskType: 'generateAndTranslate',
    translateProvider: 'openai',
  }),
  'missing generateSummary does not run the summary stage',
);
ok(
  !isSummaryStageActive({
    generateSummary: true,
    taskType: 'generateAndTranslate',
    translateProvider: '-1',
  }),
  'generateAndTranslate with provider -1 does not run the summary stage',
);

// ── resolveResumeSummaryState ─────────────────────────────────────────────

equal(
  resolveResumeSummaryState({
    stageActive: false,
    existing: '本集摘要',
    storedHash: 'abc',
    fingerprint: 'abc',
  }),
  null,
  'inactive stage emits nothing even when the summary could be reused',
);
equal(
  resolveResumeSummaryState({
    stageActive: false,
    existing: undefined,
    storedHash: undefined,
    fingerprint: null,
  }),
  null,
  'inactive stage emits nothing when fingerprint and summary are missing',
);

{
  const reused = resolveResumeSummaryState({
    stageActive: true,
    existing: '  本集摘要  ',
    storedHash: 'abc',
    fingerprint: 'abc',
  });
  equal(
    reused,
    { summarizeEpisode: 'done', summarizeEpisodeError: undefined },
    'matching fingerprint marks the resumed summary done',
  );
  ok(
    reused !== null &&
      'summarizeEpisodeError' in reused &&
      reused.summarizeEpisodeError === undefined &&
      !('episodeSummary' in reused) &&
      !('summaryUsage' in reused) &&
      !('summarySourceHash' in reused),
    'reuse patch clears summarizeEpisodeError and leaves the summary',
  );
}

function expectSkippedResume(
  input: {
    stageActive: boolean;
    existing: string | undefined;
    storedHash: string | undefined;
    fingerprint: string | null;
  },
  name: string,
): void {
  const patch = resolveResumeSummaryState(input);
  if (
    patch === null ||
    !('summarizeEpisodeError' in patch) ||
    patch.summarizeEpisodeError !== 'skipped-resume'
  ) {
    ok(false, name);
    console.error(
      `  expected skipped-resume patch, got ${JSON.stringify(patch)}`,
    );
    return;
  }
  equal(patch.summarizeEpisode, 'done', `${name}: stage is done`);
  equal(
    patch.summarizeEpisodeError,
    'skipped-resume',
    `${name}: error is skipped-resume`,
  );
  for (const key of [
    'episodeSummary',
    'summaryUsage',
    'summarySourceHash',
  ] as const) {
    ok(key in patch, `${name}: keeps ${key}`);
    equal(patch[key], undefined, `${name}: ${key} is cleared to undefined`);
  }
  const merged = {
    episodeSummary: '旧摘要',
    summaryUsage: { output_tokens: 3 },
    summarySourceHash: 'old-hash',
    summarizeEpisodeError: 'call-failed',
    fileName: 'keep',
    ...patch,
  };
  ok(
    merged.summarizeEpisode === 'done' &&
      merged.summarizeEpisodeError === 'skipped-resume' &&
      merged.episodeSummary === undefined &&
      merged.summaryUsage === undefined &&
      merged.summarySourceHash === undefined &&
      merged.fileName === 'keep',
    `${name}: spreading the patch clears the stale summary and sets skipped-resume`,
  );
}

expectSkippedResume(
  {
    stageActive: true,
    existing: '旧摘要',
    storedHash: 'abc',
    fingerprint: null,
  },
  'null fingerprint skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: '',
    storedHash: 'abc',
    fingerprint: 'abc',
  },
  'empty summary skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: '   ',
    storedHash: 'abc',
    fingerprint: 'abc',
  },
  'blank summary skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: undefined,
    storedHash: 'abc',
    fingerprint: 'abc',
  },
  'missing summary skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: '旧摘要',
    storedHash: undefined,
    fingerprint: 'abc',
  },
  'legacy summary with no stored hash skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: '旧摘要',
    storedHash: '',
    fingerprint: 'abc',
  },
  'empty stored hash skips instead of regenerating',
);
expectSkippedResume(
  {
    stageActive: true,
    existing: '旧摘要',
    storedHash: 'abc',
    fingerprint: 'xyz',
  },
  'fingerprint mismatch skips instead of regenerating',
);

runSummaryProviderTests();
runSummaryUsageTests();
runSummaryCapTests()
  .then(() => {
    reportSummaryTests();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
