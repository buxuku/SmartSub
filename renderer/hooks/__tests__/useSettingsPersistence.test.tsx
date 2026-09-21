import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { useSettingsPersistence } from '../useSettingsPersistence';
import {
  invalidVadSettings,
  VAD_SETTING_BOUNDS,
} from '../../../types/vadSettings';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel: string) => {
    if (channel === 'getSettings') return { language: 'zh', proxyUrl: 'old' };
    if (channel === 'setSettings') return { rejectedKeys: [] };
    throw new Error(`Unexpected IPC: ${channel}`);
  });
  window.ipc = { invoke } as any;
});
afterEach(() => jest.useRealTimers());
test.each(Object.keys(VAD_SETTING_BOUNDS))(
  'validates numeric bounds for %s without coercing empty or nonfinite inputs',
  (key) => {
    for (const value of [
      '',
      '0.5',
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      -1,
    ])
      expect(invalidVadSettings({ [key]: value })).toEqual([key]);
    expect(invalidVadSettings({ [key]: 0 })).toEqual([]);
    expect(invalidVadSettings({ [key]: 1 })).toEqual([]);
    expect(invalidVadSettings({ [key]: 2 })).toEqual(
      VAD_SETTING_BOUNDS[key].max === 1 ? [key] : [],
    );
  },
);
const writes = () =>
  invoke.mock.calls.filter(([name]) => name === 'setSettings');
async function ready(onLoaded = jest.fn()) {
  const hook = renderHook(() => useSettingsPersistence(onLoaded));
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return { ...hook, onLoaded };
}

test.each([null, undefined, [], { success: false, error: 'read failed' }])(
  'malformed load %p blocks all writes and can be retried',
  async (value) => {
    invoke.mockResolvedValueOnce(value);
    const onLoaded = jest.fn();
    const { result } = renderHook(() => useSettingsPersistence(onLoaded));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe('INVALID_SETTINGS_RESPONSE');
    expect(onLoaded).not.toHaveBeenCalled();
    await act(async () =>
      expect(await result.current.persist({ language: 'en' })).toBe(false),
    );
    expect(writes()).toEqual([]);
    await act(async () => result.current.load());
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBe('');
  },
);

test('read rejection and a failed reload block editing until repaired', async () => {
  const { result } = await ready();
  invoke.mockRejectedValueOnce(new Error('EACCES read'));
  await act(async () => result.current.load());
  expect(result.current.loaded).toBe(false);
  expect(result.current.loadError).toBe('EACCES read');
  act(() => expect(result.current.stage({ language: 'en' })).toBe(false));
  await act(async () => expect(await result.current.save()).toBe(false));
  await act(async () => result.current.load());
  expect(result.current.loaded).toBe(true);
});

test.each(['', -1, 1.1, Infinity, NaN])(
  'invalid VAD input %p stays dirty, cannot save-and-leave, and repairs in place',
  async (value) => {
    const { result } = await ready();
    await act(async () =>
      expect(await result.current.persist({ vadThreshold: value })).toBe(false),
    );
    expect(result.current.error).toContain(
      'INVALID_VAD_SETTINGS: vadThreshold',
    );
    expect(result.current.getIsDirty()).toBe(true);
    expect(writes()).toHaveLength(0);
    await act(async () =>
      expect(await result.current.persist({ vadThreshold: 0.6 })).toBe(true),
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toEqual({ vadThreshold: 0.6 });
    expect(result.current.isDirty).toBe(false);
  },
);

test('StrictMode ignores late first load and unmounted reload results', async () => {
  const first = deferred<any>();
  invoke.mockReturnValueOnce(first.promise);
  const onLoaded = jest.fn();
  const { result, unmount } = renderHook(
    () => useSettingsPersistence(onLoaded),
    { wrapper: StrictMode },
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => first.resolve({ language: 'stale' }));
  expect(onLoaded).toHaveBeenCalledTimes(1);
  expect(onLoaded).toHaveBeenLastCalledWith({
    language: 'zh',
    proxyUrl: 'old',
  });
  const late = deferred<any>();
  invoke.mockReturnValueOnce(late.promise);
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.load();
  });
  unmount();
  await act(async () => {
    late.resolve({ language: 'after unmount' });
    await loading;
  });
  expect(onLoaded).toHaveBeenCalledTimes(1);
});

