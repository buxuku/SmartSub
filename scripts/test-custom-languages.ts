import assert from 'node:assert/strict';
import {
  CUSTOM_LANGUAGE_LIMIT,
  getCustomLanguageName,
  mergeLanguageOptions,
  sanitizeCustomLanguages,
  validateCustomLanguage,
} from '../types/language';

const builtIn = [
  { name: '中文', value: 'zh' },
  { name: 'English', value: 'en' },
];

assert.equal(
  validateCustomLanguage(
    { name: 'Uyghur', value: 'ug' },
    { builtInCodes: builtIn.map((item) => item.value) },
  ),
  null,
);
assert.equal(
  validateCustomLanguage(
    { name: 'British English', value: 'en-GB' },
    { builtInCodes: builtIn.map((item) => item.value) },
  ),
  null,
);
assert.equal(
  validateCustomLanguage(
    { name: 'Serbian Latin', value: 'sr_Latn' },
    { builtInCodes: builtIn.map((item) => item.value) },
  ),
  null,
);
assert.equal(
  validateCustomLanguage(
    { name: 'Duplicate built-in', value: 'EN' },
    { builtInCodes: builtIn.map((item) => item.value) },
  ),
  'builtInCode',
);
assert.equal(
  validateCustomLanguage(
    { name: 'Automatic detection', value: 'AUTO' },
    { builtInCodes: builtIn.map((item) => item.value) },
  ),
  'builtInCode',
);
assert.equal(
  validateCustomLanguage({ name: 'Bad', value: '../xx' }, { builtInCodes: [] }),
  'invalidCode',
);
assert.equal(
  validateCustomLanguage(
    { name: 'x'.repeat(65), value: 'x-long-name' },
    { builtInCodes: [] },
  ),
  'invalidName',
);
assert.equal(
  validateCustomLanguage(
    { name: 'Duplicate', value: 'UG' },
    {
      builtInCodes: [],
      existingCustomLanguages: [{ name: 'Uyghur', value: 'ug' }],
    },
  ),
  'duplicateCode',
);

const sanitized = sanitizeCustomLanguages(
  [
    { name: ' Uyghur ', value: ' ug ' },
    { name: 'Duplicate', value: 'UG' },
    { name: 'Built-in', value: 'zh' },
    { name: '', value: 'empty-name' },
    null,
    { name: 'Klingon', value: 'tlh' },
  ],
  builtIn.map((item) => item.value),
);
assert.deepEqual(sanitized, [
  { name: 'Uyghur', value: 'ug' },
  { name: 'Klingon', value: 'tlh' },
]);

const merged = mergeLanguageOptions(builtIn, sanitized);
assert.deepEqual(
  merged.map(({ value, isCustom }) => ({ value, isCustom })),
  [
    { value: 'zh', isCustom: false },
    { value: 'en', isCustom: false },
    { value: 'ug', isCustom: true },
    { value: 'tlh', isCustom: true },
  ],
);
assert.equal(getCustomLanguageName('UG', sanitized), 'Uyghur');
assert.equal(getCustomLanguageName('missing', sanitized), undefined);

const tooMany = Array.from(
  { length: CUSTOM_LANGUAGE_LIMIT + 10 },
  (_, index) => ({ name: `Language ${index}`, value: `x-${index}` }),
);
assert.equal(
  sanitizeCustomLanguages(tooMany, []).length,
  CUSTOM_LANGUAGE_LIMIT,
);

console.log('custom language tests passed');
