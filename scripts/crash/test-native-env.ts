import { applyNativeCrashEnv } from '../../main/helpers/crash/nativeEnv';
import { assert, finish, test } from './testkit';

async function main() {
  await test('POSIX 且用户没设过：设置 GGML_NO_BACKTRACE=1', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const env: NodeJS.ProcessEnv = {};
      assert.deepEqual(applyNativeCrashEnv(env, platform), [
        'GGML_NO_BACKTRACE',
      ]);
      assert.equal(env.GGML_NO_BACKTRACE, '1');
    }
  });

  await test('用户自己设过就保持原值，包括 0 与空串', () => {
    for (const value of ['0', '', '1']) {
      const env: NodeJS.ProcessEnv = { GGML_NO_BACKTRACE: value };
      assert.deepEqual(applyNativeCrashEnv(env, 'linux'), []);
      assert.equal(env.GGML_NO_BACKTRACE, value);
    }
  });

  await test('Windows 不设置（ggml 在那里不会去拉调试器）', () => {
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyNativeCrashEnv(env, 'win32'), []);
    assert.equal('GGML_NO_BACKTRACE' in env, false);
  });

  finish('native-env');
}

void main();