test.each([
  undefined,
  true,
  {},
  { success: true },
  { rejectedKeys: 'bad' },
  { rejectedKeys: [7] },
  { rejectedKeys: ['unknown'] },
  { success: false, rejectedKeys: [], error: 'EACCES' },
])('malformed save %p retains edits for explicit retry', async (response) => {
  const { result } = await ready();
  invoke.mockResolvedValueOnce(response);
  await act(async () =>
    expect(await result.current.persist({ proxyUrl: 'new' })).toBe(false),
  );
  expect(result.current.getIsDirty()).toBe(true);
  expect(result.current.error).not.toBe('');
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(writes().map(([, patch]) => patch)).toEqual([
    { proxyUrl: 'new' },
    { proxyUrl: 'new' },
  ]);
  expect(result.current.getIsDirty()).toBe(false);
  expect(result.current.error).toBe('');
});

test('rejected fields stay pending while accepted fields are acknowledged', async () => {
  const { result, onLoaded } = await ready();
  invoke.mockResolvedValueOnce({ rejectedKeys: ['storageRoot'] });
  await act(async () =>
    expect(
      await result.current.persist({ storageRoot: '/invalid', language: 'en' }),
    ).toBe(false),
  );
  expect(result.current.error).toContain('SETTINGS_REJECTED: storageRoot');
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(writes()[1][1]).toEqual({ storageRoot: '/invalid' });
  expect(onLoaded).toHaveBeenLastCalledWith({
    storageRoot: '/invalid',
    language: 'en',
    proxyUrl: 'old',
  });
});

test('single-flight save drains newer exact revisions and merges fields', async () => {
  const { result, onLoaded } = await ready();
  const first = deferred<any>();
  const second = deferred<any>();
  invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.persist({ proxyUrl: 'first' });
    expect(result.current.save()).toBe(saving);
    result.current.stage({ proxyUrl: 'second', language: 'en' }, null);
  });
  expect(writes()).toHaveLength(1);
  await act(async () => first.resolve({ rejectedKeys: [] }));
  expect(writes()).toHaveLength(2);
  expect(writes()[1][1]).toEqual({ proxyUrl: 'second', language: 'en' });
  expect(result.current.getIsDirty()).toBe(true);
  expect(onLoaded).toHaveBeenCalledTimes(1);
  await act(async () => {
    second.resolve({ rejectedKeys: [] });
    expect(await saving).toBe(true);
  });
  expect(result.current.isDirty).toBe(false);
  expect(onLoaded).toHaveBeenLastCalledWith({
    proxyUrl: 'second',
    language: 'en',
  });
});

test('failed in-flight save retains the latest revision, not its old payload', async () => {
  const { result } = await ready();
  const first = deferred<any>();
  invoke.mockReturnValueOnce(first.promise);
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.persist({ proxyUrl: 'first' });
    result.current.stage({ proxyUrl: 'latest' }, null);
  });
  await act(async () => {
    first.reject(new Error('disk full'));
    expect(await saving).toBe(false);
  });
  expect(result.current.error).toBe('disk full');
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(writes()[1][1]).toEqual({ proxyUrl: 'latest' });
});

test('debounce batches fields, navigation flushes immediately, and dirty load is ignored', async () => {
  const { result } = await ready();
  jest.useFakeTimers();
  act(() => {
    result.current.stage({ vadThreshold: 0.7 });
    result.current.stage({ vadSpeechPad: 300 });
  });
  expect(result.current.getIsDirty()).toBe(true);
  await act(async () => result.current.load());
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => expect(await result.current.save()).toBe(true));
  await act(async () => jest.advanceTimersByTime(1000));
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1]).toEqual({ vadThreshold: 0.7, vadSpeechPad: 300 });
  act(() => result.current.stage({ vadThreshold: 0.8 }));
  await act(async () => jest.advanceTimersByTime(500));
  expect(writes()).toHaveLength(2);
  expect(result.current.isDirty).toBe(false);
});

