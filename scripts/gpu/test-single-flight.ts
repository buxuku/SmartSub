import { createSingleFlightCache } from '../../main/helpers/singleFlightCache';
import { assert, finish, test } from './testkit';

/** 一个手动放行的计算：可以数调用次数，也可以让它停在“进行中”。 */
function controllableCompute<T>() {
  const calls: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }> = [];
  const compute = () =>
    new Promise<T>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { compute, calls };
}

async function main() {
  await test('同时到达的调用共享同一次计算（启动期多处同时问 GPU 环境）', async () => {
    const { compute, calls } = controllableCompute<string>();
    const cache = createSingleFlightCache(compute);

    const first = cache.get();
    const second = cache.get();
    const third = cache.get();
    assert.equal(calls.length, 1, '三个并发调用只应触发一次探测');

    calls[0].resolve('env');
    assert.deepEqual(await Promise.all([first, second, third]), [
      'env',
      'env',
      'env',
    ]);
  });

  await test('算完以后命中缓存，不再计算', async () => {
    let runs = 0;
    const cache = createSingleFlightCache(async () => ++runs);
    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 1);
    assert.equal(runs, 1);
  });

  await test('falsy 的结果（0、空串）也是有效缓存', async () => {
    let runs = 0;
    const cache = createSingleFlightCache(async () => {
      runs++;
      return 0;
    });
    assert.equal(await cache.get(), 0);
    assert.equal(await cache.get(), 0);
    assert.equal(runs, 1);
  });

  await test('forceRefresh 重新计算，完成后后续调用拿到新结果', async () => {
    const { compute, calls } = controllableCompute<string>();
    const cache = createSingleFlightCache(compute);

    const initial = cache.get();
    calls[0].resolve('old');
    assert.equal(await initial, 'old');

    const refreshed = cache.get(true);
    assert.equal(calls.length, 2, 'forceRefresh 必须真的重新探测');
    calls[1].resolve('new');
    assert.equal(await refreshed, 'new');
    assert.equal(await cache.get(), 'new');
    assert.equal(calls.length, 2, '刷新完成后命中缓存，不再计算');
  });

  await test('先 clear 再强制刷新（get-gpu-environment 的做法）：刷新期间的普通调用加入这次刷新', async () => {
    const { compute, calls } = controllableCompute<string>();
    const cache = createSingleFlightCache(compute);

    const initial = cache.get();
    calls[0].resolve('old');
    assert.equal(await initial, 'old');

    cache.clear();
    const refreshed = cache.get(true);
    const joiner = cache.get();
    assert.equal(calls.length, 2, '刷新进行中，普通调用应加入它而不是再起一次');
    calls[1].resolve('new');
    assert.equal(await refreshed, 'new');
    assert.equal(await joiner, 'new');
  });

  await test('clear 让进行中的旧计算过期：结果仍还给原调用方，但不写进缓存', async () => {
    const { compute, calls } = controllableCompute<string>();
    const cache = createSingleFlightCache(compute);

    const stale = cache.get();
    cache.clear();
    const fresh = cache.get();
    assert.equal(calls.length, 2, 'clear 之后的调用不能再加入旧的计算');

    calls[1].resolve('fresh');
    assert.equal(await fresh, 'fresh');
    // 旧计算晚于新计算完成：不能把过期结果覆盖进缓存
    calls[0].resolve('stale');
    assert.equal(await stale, 'stale');
    assert.equal(await cache.get(), 'fresh');
  });

  await test('失败不缓存：所有等待者都拿到这次错误，下一次调用重新探测', async () => {
    const { compute, calls } = controllableCompute<string>();
    const cache = createSingleFlightCache(compute);

    const a = cache.get();
    const b = cache.get();
    assert.equal(calls.length, 1);
    calls[0].reject(new Error('probe failed'));
    await assert.rejects(a, /probe failed/);
    await assert.rejects(b, /probe failed/);

    const retry = cache.get();
    assert.equal(calls.length, 2, '失败过的探测不应该被缓存');
    calls[1].resolve('ok');
    assert.equal(await retry, 'ok');
  });

  await test('compute 同步抛错也变成 rejection，不会把缓存卡在“进行中”', async () => {
    let shouldThrow = true;
    const cache = createSingleFlightCache<string>(() => {
      if (shouldThrow) throw new Error('boom');
      return Promise.resolve('fine');
    });
    await assert.rejects(cache.get(), /boom/);
    shouldThrow = false;
    assert.equal(await cache.get(), 'fine');
  });

  finish('单飞缓存');
}

void main();
