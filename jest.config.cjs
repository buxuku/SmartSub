const createJestConfig = require('next/jest')({ dir: './renderer' });

module.exports = createJestConfig({
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
