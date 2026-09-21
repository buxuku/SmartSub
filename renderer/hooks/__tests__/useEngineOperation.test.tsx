import { act, renderHook } from '@testing-library/react';
import useEngineOperation from '../useEngineOperation';

const deferred = () => {
  let resolve!: (value: string) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('failed operation retains error and retries the original command', async () => {
  const work = jest
    .fn()
    .mockRejectedValueOnce(new Error('EACCES'))
    .mockResolvedValueOnce('done');
  const commit = jest.fn();
  const { result } = renderHook(() => useEngineOperation());
  await act(async () =>
    expect(await result.current.run(work, commit)).toBe(false),
  );
  expect(result.current.error).toBe('EACCES');
  expect(commit).not.toHaveBeenCalled();
  await act(async () => result.current.retry());
  expect(work).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledWith('done');
  expect(result.current.error).toBe('');
  await act(async () => result.current.retry());
  expect(work).toHaveBeenCalledTimes(2);
});

test('rapid duplicate commands are ignored until the first finishes', async () => {
  const pending = deferred();
  const commit = jest.fn();
  const second = jest.fn();
  const { result } = renderHook(() => useEngineOperation());
  let flight!: Promise<boolean>;
  act(() => {
    flight = result.current.run(() => pending.promise, commit);
  });
  expect(result.current.busy).toBe(true);
  await act(async () =>
    expect(await result.current.run(second, commit)).toBe(false),
  );
  expect(second).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve('first');
    expect(await flight).toBe(true);
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(result.current.busy).toBe(false);
});

test.each([false, true])(
  'unmounted late operation cannot publish result or retry (failure=%p)',
  async (failure) => {
    const pending = deferred();
    const work = jest.fn(() => pending.promise);
    const commit = jest.fn();
    const { result, unmount } = renderHook(() => useEngineOperation());
    let flight!: Promise<boolean>;
    act(() => {
      flight = result.current.run(work, commit);
    });
    const retry = result.current.retry;
    unmount();
    await act(async () => {
      if (failure) pending.reject(new Error('late'));
      else pending.resolve('late');
      expect(await flight).toBe(false);
      retry();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
  },
);
