const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(file, needle, message) {
  assert(file.includes(needle), message);
}

function assertNotIncludes(file, needle, message) {
  assert(!file.includes(needle), message);
}

const utils = read('main/helpers/utils.ts');
assertIncludes(
  utils,
  "sourceLanguage: 'ja'",
  'Default source language should be Japanese.',
);

const userConfig = read('main/helpers/userConfig.ts');
assertIncludes(
  userConfig,
  'japaneseDefaultsMigrated',
  'Existing legacy default configs should be migrated once.',
);
assertIncludes(
  userConfig,
  "mergedConfig.sourceLanguage === 'en'",
  'Japanese defaults migration should detect the old English source default.',
);

const ipcStoreHandlers = read('main/helpers/ipcStoreHandlers.ts');
assertIncludes(
  ipcStoreHandlers,
  'getUserConfigWithJapaneseDefaults',
  'getUserConfig should return the Japanese-focused normalized config.',
);
assertIncludes(
  utils,
  "targetLanguage: 'zh'",
  'Default target language should remain Chinese.',
);

const deeplx = read('main/service/deeplx.ts');
assertIncludes(
  deeplx,
  'sourceLanguage',
  'DeepLX translator should accept the selected source language.',
);
assertIncludes(
  deeplx,
  'targetLanguage',
  'DeepLX translator should accept the selected target language.',
);
assertNotIncludes(
  deeplx,
  "source_lang: 'en'",
  'DeepLX source language must not be hard-coded to English.',
);
assertNotIncludes(
  deeplx,
  "target_lang: 'zh'",
  'DeepLX target language must not be hard-coded to Chinese.',
);

const translateControl = read('renderer/pages/[locale]/translateControl.tsx');
assertIncludes(
  translateControl,
  'userConfig?.sourceLanguage',
  'Provider test translation should use the selected source language.',
);
assertIncludes(
  translateControl,
  'userConfig?.targetLanguage',
  'Provider test translation should use the selected target language.',
);
assertNotIncludes(
  translateControl,
  "sourceLanguage: 'en'",
  'Provider test translation must not be hard-coded to English source.',
);

const translateIndex = read('main/translate/index.ts');
assertIncludes(
  translateIndex,
  'getTestSubtitleContent',
  'Test translation should select sample text by source language.',
);
assertNotIncludes(
  translateIndex,
  "content: ['Hello China']",
  'Test translation sample must not always be English.',
);

const subtitleDetector = read('main/helpers/subtitleDetector.ts');
assertIncludes(
  subtitleDetector,
  'classifySubtitleType',
  'Subtitle detector should classify files against selected languages.',
);
assertNotIncludes(
  subtitleDetector,
  "detectedLangCode === 'en' ? 'source' : 'translated'",
  'Subtitle detector must not treat English as the universal source.',
);
assertNotIncludes(
  subtitleDetector,
  'isEnglish',
  'Subtitle matching should not rely on English as the universal source language.',
);

const proofreadUtils = read('renderer/lib/proofreadUtils.ts');
assertIncludes(
  proofreadUtils,
  'getPreferredProofreadLanguages',
  'Proofread utilities should load the selected source/target languages.',
);
assertNotIncludes(
  proofreadUtils,
  "lang === 'en'",
  'Proofread utilities must not treat English as the universal source language.',
);

const proofreadImport = read('renderer/components/proofread/ProofreadImport.tsx');
assertNotIncludes(
  proofreadImport,
  "lang === 'en'",
  'Proofread folder import must not treat English as the universal source language.',
);

const proofreadFileList = read(
  'renderer/components/proofread/ProofreadFileList.tsx',
);
assertNotIncludes(
  proofreadFileList,
  "lang === 'en'",
  'Proofread append flow must not treat English as the universal source language.',
);

console.log('Japanese-focused checks passed.');
