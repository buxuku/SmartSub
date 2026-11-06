import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import useProviderPersistence from '../useProviderPersistence';
import useAsrProviders from '../useAsrProviders';
import useTtsProviders from '../useTtsProviders';
import { saveProviderList } from '../../../main/helpers/providerPersistence';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));
const original = [
  { id: 'one', type: 'openai', name: 'Original', apiKey: 'old' },
];
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel: string) =>
    channel.startsWith('get') ? structuredClone(original) : { success: true },
  );
  window.ipc = { invoke, send: jest.fn() } as any;
});
afterEach(() => jest.useRealTimers());
const writes = () =>
  invoke.mock.calls.filter(([channel]) => channel.startsWith('set'));
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const next = (name: string) => [{ ...original[0], name }];
async function ready(kind: 'Translation' | 'Asr' | 'Tts' = 'Translation') {
  const hook = renderHook(() =>
    useProviderPersistence<(typeof original)[number]>(kind),
  );
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
}

test('unsubmitted text is dirty, blocks reload, and explicit save merges it with the latest fields', async () => {
  const { result } = await ready();
  act(() =>
    result.current.stageDraft('one:models', 'draft-model', (providers) =>
      providers.map((provider) => ({ ...provider, models: 'draft-model' })),
    ),
  );
  expect(result.current.isDirty).toBe(true);
  expect(result.current.getIsDirty()).toBe(true);
  expect(result.current.getDraft('one:models')).toBe('draft-model');
  await act(async () => expect(await result.current.load()).toBe(false));
  act(() => result.current.change([{ ...original[0], apiKey: 'latest' }]));
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(writes()[0][1].providers).toEqual([
    { ...original[0], apiKey: 'latest', models: 'draft-model' },
  ]);
  expect(result.current.getDraft('one:models')).toBe('');
  expect(result.current.getIsDirty()).toBe(false);
});

test('debounced field save does not consume tag input; discard clears unsubmitted text', async () => {
  const { result } = await ready();
  jest.useFakeTimers();
  act(() => {
    result.current.stageDraft('one:models', 'search', (providers) => providers);
    result.current.change(next('changed'));
  });
  await act(async () => jest.advanceTimersByTimeAsync(500));
  expect(writes()).toHaveLength(1);
  expect(result.current.getDraft('one:models')).toBe('search');
  expect(result.current.isDirty).toBe(true);
  await act(async () => expect(await result.current.discard()).toBe(true));
  expect(result.current.getDraft('one:models')).toBe('');
  expect(result.current.getIsDirty()).toBe(false);
  expect(result.current.providers).toEqual(next('changed'));
});

test('invalid or missing draft target blocks save without losing text, and can be explicitly discarded', async () => {
  const { result } = await ready();
  act(() =>
    result.current.stageDraft('removed', 'retain', () => {
      throw new Error('PROVIDER_DRAFT_TARGET_MISSING');
    }),
  );
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(writes()).toHaveLength(0);
  expect(result.current.error).toBe('PROVIDER_DRAFT_TARGET_MISSING');
  expect(result.current.getDraft('removed')).toBe('retain');
  await act(async () => result.current.discard());
  expect(result.current.getIsDirty()).toBe(false);
});

test('empty invalid rename remains dirty until explicitly corrected or discarded', async () => {
  const { result } = await ready();
  act(() =>
    result.current.stageDraft(
      'one:name',
      '',
      () => {
        throw new Error('INVALID_PROVIDER_NAME');
      },
      true,
    ),
  );
  expect(result.current.getIsDirty()).toBe(true);
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(writes()).toHaveLength(0);
  act(() =>
    result.current.stageDraft('one:name', 'Fixed name', (providers) =>
      providers.map((provider) => ({ ...provider, name: 'Fixed name' })),
    ),
  );
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(result.current.getIsDirty()).toBe(false);
});

