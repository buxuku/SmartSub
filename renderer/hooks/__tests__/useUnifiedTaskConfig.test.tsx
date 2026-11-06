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

describe('syncDefaults (task pages remember what the user adjusts)', () => {
  const SETTLE_MS = 400;
  const options = { autoLoad: false, syncDefaults: true } as const;
  const updates = () =>
    invoke.mock.calls
      .filter(([channel]) => channel === 'updateTaskDefaults')
      .map(([, patch]) => patch);
  const settle = () =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(SETTLE_MS);
    });
  const hydrated = (hookOptions: Record<string, any> = options) => {
    const view = renderHook(() => useUnifiedTaskConfig(hookOptions));
    act(() => view.result.current.hydrateSnapshot(config));
    return view;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    invoke.mockImplementation(async (channel: string) =>
      channel === 'updateTaskDefaults'
        ? { success: true }
        : structuredClone(config),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('an edit reaches the main process as a patch, without running anything', async () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    expect(updates()).toEqual([]);
    await settle();
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
    expect(window.ipc.send).not.toHaveBeenCalled();
  });

  test('without the option the hook never writes defaults, not even when it unmounts', async () => {
    const { result, unmount } = hydrated({ autoLoad: false });
    act(() => result.current.setValue('targetLanguage', 'ja'));
    await settle();
    unmount();
    expect(updates()).toEqual([]);
    expect(window.ipc.send).not.toHaveBeenCalled();
  });

  test('a burst of edits is written once, with only the changed keys', async () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SETTLE_MS - 100);
    });
    act(() => result.current.setValue('targetLanguage', 'fr'));
    act(() => result.current.setValue('sourceLanguage', 'ko'));
    await settle();
    expect(updates()).toEqual([{ targetLanguage: 'fr', sourceLanguage: 'ko' }]);
  });

  test('editing a key back to what it was writes nothing', async () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    act(() => result.current.setValue('targetLanguage', 'zh'));
    await settle();
    expect(updates()).toEqual([]);
  });

  test('hydrating a project, even over older values, writes nothing', async () => {
    const { result } = hydrated();
    act(() =>
      result.current.hydrateSnapshot({
        ...config,
        targetLanguage: 'ja',
        manuscriptPath: '/project/script.txt',
      }),
    );
    await settle();
    expect(updates()).toEqual([]);
  });

  test('an old project edited in one field writes only that field', async () => {
    const { result } = hydrated();
    act(() =>
      result.current.hydrateSnapshot({
        ...config,
        targetLanguage: 'ja',
        maxContext: 9,
      }),
    );
    act(() => result.current.setValue('sourceLanguage', 'ko'));
    await settle();
    expect(updates()).toEqual([{ sourceLanguage: 'ko' }]);
  });

  test('unmounting saves the pending edit right away', () => {
    const { result, unmount } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    expect(updates()).toEqual([]);
    unmount();
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
  });

  test('closing the window saves the pending edit right away', () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    window.dispatchEvent(new Event('beforeunload'));
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
  });

  test('switching to another project saves the pending edit of the previous one first', async () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    act(() =>
      result.current.hydrateSnapshot({ ...config, targetLanguage: 'de' }),
    );
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
    await settle();
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
  });

  test('flushDefaults saves the pending edit and resolves once it is saved', async () => {
    const { result } = hydrated();
    act(() => result.current.setValue('targetLanguage', 'ja'));
    await act(async () => {
      await result.current.flushDefaults();
    });
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
  });

  test('an automatic correction changes the form but is not remembered; a later edit is', async () => {
    const { result } = hydrated();
    act(() => result.current.correctValue('targetLanguage', 'fr'));
    expect(result.current.formData.targetLanguage).toBe('fr');
    await settle();
    expect(updates()).toEqual([]);
    act(() => result.current.setValue('targetLanguage', 'de'));
    await settle();
    expect(updates()).toEqual([{ targetLanguage: 'de' }]);
  });

  test('a correction does not hide an edit made in the same burst', async () => {
    const { result } = hydrated();
    act(() => result.current.correctValue('targetLanguage', 'fr'));
    act(() => result.current.setValue('sourceLanguage', 'ko'));
    await settle();
    expect(updates()).toEqual([{ sourceLanguage: 'ko' }]);
  });

  test('corrections and edits before the form is loaded are ignored', async () => {
    const { result } = renderHook(() => useUnifiedTaskConfig(options));
    act(() => result.current.correctValue('targetLanguage', 'fr'));
    act(() => result.current.setValue('targetLanguage', 'ja'));
    await settle();
    expect(result.current.formData).toEqual({});
    expect(updates()).toEqual([]);
  });

  test('a failed default read publishes nothing to write', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'updateTaskDefaults') return { success: true };
      throw new Error('EACCES');
    });
    const { result } = renderHook(() =>
      useUnifiedTaskConfig({ syncDefaults: true }),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadError).toBe('EACCES');
    act(() => result.current.setValue('targetLanguage', 'ja'));
    await settle();
    expect(updates()).toEqual([]);
  });

  test('switching the option off stops later edits from being remembered', async () => {
    const view = renderHook(
      ({ syncDefaults }) =>
        useUnifiedTaskConfig({ autoLoad: false, syncDefaults }),
      { initialProps: { syncDefaults: true } },
    );
    act(() => view.result.current.hydrateSnapshot(config));
    view.rerender({ syncDefaults: false });
    act(() => view.result.current.setValue('targetLanguage', 'ja'));
    await settle();
    expect(updates()).toEqual([]);
  });

  test('keeps working through a StrictMode remount', async () => {
    const view = renderHook(() => useUnifiedTaskConfig(options), {
      wrapper: StrictMode,
    });
    act(() => view.result.current.hydrateSnapshot(config));
    act(() => view.result.current.setValue('targetLanguage', 'ja'));
    await settle();
    expect(updates()).toEqual([{ targetLanguage: 'ja' }]);
  });

  describe('when the main process does not save', () => {
    let log: jest.SpyInstance;
    beforeEach(() => {
      log = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      log.mockRestore();
    });

    test.each([
      [undefined, 'TASK_DEFAULTS_NOT_SAVED'],
      [{}, 'TASK_DEFAULTS_NOT_SAVED'],
      [{ success: false }, 'TASK_DEFAULTS_NOT_SAVED'],
      [{ success: false, error: 'EACCES' }, 'EACCES'],
    ])(
      'an unacknowledged save (%j) is logged, never assumed, and editing goes on',
      async (response, message) => {
        const { result } = hydrated();
        invoke.mockImplementation(async (channel: string) =>
          channel === 'updateTaskDefaults' ? response : structuredClone(config),
        );
        act(() => result.current.setValue('targetLanguage', 'ja'));
        await settle();
        expect(log).toHaveBeenCalledWith(
          'Failed to update task defaults:',
          expect.objectContaining({ message }),
        );
        expect(result.current.formData.targetLanguage).toBe('ja');
      },
    );

    test('a rejected save is retried by the next edit together with what was lost', async () => {
      const { result } = hydrated();
      invoke.mockImplementationOnce(async () => {
        throw new Error('ENOSPC');
      });
      act(() => result.current.setValue('targetLanguage', 'ja'));
      await settle();
      expect(log).toHaveBeenCalledTimes(1);
      act(() => result.current.setValue('sourceLanguage', 'ko'));
      await settle();
      expect(updates()).toEqual([
        { targetLanguage: 'ja' },
        { targetLanguage: 'ja', sourceLanguage: 'ko' },
      ]);
    });
  });
});
