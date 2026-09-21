import { DubbingOperationRegistry } from '../../../main/helpers/dubbing/operationRegistry';
import { invokeDubbingOperation } from '../dubbingOperation';

beforeEach(() => {
  jest.useRealTimers();
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => 'operation-test',
  });
});
afterEach(() => jest.useRealTimers());

it('shares an in-flight request, rejects conflicting reuse and returns immutable results', async () => {
  const registry = new DubbingOperationRegistry();
  let finish!: (result: any) => void;
  const execute = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const payload = {
    sessionId: 'session',
    requestId: 'request',
    leaseId: 'first',
    config: { speed: 1 },
  };
  const first = registry.run('start', payload, execute);
  const second = registry.run(
    'start',
    { ...payload, leaseId: 'second' },
    execute,
  );
  expect(registry.status('session', 'request')).toEqual({ status: 'pending' });
  expect(() => registry.run('export', payload, execute)).toThrow(/conflicts/);
  expect(() =>
    registry.run('start', { ...payload, config: { speed: 2 } }, execute),
  ).toThrow(/conflicts/);
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(1);
  finish({ success: true, data: { outputPath: '/result.wav' } });
  const result = (await first) as any;
  result.data.outputPath = 'mutated';
  expect(await second).toEqual({
    success: true,
    data: { outputPath: '/result.wav' },
  });
  expect(await registry.run('start', payload, execute)).toEqual(await second);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('never reexecutes evicted results and isolates sessions', async () => {
  const registry = new DubbingOperationRegistry(1);
  const execute = jest.fn(async () => ({ success: false, error: 'disk full' }));
  await registry.run('start', { sessionId: 'a', requestId: '1' }, execute);
  await registry.run('start', { sessionId: 'a', requestId: '2' }, execute);
  expect(registry.status('a', '1')).toEqual({ status: 'expired' });
  expect(() =>
    registry.run('start', { sessionId: 'a', requestId: '1' }, execute),
  ).toThrow(/expired/);
  await registry.run('start', { sessionId: 'b', requestId: '1' }, execute);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(registry.status('b', '2')).toEqual({ status: 'missing' });
});

it('recovers an already completed operation after acknowledgement rejection without resubmission', async () => {
  const result = { success: true, data: { outputPath: '/result.wav' } };
  const invoke = jest.fn(async (channel) => {
    if (channel === 'dubbing:export') throw new Error('reply lost');
    return { success: true, data: { status: 'complete', result } };
  });
  window.ipc = { invoke } as any;
  expect(
    await invokeDubbingOperation(
      'dubbing:export',
      { sessionId: 'a', leaseId: 'lease' },
      () => true,
      jest.fn(),
    ),
  ).toEqual(result);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'dubbing:export',
    'dubbing:operationStatus',
  ]);
});

it('keeps a pending operation locked through failed status reads and accepts the original result', async () => {
  jest.useFakeTimers();
  let finish!: (result: any) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const invoke = jest.fn((channel) =>
    channel === 'dubbing:start'
      ? pending
      : Promise.reject(new Error('status offline')),
  );
  window.ipc = { invoke } as any;
  const onUncertain = jest.fn();
  const operation = invokeDubbingOperation(
    'dubbing:start',
    { sessionId: 'a' },
    () => true,
    onUncertain,
  );
  await jest.advanceTimersByTimeAsync(1000);
  expect(onUncertain).toHaveBeenCalledWith('Error: status offline');
  finish({ success: true, data: { cues: [] } });
  expect(await operation).toEqual({ success: true, data: { cues: [] } });
  expect(
    invoke.mock.calls.filter(([name]) => name === 'dubbing:start'),
  ).toHaveLength(1);
});

it('polls an unacknowledged request to completion and abandons a changed editor', async () => {
  jest.useFakeTimers();
  let current = true;
  const invoke = jest.fn(async (channel) => {
    if (channel === 'dubbing:start') throw new Error('reply lost');
    return { success: true, data: { status: 'pending' } };
  });
  window.ipc = { invoke } as any;
  const operation = invokeDubbingOperation(
    'dubbing:start',
    { sessionId: 'a' },
    () => current,
    jest.fn(),
  );
  const rejected = expect(operation).rejects.toThrow(/editor has changed/);
  await jest.advanceTimersByTimeAsync(1000);
  current = false;
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(
    invoke.mock.calls.filter(([name]) => name === 'dubbing:start'),
  ).toHaveLength(1);
});

it('accepts a normal result even when the status query never replies, with only one outstanding query', async () => {
  jest.useFakeTimers();
  let finish!: (result: any) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const invoke = jest.fn((channel) =>
    channel === 'dubbing:export' ? pending : new Promise(() => {}),
  );
  window.ipc = { invoke } as any;
  const operation = invokeDubbingOperation(
    'dubbing:export',
    { sessionId: 'a' },
    () => true,
    jest.fn(),
  );
  await jest.advanceTimersByTimeAsync(5000);
  expect(
    invoke.mock.calls.filter(([name]) => name === 'dubbing:operationStatus'),
  ).toHaveLength(1);
  finish({ success: true, data: { outputPath: '/result.wav' } });
  expect(await operation).toEqual({
    success: true,
    data: { outputPath: '/result.wav' },
  });
});
