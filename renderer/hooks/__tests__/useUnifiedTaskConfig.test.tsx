import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import useUnifiedTaskConfig from '../useUnifiedTaskConfig';

const config = { sourceLanguage: 'en', targetLanguage: 'zh' };
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async () => structuredClone(config));
  window.ipc = { invoke, send: jest.fn() } as any;
});

test.each([null, undefined, [], 'invalid'])(
  'invalid default response %j blocks editing until a successful retry',
  async (value) => {
    invoke.mockResolvedValueOnce(value);
    const { result } = renderHook(() => useUnifiedTaskConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loaded).toBe(false);
    expect(result.current.loadError).toBe('INVALID_USER_CONFIG_RESPONSE');
    act(() => result.current.setValue('targetLanguage', 'ja'));
    expect(result.current.formData).toEqual({});
    await act(async () => expect(await result.current.load()).toBe(true));
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBe('');
    expect(result.current.formData).toEqual(config);
  },
);

test('read failure retains its details without publishing editable defaults', async () => {
  invoke.mockRejectedValueOnce(new Error('EACCES'));
  const { result } = renderHook(() => useUnifiedTaskConfig());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.loaded).toBe(false);
  expect(result.current.loadError).toBe('EACCES');
});

test.each(['resolve', 'reject'] as const)(
  'project hydration supersedes a pending default load that later %ss',
  async (outcome) => {
    const pending = deferred();
    invoke.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useUnifiedTaskConfig());
    const project = {
      targetLanguage: 'ja',
      manuscriptPath: '/project/script.txt',
    };
    act(() => result.current.hydrateSnapshot(project));
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(config);
      else pending.reject(new Error('late failure'));
    });
    expect(result.current.formData).toEqual(project);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe('');
  },
);

test('hydrating a recovered project clears a previous default-load error', async () => {
  invoke.mockRejectedValueOnce(new Error('EIO'));
  const { result } = renderHook(() => useUnifiedTaskConfig());
  await waitFor(() => expect(result.current.loadError).toBe('EIO'));
  act(() => result.current.hydrateSnapshot({ targetLanguage: 'fr' }));
  expect(result.current.loaded).toBe(true);
  expect(result.current.loadError).toBe('');
});

test('project mode never reads defaults unless explicitly requested', async () => {
  const { result } = renderHook(() =>
    useUnifiedTaskConfig({ autoLoad: false }),
  );
  expect(invoke).not.toHaveBeenCalled();
  act(() => result.current.hydrateSnapshot(config));
  act(() => result.current.setValue('targetLanguage', 'ja'));
  await act(async () => expect(await result.current.load()).toBe(false));
  expect(result.current.formData.targetLanguage).toBe('ja');
  expect(invoke).not.toHaveBeenCalled();
  expect(window.ipc.send).not.toHaveBeenCalled();
});

test('inline initial options do not reload after editing; nested snapshots remain immutable', async () => {
  const { result, rerender } = renderHook(() =>
    useUnifiedTaskConfig({
      initialConfig: { targetLanguage: 'fr', nested: { speed: 1 } },
    }),
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  const before = result.current.formData;
  act(() => result.current.form.setValue('nested.speed', 1.25));
  rerender();
  expect(before.nested.speed).toBe(1);
  expect(result.current.formData.nested.speed).toBe(1.25);
  expect(result.current.buildSnapshot().nested.speed).toBe(1.25);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(window.ipc.send).not.toHaveBeenCalled();
});

test('StrictMode ignores the stale first request', async () => {
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useUnifiedTaskConfig(), {
    wrapper: StrictMode,
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => first.reject(new Error('stale')));
  expect(result.current.loadError).toBe('');
  expect(result.current.formData).toEqual(config);
});

test('a response after unmount cannot publish form state', async () => {
  const pending = deferred();
  invoke.mockReturnValueOnce(pending.promise);
  const { result, unmount } = renderHook(() => useUnifiedTaskConfig());
  const reset = jest.spyOn(result.current.form, 'reset');
  unmount();
  await act(async () => pending.resolve(config));
  expect(reset).not.toHaveBeenCalled();
});
