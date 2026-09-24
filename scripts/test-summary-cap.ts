/**
 * 摘要长度上限单测。由 test-summary.ts 调用，计数写进 summaryTestHarness。
 */
import {
  SUMMARY_MAX_UNITS,
  measureSummary,
} from '../types/summaryPrompt';
import {
  enforceSummaryCap,
  normalizeReusedSummary,
  truncateSummary,
} from '../main/helpers/episodeSummaryCore';
import { isTaskCancelledError } from '../main/helpers/taskContext';
import { equal, ok } from './summaryTestHarness';

function summaryWords(count: number, prefix: string): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(`${prefix}${i}`);
  return parts.join(' ');
}

function testMeasureSummaryCounts(): void {
  equal(SUMMARY_MAX_UNITS, 400, 'summary cap is 400 units');
  equal(measureSummary('   ', 'zh'), 0, 'blank CJK summary measures 0');
  equal(measureSummary('', 'en'), 0, 'empty English summary measures 0');
  equal(
    measureSummary('  甲乙  ', 'zh'),
    2,
    'CJK measure trims before counting code points',
  );
  equal(
    measureSummary('甲\n乙 丙\t丁', 'zh-CN'),
    4,
    'CJK measure skips whitespace so line breaks do not count',
  );
  equal(measureSummary('甲\u3000乙', 'ja'), 2, 'CJK measure skips ideographic space');
  equal(
    measureSummary('\u{1F43A}\u{1F43A}', 'ko'),
    2,
    'CJK measure counts a surrogate pair as one code point',
  );
  equal(measureSummary('one two', 'zh'), 6, 'CJK target counts code points, not words');
  equal(measureSummary('甲乙', 'ZH_Hant'), 2, 'CJK primary subtag is case-insensitive');
  equal(measureSummary('甲乙', 'yue-Hant-HK'), 2, 'yue primary subtag counts code points');
  equal(measureSummary('甲乙', 'ja_JP'), 2, 'underscore language tags split like BCP 47');
}

function testMeasureSummaryWords(): void {
  equal(measureSummary('one two three', 'en'), 3, 'non-CJK target counts words');
  equal(
    measureSummary('  one   two\tthree  ', 'en-US'),
    3,
    'English measure trims and ignores extra whitespace',
  );
  equal(
    measureSummary('one,two three', 'fr'),
    3,
    'segmenter counts words split by punctuation',
  );
  equal(
    measureSummary('one two', 'jpn'),
    2,
    'unknown primary subtag is not treated as Japanese',
  );
}

function testMeasureSummaryFallback(): void {
  const intlAny = Intl as { Segmenter?: unknown };
  const saved = intlAny.Segmenter;
  intlAny.Segmenter = undefined;
  try {
    equal(
      measureSummary('one,two three', 'en'),
      2,
      'without Segmenter, words fall back to whitespace splits',
    );
    equal(
      measureSummary('  one   two  ', 'de'),
      2,
      'whitespace fallback ignores extra spaces',
    );
  } finally {
    intlAny.Segmenter = saved;
  }
}

function testTruncateCjkHardCut(): void {
  equal(truncateSummary('甲乙丙', 'zh'), '甲乙丙', 'CJK text inside the cap is kept');
  equal(
    truncateSummary(`  ${'甲'.repeat(400)}  `, 'zh'),
    '甲'.repeat(400),
    'CJK text inside the cap is trimmed and not cut',
  );
  equal(
    truncateSummary('甲'.repeat(401), 'zh'),
    '甲'.repeat(400),
    'CJK text over the cap hard-cuts at 400 code points',
  );
  equal(
    truncateSummary('甲 乙 丙丁', 'zh', 3),
    '甲 乙 丙',
    'CJK hard cut keeps internal spaces and stops on a code point',
  );
  const wolf = '\u{1F43A}';
  equal(
    truncateSummary(wolf.repeat(5), 'ja', 3),
    wolf.repeat(3),
    'CJK hard cut does not split a surrogate pair',
  );
}

