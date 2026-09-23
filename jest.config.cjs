const createJestConfig = require('next/jest')({ dir: './renderer' });

const config = createJestConfig({
  testEnvironment: 'jsdom',
  testMatch: [
    '<rootDir>/renderer/**/__tests__/*.test.{ts,tsx}',
    '<rootDir>/main/service/__tests__/*.test.ts',
  ],
  moduleNameMapper: {
    '^@/components/(.*)$': '<rootDir>/renderer/components/$1',
    '^@/context/(.*)$': '<rootDir>/renderer/context/$1',
    '^@/lib/(.*)$': '<rootDir>/renderer/lib/$1',
    '^lib/(.*)$': '<rootDir>/renderer/lib/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/scripts/jest-setup.cjs'],
  clearMocks: true,
});

module.exports = async () => {
  const resolved = await config();
  // react-markdown's unified/remark dependency tree is ESM-only.
  const markdownModules =
    'react-markdown|remark-.+|rehype-.+|unified|bail|devlop|extend|is-plain-obj|trough|vfile.*|unist-.+|mdast-.+|hast-.+|micromark.*|decode-named-character-reference|character-entities.*|ccount|escape-string-regexp|markdown-table|property-information|space-separated-tokens|comma-separated-tokens|zwitch|trim-lines|html-url-attributes|estree-util-is-identifier-name|longest-streak';
  resolved.transformIgnorePatterns = [
    `/node_modules/(?!(${markdownModules})/)`,
  ];
  return resolved;
};
