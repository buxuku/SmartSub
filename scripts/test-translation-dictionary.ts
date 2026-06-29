import {
  applyTranslationDictionaryToResults,
  applyTranslationDictionaryToText,
  parseTranslationDictionary,
} from '../main/translate/utils/dictionary';

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

async function testDictionaryParsing(): Promise<void> {
  const entries = parseTranslationDictionary(`
# comment
Alice -> 艾丽丝
OpenAI=>OpenAI
  Wonderland = 仙境
Alice -> 爱丽丝
bad line
`);

  ok(entries.length === 3, 'parses valid dictionary lines');
  ok(entries[0].source === 'Wonderland', 'sorts longer source terms first');
  ok(
    entries.find((entry) => entry.source === 'Alice')?.target === '爱丽丝',
    'later duplicate source entries override earlier entries',
  );
}

async function testDictionaryPostProcess(): Promise<void> {
  const entries = parseTranslationDictionary(
    'Alice -> 艾丽丝\nAlice\\s+Smith -> 艾丽丝·史密斯\n/alice/i -> 爱丽丝',
  );
  const result = applyTranslationDictionaryToText(
    'Alice Smith met alice.',
    entries,
  );
  ok(
    result === '艾丽丝·史密斯 met 爱丽丝.',
    'applies dictionary entries as global regular expressions',
  );

  const batchResults = applyTranslationDictionaryToResults(
    [
      {
        id: '1',
        startEndTime: '00:00:01,000 --> 00:00:02,000',
        sourceContent: 'Alice Smith met alice.',
        targetContent: 'Alice Smith met alice.',
      },
    ],
    entries,
  );
  ok(
    batchResults[0].targetContent === '艾丽丝·史密斯 met 爱丽丝.',
    'applies dictionary to translation result batches',
  );

  const literalReplacement = applyTranslationDictionaryToText(
    'price',
    parseTranslationDictionary('price -> $&'),
  );
  ok(
    literalReplacement === '$&',
    'uses dictionary targets as literal replacement text',
  );
}

async function testInvalidRegexIsIgnored(): Promise<void> {
  const entries = parseTranslationDictionary(
    '[ -> bad\n/Alice/z -> bad\nAlice -> 艾丽丝',
  );
  const result = applyTranslationDictionaryToText('Alice stays.', entries);
  ok(
    result === '艾丽丝 stays.',
    'ignores invalid regular expressions and applies remaining entries',
  );
}

async function main(): Promise<void> {
  await testDictionaryParsing();
  await testDictionaryPostProcess();
  await testInvalidRegexIsIgnored();

  console.log(
    `\ntranslation dictionary tests: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