function testTruncateCjkSentence(): void {
  const early = `甲。${'乙'.repeat(500)}`;
  equal(
    truncateSummary(early, 'zh', 400),
    `甲。${'乙'.repeat(398)}`,
    'CJK sentence end under half the cap falls through to a hard cut',
  );
  ok(
    measureSummary(truncateSummary(early, 'zh', 400), 'zh') <= 400,
    'CJK hard cut stays within the cap',
  );
  const sentence = `${'甲'.repeat(250)}。${'乙'.repeat(200)}`;
  equal(
    truncateSummary(sentence, 'zh', 400),
    `${'甲'.repeat(250)}。`,
    'CJK truncation prefers the last sentence end that still fits',
  );
  const quoted = `${'甲'.repeat(210)}。”${'丁'.repeat(300)}`;
  equal(
    truncateSummary(quoted, 'ko', 400),
    `${'甲'.repeat(210)}。”`,
    'CJK sentence cut keeps one trailing closer',
  );
  const longer = `甲。${'乙'.repeat(10)}。${'丙'.repeat(20)}`;
  equal(
    truncateSummary(longer, 'yue', 15),
    `甲。${'乙'.repeat(10)}。`,
    'CJK truncation takes the longest sentence prefix at or above half the cap',
  );
}

function testTruncateEnglishWords(): void {
  equal(truncateSummary('one two', 'en'), 'one two', 'English text inside the cap is kept');
  equal(
    truncateSummary('  one two  ', 'en'),
    'one two',
    'English text inside the cap is trimmed',
  );
  equal(
    truncateSummary('alpha beta gamma', 'en', 2),
    'alpha beta',
    'English hard cut stops on a word boundary',
  );
  equal(
    truncateSummary('alpha, beta gamma', 'en', 2),
    'alpha, beta',
    'English hard cut does not split the second word',
  );
  equal(
    truncateSummary('one two. three four five six', 'en', 4),
    'one two.',
    'English sentence end at half the cap is kept',
  );
  equal(
    truncateSummary('one two. three four five six', 'en', 5),
    'one two. three four five',
    'English sentence end under half the cap falls through to a word cut',
  );
}

function testTruncateEnglishSentence(): void {
  const sentence = `${summaryWords(250, 'w')}. ${summaryWords(200, 'x')}`;
  const cut = truncateSummary(sentence, 'en-US', 400);
  equal(measureSummary(cut, 'en'), 250, 'English sentence cut is counted in words');
  ok(cut.endsWith('.'), 'English sentence cut ends on the terminator');
  ok(!cut.includes('x0'), 'English sentence cut drops the following sentence');

  const quoted = `${summaryWords(210, 'w')}." ${summaryWords(250, 'x')}`;
  const quotedCut = truncateSummary(quoted, 'fr', 400);
  ok(quotedCut.endsWith('."'), 'English sentence cut keeps a trailing closer');
  equal(measureSummary(quotedCut, 'fr'), 210, 'closer does not add a word');
}

function testTruncateEnglishHardCut(): void {
  const early = `Hi. ${summaryWords(500, 'w')}`;
  const cut = truncateSummary(early, 'en', 400);
  equal(measureSummary(cut, 'en'), 400, 'English hard cut keeps 400 words');
  ok(cut.startsWith('Hi.'), 'English hard cut keeps the short opener');
  ok(cut.endsWith('w398'), 'English hard cut stops after the 400th word');
  ok(!/(^|\s)w399(\s|$)/.test(cut), 'English hard cut does not take a 401st word');
}

function testTruncateWordFallback(): void {
  const intlAny = Intl as { Segmenter?: unknown };
  const saved = intlAny.Segmenter;
  intlAny.Segmenter = undefined;
  try {
    equal(
      truncateSummary('one,two three four', 'en', 2),
      'one,two three',
      'without Segmenter, the word cut falls back to whitespace',
    );
  } finally {
    intlAny.Segmenter = saved;
  }
}

function testNormalizeReusedSummary(): void {
  const over = '甲'.repeat(401);
  const once = normalizeReusedSummary(over, 'zh');
  ok(once.changed, 'over-cap stored summary is marked changed');
  ok(
    measureSummary(once.text, 'zh') <= SUMMARY_MAX_UNITS,
    'over-cap stored summary is truncated to the cap',
  );
  equal(once.originalUnits, 401, 'over-cap reuse records the original units');
  equal(
    once.finalUnits,
    measureSummary(once.text, 'zh'),
    'over-cap reuse records the kept units',
  );
  const twice = normalizeReusedSummary(once.text, 'zh');
  equal(twice.changed, false, 'normalizing the capped summary again does not change it');
  equal(twice.text, once.text, 'a second normalize keeps the capped text');

  const kept = '甲'.repeat(20);
  const inbound = normalizeReusedSummary(kept, 'zh');
  equal(inbound.changed, false, 'in-bounds stored summary is unchanged');
  equal(inbound.text, kept, 'in-bounds stored summary keeps its text');
  equal(inbound.originalUnits, 20, 'in-bounds reuse records 20 original units');
  equal(inbound.finalUnits, 20, 'in-bounds reuse records 20 final units');
}