test.each([
  null,
  undefined,
  {},
  [null],
  [{ id: 'one' }],
  [...original, ...original],
])('malformed list %p blocks edits and reload recovers', async (value) => {
  invoke.mockResolvedValueOnce(value);
  const { result } = renderHook(() => useProviderPersistence('Translation'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.loadError).toBe('INVALID_PROVIDER_LIST');
  act(() => expect(result.current.change(next('bad'))).toBe(false));
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(writes()).toHaveLength(0);
  await act(async () => expect(await result.current.load()).toBe(true));
  expect(result.current.providers).toEqual(original);
});

test('read failure and late StrictMode or unmounted loads cannot replace the active list', async () => {
  const first = deferred();
  invoke.mockReturnValueOnce(first.promise);
  const { result, unmount } = renderHook(() => useProviderPersistence('Asr'), {
    wrapper: StrictMode,
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => first.resolve(next('stale')));
  expect(result.current.providers).toEqual(original);
  invoke.mockRejectedValueOnce(new Error('EACCES'));
  await act(async () => expect(await result.current.load()).toBe(false));
  expect(result.current.loaded).toBe(false);
  expect(result.current.loadError).toBe('EACCES');
  const late = deferred();
  invoke.mockReturnValueOnce(late.promise);
  let loading!: Promise<boolean>;
  act(() => {
    loading = result.current.load();
  });
  unmount();
  await act(async () => {
    late.resolve(next('late'));
    expect(await loading).toBe(false);
  });
});

test.each(['Translation', 'Asr', 'Tts'] as const)(
  '%s acknowledgement failure retains latest inputs and retry uses the same expected list',
  async (kind) => {
    const { result } = await ready(kind);
    invoke.mockResolvedValueOnce({ success: false, error: 'EACCES' });
    act(() => result.current.change(next('edited')));
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(result.current.error).toBe('EACCES');
    expect(result.current.providers).toEqual(next('edited'));
    expect(result.current.getIsDirty()).toBe(true);
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(writes().map(([, payload]) => payload)).toEqual([
      { providers: next('edited'), expectedProviders: original },
      { providers: next('edited'), expectedProviders: original },
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(window.ipc.send).not.toHaveBeenCalled();
  },
);

test.each([undefined, null, true, {}, { success: 'true' }])(
  'invalid save acknowledgement %p cannot mark saved',
  async (response) => {
    const { result } = await ready();
    invoke.mockResolvedValueOnce(response);
    act(() => result.current.change(next('edited')));
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(result.current.error).toBe('INVALID_PROVIDER_SAVE_RESPONSE');
    expect(result.current.getIsDirty()).toBe(true);
  },
);

test('single flight drains exact revisions with the newly acknowledged CAS base', async () => {
  const { result } = await ready();
  const first = deferred(),
    second = deferred();
  invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let saving!: Promise<boolean>;
  act(() => {
    result.current.change(next('first'));
    saving = result.current.save();
    result.current.change(next('latest'));
    expect(result.current.save()).toBe(saving);
  });
  await act(async () => first.resolve({ success: true }));
  expect(writes()[1][1]).toEqual({
    providers: next('latest'),
    expectedProviders: next('first'),
  });
  expect(result.current.isDirty).toBe(true);
  await act(async () => {
    second.resolve({ success: true });
    expect(await saving).toBe(true);
  });
  expect(result.current.isDirty).toBe(false);
});

test('conflict remains dirty, reload is blocked until explicit discard, then loads newer values', async () => {
  const { result } = await ready();
  invoke.mockRejectedValueOnce(new Error('PROVIDER_SETTINGS_CONFLICT'));
  act(() => result.current.change(next('local')));
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(result.current.error).toBe('PROVIDER_SETTINGS_CONFLICT');
  await act(async () => expect(await result.current.load()).toBe(false));
  invoke.mockResolvedValueOnce(next('external'));
  await act(async () => {
    await result.current.discard();
    expect(await result.current.load()).toBe(true);
  });
  expect(result.current.providers).toEqual(next('external'));
  expect(result.current.isDirty).toBe(false);
});

test('lost acknowledgement replays the exact accepted write before newer edits without conflicting with itself', async () => {
  const { result } = await ready();
  let disk = structuredClone(original);
  let loseAcknowledgement = true;
  invoke.mockImplementation(async (_channel, request) => {
    const response = saveProviderList(
      request,
      () => disk,
      (value) => {
        disk = value;
      },
    );
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error('lost acknowledgement');
    }
    return response;
  });
  act(() => result.current.change(next('accepted')));
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(disk).toEqual(next('accepted'));
  act(() => result.current.change(next('latest')));
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(
    writes()
      .slice(1)
      .map(([, payload]) => payload.providers[0].name),
  ).toEqual(['accepted', 'latest']);
  expect(disk).toEqual(next('latest'));
  expect(result.current.isDirty).toBe(false);
});

test.each([true, false])(
  'discard waits for an active write success=%p and cancels subsequent edits',
  async (success) => {
    const { result } = await ready();
    const flight = deferred();
    invoke.mockReturnValueOnce(flight.promise);
    let discarded!: Promise<boolean>;
    act(() => {
      result.current.change(next('first'));
      void result.current.save();
      result.current.change(next('discarded'));
      discarded = result.current.discard();
      expect(result.current.change(next('blocked'))).toBe(false);
    });
    await act(async () => {
      if (success) flight.resolve({ success: true });
      else flight.reject(new Error('EACCES'));
      expect(await discarded).toBe(true);
    });
    expect(writes()).toHaveLength(1);
    expect(result.current.providers).toEqual(
      success ? next('first') : original,
    );
    expect(result.current.isDirty).toBe(false);
  },
);

test('debounce updates ref immediately, batches edits and stops after unmount without flush', async () => {
  const { result, unmount } = await ready();
  jest.useFakeTimers();
  act(() => {
    result.current.change(next('first'));
    result.current.change((previous) => [
      { ...previous[0], name: `${previous[0].name} second` },
    ]);
    expect(result.current.getIsDirty()).toBe(true);
  });
  await act(async () => jest.advanceTimersByTime(500));
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1].providers[0].name).toBe('first second');
  act(() => result.current.change(next('unsent')));
  unmount();
  await act(async () => jest.advanceTimersByTime(1000));
  expect(writes()).toHaveLength(1);
});

test('late save after unmount cannot start the next queued request', async () => {
  const { result, unmount } = await ready();
  const flight = deferred();
  invoke.mockReturnValueOnce(flight.promise);
  let saving!: Promise<boolean>;
  act(() => {
    result.current.change(next('first'));
    saving = result.current.save();
    result.current.change(next('later'));
  });
  unmount();
  await act(async () => {
    flight.resolve({ success: true });
    expect(await saving).toBe(false);
  });
  expect(writes()).toHaveLength(1);
});

test.each([useAsrProviders, useTtsProviders])(
  'lazy materialization followed by field edit is atomic in local state',
  async (useProviders) => {
    invoke.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useProviders());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const type =
      useProviders === useAsrProviders
        ? 'openai-compatible'
        : 'tts-openai-compatible';
    // Use the declared provider types instead of assuming a materialized state update has rendered.
    const types =
      useProviders === useAsrProviders
        ? require('../../../types/asrProvider').ASR_PROVIDER_TYPES
        : require('../../../types/ttsProvider').TTS_PROVIDER_TYPES;
    const actualType =
      types.find((entry: any) => entry.id.includes('openai'))?.id || type;
    let id: string | null = null;
    act(() => {
      id = result.current.addInstance(actualType);
      expect(id).not.toBeNull();
      result.current.updateInstanceField(id!, 'apiKey', 'new credential');
    });
    expect(result.current.providers).toHaveLength(1);
    expect(result.current.providers[0].apiKey).toBe('new credential');
    await act(async () =>
      expect(await result.current.persistence.save()).toBe(true),
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1].providers[0].apiKey).toBe('new credential');
  },
);

