import {
  beginCrashContext,
  resetCrashContextForTest,
  snapshotCrashContext,
  withCrashContext,
} from '../../main/helpers/crash/crashContext';
import { assert, finish, test } from './testkit';

async function main() {
  await test('登记与移除；移除函数可重复调用', () => {
    resetCrashContextForTest();
    const end = beginCrashContext({
      engine: 'whisper-builtin',
      phase: 'transcribe',
    });
    assert.equal(snapshotCrashContext().length, 1);
    end();
    end();
    assert.equal(snapshotCrashContext().length, 0);
  });

  await test('并发任务各占一条，按开始时间升序', () => {
    resetCrashContextForTest();
    const endA = beginCrashContext({ engine: 'a' }, 200);
    const endB = beginCrashContext({ engine: 'b' }, 100);
    assert.deepEqual(
      snapshotCrashContext().map((c) => c.engine),
      ['b', 'a'],
    );
    endA();
    assert.deepEqual(
      snapshotCrashContext().map((c) => c.engine),
      ['b'],
    );
    endB();
  });

  await test('模型只保留文件名，不带路径（路径里有用户名）', () => {
    resetCrashContextForTest();
    beginCrashContext({
      engine: 'x',
      model: '/Users/alice/models/ggml-base.bin',
    });
    beginCrashContext({
      engine: 'y',
      model: 'C:\\Users\\Alice\\models\\ggml-small.bin',
    });
    beginCrashContext({ engine: 'z', model: 'base' });
    const models = snapshotCrashContext().map((c) => c.model);
    assert.deepEqual(models, ['ggml-base.bin', 'ggml-small.bin', 'base']);
    assert.ok(!JSON.stringify(snapshotCrashContext()).includes('alice'));
    assert.ok(!JSON.stringify(snapshotCrashContext()).includes('Alice'));
  });

  await test('withCrashContext：成功、异步失败、同步抛错都会移除；结果与异常原样传递', async () => {
    resetCrashContextForTest();
    const ok = await withCrashContext({ engine: 'e' }, async () => {
      assert.equal(snapshotCrashContext().length, 1);
      return 42;
    });
    assert.equal(ok, 42);
    assert.equal(snapshotCrashContext().length, 0);

    await assert.rejects(
      withCrashContext({ engine: 'e' }, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(snapshotCrashContext().length, 0);

    await assert.rejects(
      withCrashContext({ engine: 'e' }, () => {
        throw new Error('sync boom');
      }),
      /sync boom/,
    );
    assert.equal(snapshotCrashContext().length, 0);
  });

  await test('调用方漏掉移除时条目数有上限，丢弃最早的', () => {
    resetCrashContextForTest();
    for (let i = 0; i < 100; i++) beginCrashContext({ engine: `e${i}` }, i);
    const snapshot = snapshotCrashContext();
    assert.equal(snapshot.length, 32);
    assert.equal(snapshot[0].engine, 'e68');
    assert.equal(snapshot[31].engine, 'e99');
    resetCrashContextForTest();
  });

  finish('crashContext');
}

main();