async function testEnforceInsideCap(): Promise<void> {
  let calls = 0;
  const text = '甲'.repeat(400);
  const result = await enforceSummaryCap({
    text,
    targetLang: 'zh',
    compress: async () => {
      calls += 1;
      return '不该调用';
    },
  });
  equal(calls, 0, '400 CJK units do not retry');
  equal(
    result,
    {
      text,
      originalUnits: 400,
      finalUnits: 400,
      retried: false,
      truncated: false,
    },
    'text inside the cap is returned as-is',
  );

  calls = 0;
  const english = summaryWords(400, 'w');
  const englishResult = await enforceSummaryCap({
    text: english,
    targetLang: 'en',
    compress: async () => {
      calls += 1;
      return 'nope';
    },
  });
  equal(calls, 0, '400 English words do not retry');
  equal(englishResult.originalUnits, 400, 'English cap is counted in words');
  equal(englishResult.finalUnits, 400, 'English text inside the cap keeps 400 words');
  equal(englishResult.retried, false, 'English text inside the cap does not retry');
}

async function testEnforceSuccessfulRetry(): Promise<void> {
  const text = '甲'.repeat(401);
  let calls = 0;
  let seenText = '';
  let seenMax = -1;
  const result = await enforceSummaryCap({
    text,
    targetLang: 'zh-CN',
    compress: async (body, maxUnits) => {
      calls += 1;
      seenText = body;
      seenMax = maxUnits;
      return '甲'.repeat(8);
    },
  });
  equal(calls, 1, '401 CJK units retry exactly once');
  equal(seenText, text, 'retry compresses the first-round summary');
  equal(seenMax, SUMMARY_MAX_UNITS, 'retry receives the unit cap');
  equal(
    result,
    {
      text: '甲'.repeat(8),
      originalUnits: 401,
      retryUnits: 8,
      finalUnits: 8,
      retried: true,
      truncated: false,
    },
    'a retry inside the cap replaces the first round',
  );
}

async function testEnforceEnglishRetry(): Promise<void> {
  const text = summaryWords(401, 'e');
  let calls = 0;
  const result = await enforceSummaryCap({
    text,
    targetLang: 'en-US',
    compress: async () => {
      calls += 1;
      return 'short text';
    },
  });
  equal(calls, 1, '401 English words retry once');
  equal(result.text, 'short text', 'English retry keeps the compressed text');
  equal(result.originalUnits, 401, 'English overflow is counted in words');
  equal(result.retryUnits, 2, 'English retry length is counted in words');
  equal(result.finalUnits, 2, 'English final length is counted in words');
  equal(result.truncated, false, 'English retry inside the cap is not truncated');
}

async function testEnforceSettledShapes(): Promise<void> {
  const arrayResult = await enforceSummaryCap({
    text: '甲'.repeat(401),
    targetLang: 'ja',
    compress: async () => ['甲乙', '丙丁'],
  });
  equal(arrayResult.text, '甲乙\n丙丁', 'array retry is joined before measuring');
  equal(arrayResult.retryUnits, 4, 'joined array retry counts code points');
  equal(arrayResult.truncated, false, 'joined array inside the cap is not truncated');
  equal(arrayResult.retried, true, 'array retry counts as a retry');

  const thinkResult = await enforceSummaryCap({
    text: '甲'.repeat(401),
    targetLang: 'ko',
    compress: async () => '<think>hide</think>\n甲乙丙',
  });
  equal(thinkResult.text, '甲乙丙', 'think tags are stripped from a retry');
  equal(thinkResult.finalUnits, 3, 'stripped retry is measured without the think block');
  equal(thinkResult.truncated, false, 'stripped retry inside the cap is not truncated');
}

async function testEnforceThinkOnly(): Promise<void> {
  const result = await enforceSummaryCap({
    text: '甲'.repeat(401),
    targetLang: 'zh',
    compress: async () => '<think>only',
  });
  equal(result.text, '甲'.repeat(400), 'think-only retry truncates the first round');
  equal(result.originalUnits, 401, 'think-only retry keeps the original length');
  equal(result.retryUnits, undefined, 'think-only retry has no settled length');
  equal(result.finalUnits, 400, 'think-only fallback is the hard cut');
  equal(result.retried, true, 'think-only retry still counts as a retry');
  equal(result.truncated, true, 'think-only retry is marked truncated');
  equal(result.retryError, undefined, 'a settled empty retry is not a compress error');
}