test('backend CAS preserves newer state, permits idempotent replay, and propagates disk errors', () => {
  let disk: any = structuredClone(original);
  const read = () => disk;
  const write = jest.fn((value) => {
    disk = value;
  });
  expect(
    saveProviderList(
      { providers: next('one'), expectedProviders: original },
      read,
      write,
    ),
  ).toEqual({ success: true });
  expect(() =>
    saveProviderList(
      { providers: next('two'), expectedProviders: original },
      read,
      write,
    ),
  ).toThrow('PROVIDER_SETTINGS_CONFLICT');
  expect(disk).toEqual(next('one'));
  expect(
    saveProviderList(
      { providers: next('one'), expectedProviders: original },
      read,
      write,
    ),
  ).toEqual({ success: true });
  expect(write).toHaveBeenCalledTimes(1);
  expect(() =>
    saveProviderList(
      { providers: next('two'), expectedProviders: next('one') },
      read,
      () => {
        throw new Error('EACCES');
      },
    ),
  ).toThrow('EACCES');
  expect(disk).toEqual(next('one'));
});

test.each([
  null,
  [],
  {},
  { providers: null, expectedProviders: [] },
  { providers: [...original, ...original], expectedProviders: original },
])('backend rejects malformed request %p without writing', (request) => {
  const write = jest.fn();
  expect(() => saveProviderList(request, () => original, write)).toThrow();
  expect(write).not.toHaveBeenCalled();
});