test('discard restores acknowledged values and cancels delayed writes', async () => {
  const { result, onLoaded } = await ready();
  jest.useFakeTimers();
  act(() => result.current.stage({ proxyUrl: 'discarded' }));
  await act(async () => expect(await result.current.discard()).toBe(true));
  await act(async () => jest.advanceTimersByTime(1000));
  expect(writes()).toEqual([]);
  expect(onLoaded).toHaveBeenLastCalledWith({
    language: 'zh',
    proxyUrl: 'old',
  });
  expect(result.current.isDirty).toBe(false);
});

test.each([true, false])(
  'discard waits for active write (success=%p) but never sends later edits',
  async (success) => {
    const { result, onLoaded } = await ready();
    const first = deferred<any>();
    invoke.mockReturnValueOnce(first.promise);
    let discarded!: Promise<boolean>;
    act(() => {
      void result.current.persist({ proxyUrl: 'in flight' });
      result.current.stage({ proxyUrl: 'discarded', language: 'en' });
      discarded = result.current.discard();
      expect(result.current.stage({ language: 'other' })).toBe(false);
    });
    await act(async () => {
      if (success) first.resolve({ rejectedKeys: [] });
      else first.reject(new Error('EACCES'));
      expect(await discarded).toBe(true);
    });
    expect(writes()).toHaveLength(1);
    expect(onLoaded).toHaveBeenLastCalledWith({
      language: 'zh',
      proxyUrl: success ? 'in flight' : 'old',
    });
    expect(result.current.error).toBe('');
    expect(result.current.isDirty).toBe(false);
  },
);

test('unmount cancels debounce and ignores late acknowledgements without followup writes', async () => {
  const { result, onLoaded, unmount } = await ready();
  jest.useFakeTimers();
  const first = deferred<any>();
  invoke.mockReturnValueOnce(first.promise);
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.persist({ proxyUrl: 'in flight' });
    result.current.stage({ proxyUrl: 'later' });
  });
  unmount();
  await act(async () => {
    first.resolve({ rejectedKeys: [] });
    expect(await saving).toBe(false);
    jest.advanceTimersByTime(1000);
  });
  expect(writes()).toHaveLength(1);
  expect(onLoaded).toHaveBeenCalledTimes(1);
});

test('staged values and acknowledged snapshots cannot be mutated by callers', async () => {
  const { result, onLoaded } = await ready();
  const languages = [{ name: 'Klingon', value: 'tlh' }];
  act(() => result.current.stage({ customLanguages: languages }, null));
  languages[0].name = 'Changed outside';
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(writes()[0][1].customLanguages[0].name).toBe('Klingon');
  onLoaded.mock.calls.at(-1)![0].customLanguages[0].name = 'Changed callback';
  await act(async () => result.current.discard());
  expect(onLoaded.mock.calls.at(-1)![0].customLanguages[0].name).toBe(
    'Klingon',
  );
});

test('post-save actions run only after acknowledgement, including retry, not load or discard', async () => {
  const onLoaded = jest.fn();
  const onSaved = jest.fn();
  const { result } = renderHook(() =>
    useSettingsPersistence(onLoaded, onSaved),
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(onSaved).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce(new Error('EACCES'));
  await act(async () =>
    expect(await result.current.persist({ language: 'en' })).toBe(false),
  );
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenLastCalledWith({ language: 'en', proxyUrl: 'old' });
  act(() => result.current.stage({ language: 'zh' }, null));
  await act(async () => result.current.discard());
  expect(onSaved).toHaveBeenCalledTimes(1);
});