async function testEnforceStillOverCap(): Promise<void> {
  const text = `${'甲'.repeat(250)}。${'乙'.repeat(200)}`;
  const result = await enforceSummaryCap({
    text,
    targetLang: 'zh',
    compress: async () => '丙'.repeat(450),
  });
  equal(
    result.text,
    `${'甲'.repeat(250)}。`,
    'a retry that is still over the cap truncates the first round at the sentence',
  );
  equal(result.retryUnits, 450, 'over-cap retry length is recorded');
  equal(result.finalUnits, 251, 'sentence truncation length is the kept prefix');
  equal(result.truncated, true, 'over-cap retry is marked truncated');
  ok(!result.text.includes('丙'), 'over-cap retry text is discarded');
  equal(result.retryError, undefined, 'an over-cap retry is not a compress error');
}

async function testEnforceCompressThrows(): Promise<void> {
  const result = await enforceSummaryCap({
    text: '甲'.repeat(401),
    targetLang: 'yue',
    compress: async () => {
      throw new Error('network down');
    },
  });
  equal(result.text, '甲'.repeat(400), 'a failed retry hard-cuts the first round');
  equal(result.retryUnits, undefined, 'a thrown retry has no settled length');
  equal(result.retried, true, 'a thrown retry still counts as a retry');
  equal(result.truncated, true, 'a thrown retry is marked truncated');
  ok(
    measureSummary(result.text, 'yue') <= SUMMARY_MAX_UNITS,
    'thrown-retry fallback stays inside the cap',
  );
  ok(
    typeof result.retryError === 'string' && result.retryError.indexOf('network down') >= 0,
    'a thrown retry records the error message',
  );
}

async function testEnforceEnglishThrow(): Promise<void> {
  const text = `${summaryWords(250, 'w')}. ${summaryWords(200, 'x')}`;
  const result = await enforceSummaryCap({
    text,
    targetLang: 'en',
    compress: async () => {
      throw new Error('network');
    },
  });
  equal(result.originalUnits, 450, 'English overflow before retry is 450 words');
  equal(
    measureSummary(result.text, 'en'),
    250,
    'failed English retry truncates at the sentence in words',
  );
  ok(result.text.endsWith('.'), 'failed English retry ends on the terminator');
  ok(!result.text.includes('x0'), 'failed English retry drops the next sentence');
  equal(result.truncated, true, 'failed English retry is marked truncated');
}

async function testEnforceCustomCap(): Promise<void> {
  const text = '甲'.repeat(11);
  let calls = 0;
  const result = await enforceSummaryCap({
    text,
    targetLang: 'zh',
    maxUnits: 10,
    compress: async (body, maxUnits) => {
      calls += 1;
      equal(body, text, 'custom cap still sends the first-round text');
      equal(maxUnits, 10, 'custom cap is forwarded to compress');
      return '乙'.repeat(11);
    },
  });
  equal(calls, 1, 'custom cap retries once');
  equal(result.text, '甲'.repeat(10), 'custom cap hard-cuts the first round');
  equal(result.originalUnits, 11, 'custom cap records the original units');
  equal(result.retryUnits, 11, 'custom cap records the retry units');
  equal(result.finalUnits, 10, 'custom cap final units honor maxUnits');
}

async function testEnforceCancellation(): Promise<void> {
  const cancel = new Error('TASK_CANCELLED');
  let threw = false;
  try {
    await enforceSummaryCap({
      text: '甲'.repeat(401),
      targetLang: 'zh',
      compress: async () => {
        throw cancel;
      },
    });
  } catch (error) {
    threw = true;
    ok(error === cancel, 'cancellation is rethrown unchanged');
    ok(isTaskCancelledError(error), 'rethrown error is a cancellation');
  }
  ok(threw, 'cancellation is not turned into a truncation');
}

export async function runSummaryCapTests(): Promise<void> {
  testMeasureSummaryCounts();
  testMeasureSummaryWords();
  testMeasureSummaryFallback();
  testTruncateCjkHardCut();
  testTruncateCjkSentence();
  testTruncateEnglishWords();
  testTruncateEnglishSentence();
  testTruncateEnglishHardCut();
  testTruncateWordFallback();
  testNormalizeReusedSummary();
  await testEnforceInsideCap();
  await testEnforceSuccessfulRetry();
  await testEnforceEnglishRetry();
  await testEnforceSettledShapes();
  await testEnforceThinkOnly();
  await testEnforceStillOverCap();
  await testEnforceCompressThrows();
  await testEnforceEnglishThrow();
  await testEnforceCustomCap();
  await testEnforceCancellation();
}
