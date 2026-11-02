import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

for (const scenario of [
  { env: 'development', args: [], expected: '/profiles/normal-dev' },
  { env: 'production', args: [], expected: '/profiles/normal' },
  {
    env: 'development',
    args: ['--automation-data-dir=/profiles/automation'],
    expected: '/profiles/automation',
  },
  {
    env: 'production',
    args: ['--automation-data-dir=/profiles/automation-production'],
    expected: '/profiles/automation-production',
  },
]) {
  test(`storage initializes in the selected profile: ${scenario.expected}`, () => {
    let userData = '/profiles/normal';
    let storeProfile: string | undefined;
    const process = {
      env: { NODE_ENV: scenario.env } as any,
      argv: scenario.args,
    };
    const constructed = new Error('stop after store construction');
    const app = {
      getPath: () => userData,
      setPath: (_name: string, value: string) => {
        userData = value;
      },
      requestSingleInstanceLock: () => true,
    };
    // Evaluate the real startup imports, bootstrap and store constructor without
    // starting Electron or writing to any user profile.
    const modules = new Set(
      [
        'main/background.ts',
        'main/helpers/uvThreadPool.ts',
        'main/automation/bootstrap.ts',
        'main/helpers/taskRuns/storageRuntime.ts',
        'main/helpers/store/index.ts',
      ].map((file) => path.resolve(file)),
    );
    function load(filename: string): any {
      const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      const exports = {};
      vm.runInNewContext(
        source,
        {
          exports,
          process,
          require(id: string) {
            if (id === 'electron') return { app };
            if (id === 'path' || id === 'node:path') return path;
            if (id === 'electron-store')
              return class {
                constructor() {
                  storeProfile = app.getPath();
                  throw constructed;
                }
              };
            const base = path.resolve(path.dirname(filename), id);
            const real = [base + '.ts', path.join(base, 'index.ts')].find(
              (file) => modules.has(file),
            );
            if (real) return load(real);
            return { startCrashReporting() {}, isAppleSilicon: () => false };
          },
        },
        { filename },
      );
      return exports;
    }
    assert.throws(
      () => load(path.resolve('main/background.ts')),
      (error) => error === constructed,
    );
    assert.equal(storeProfile, scenario.expected);
    assert.equal(process.env.UV_THREADPOOL_SIZE, '12');
  });
}
