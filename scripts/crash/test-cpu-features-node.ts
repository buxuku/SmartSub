import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNodeProbeDeps,
  runCommand,
  runCommandOrThrow,
} from '../../main/helpers/crash/cpuFeaturesNode';
import { unknownFeatures } from '../../main/helpers/crash/cpuFeatures';
import { assert, finish, test } from './testkit';

async function withTempDir(run: (dir: string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-cpu-node-'));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await test('runCommand：成功时返回标准输出', async () => {
    const out = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("hello")'],
      10_000,
    );
    assert.equal(out, 'hello');
  });

  await test('runCommand：命令不存在、非零退出都返回 null，不抛错', async () => {
    assert.equal(
      await runCommand('/definitely/not/a/real/command', [], 5000),
      null,
    );
    assert.equal(
      await runCommand(process.execPath, ['-e', 'process.exit(3)'], 10_000),
      null,
    );
  });

  await test('runCommand：超时返回 null，并且不会等到命令自己结束', async () => {
    const started = Date.now();
    const out = await runCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      300,
    );
    assert.equal(out, null);
    assert.ok(Date.now() - started < 10_000, '应当在超时后很快返回');
  });

  await test('runCommandOrThrow：成功返回标准输出；失败带着原因抛出（起不来、非零退出、超时）', async () => {
    assert.equal(
      await runCommandOrThrow(
        process.execPath,
        ['-e', 'process.stdout.write("ok")'],
        10_000,
      ),
      'ok',
    );
    const reasons: string[] = [];
    for (const run of [
      () => runCommandOrThrow('/definitely/not/a/real/command', [], 5000),
      () =>
        runCommandOrThrow(
          process.execPath,
          ['-e', 'console.error("boom\\nsecond line"); process.exit(3)'],
          10_000,
        ),
      () =>
        runCommandOrThrow(
          process.execPath,
          ['-e', 'setTimeout(() => {}, 30000)'],
          300,
        ),
    ]) {
      try {
        await run();
        reasons.push('(没有抛错)');
      } catch (error) {
        reasons.push((error as Error).message);
      }
    }
    assert.equal(reasons[0], 'could not start (ENOENT)');
    assert.equal(reasons[1], 'exit code 3: boom');
    assert.equal(reasons[2], 'timed out after 300 ms');
  });

  await test('探测依赖的 run 是会抛错的版本，sysctl 仍是返回 null 的版本', async () => {
    const deps = createNodeProbeDeps({ translated: false, cacheFile: null });
    await assert.rejects(
      () => deps.run('/definitely/not/a/real/command', [], 5000),
      /could not start/,
    );
    assert.equal(
      await deps.sysctl('definitely.not.a.real.oid').catch(() => 'threw'),
      null,
    );
  });

  await test('readFile：不存在的文件返回 null', async () => {
    const deps = createNodeProbeDeps({ translated: false, cacheFile: null });
    assert.equal(await deps.readFile('/definitely/not/a/real/file'), null);
  });

  await test('不给缓存文件就没有缓存；给了就能写入再读回，坏文件当没有', async () => {
    assert.equal(
      createNodeProbeDeps({ translated: false, cacheFile: null }).cache,
      undefined,
    );
    await withTempDir((dir) => {
      const file = path.join(dir, 'cpu-features.json');
      const deps = createNodeProbeDeps({ translated: false, cacheFile: file });
      assert.ok(deps.cache);
      assert.equal(deps.cache.read(), null);

      const entry = {
        key: 'cpu|release',
        features: { ...unknownFeatures(), avx2: false },
        detectedAt: 7,
      };
      deps.cache.write(entry);
      assert.deepEqual(deps.cache.read(), entry);

      fs.writeFileSync(file, '{broken');
      assert.equal(deps.cache.read(), null);
      // 合法 JSON 但不是我们写的格式，也不能被当成缓存
      fs.writeFileSync(file, '{"unexpected":true}');
      assert.equal(deps.cache.read(), null);
    });
  });

  await test('translated 由调用方决定；平台、架构取自当前进程', () => {
    const deps = createNodeProbeDeps({ translated: true, cacheFile: null });
    assert.equal(deps.translated, true);
    assert.equal(deps.platform, process.platform);
    assert.equal(deps.arch, process.arch);
    assert.equal(deps.osRelease, os.release());
  });

  finish('cpu-features-node');
}

void main();
