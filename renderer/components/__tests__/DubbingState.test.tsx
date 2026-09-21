import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDubbing } from '../../hooks/useDubbing';
import { useNavigationGuard } from '../../context/NavigationGuardContext';
import {
  DEFAULT_DUBBING_PREFERENCES,
  dubbingConfigDraftKey,
} from '../../lib/dubbingConfigDraft';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));

jest.mock('../../hooks/useTtsEngineOptions', () => ({
  ...jest.requireActual('../../hooks/useTtsEngineOptions'),
  loadTtsEngineOptions: async () => [
    {
      key: 'cloud:test',
      kind: 'cloud',
      label: 'Test',
      ready: true,
      voices: [{ id: 'voice', label: 'Voice' }],
      defaultVoiceId: 'voice',
    },
  ],
}));

function view(id: string) {
  return {
    sessionId: id,
    workItemId: `work-${id}`,
    subtitlePath: `/${id}.srt`,
    mediaDurationMs: 0,
    speakers: [{ id: 1, name: 'Host', cueCount: 1, totalDurationMs: 1000 }],
    speakerVoiceMap: { 1: '__global__' },
    speakerSettings: {},
    speakerVoiceConflicts: {},
    cues: [
      {
        index: 0,
        startMs: 0,
        endMs: 1000,
        text: id,
        speakerIds: [1],
        status: 'pending',
        overlap: false,
      },
    ],
  };
}
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let invoke: jest.Mock;
const draftKey = dubbingConfigDraftKey('old');
function configDraft(speed = 1.4) {
  const saved = {
    ...DEFAULT_DUBBING_PREFERENCES,
    engineKey: 'cloud:test',
    voice: 'voice',
  };
  return {
    version: 1,
    revision: 0,
    sessionId: 'old',
    saved,
    current: { ...saved, globalSpeed: speed },
  };
}
beforeEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => `shorten-${Math.random()}`,
  });
  invoke = jest.fn(async (channel, payload) => {
    if (channel === 'dubbing:loadSubtitle')
      return {
        success: true,
        data: view(payload.subtitlePath.includes('new') ? 'new' : 'old'),
      };
    if (channel === 'dubbing:syncVoiceState')
      return { success: true, data: view(payload.sessionId) };
    if (channel === 'dubbing:readConfigDraft')
      return { success: true, data: null };
    if (channel === 'dubbing:readCueDraft')
      return { success: true, data: null };
    if (channel === 'dubbing:writeCueDraft')
      return { success: true, data: payload.raw };
    if (channel === 'dubbing:saveCueTexts') {
      const result = view(payload.sessionId);
      for (const edit of payload.edits)
        result.cues[edit.index].text = edit.text;
      return { success: true, data: result };
    }
    if (channel === 'dubbing:writeConfigDraft')
      return { success: true, data: payload.raw };
    return { success: true, data: true };
  });
  window.ipc = { invoke, on: jest.fn(() => () => {}) } as any;
});

it('journals each edit synchronously and clears only after the latest save acknowledgement', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState' && payload.config.globalSpeed === 1.2
      ? pending.promise
      : original(channel, payload),
  );
  act(() => {
    hook.result.current.updateConfig({ globalSpeed: 1.2 });
    expect(
      JSON.parse(localStorage.getItem(draftKey)!).current.globalSpeed,
    ).toBe(1.2);
  });
  await waitFor(() => expect(hook.result.current.configSaving).toBe(true));
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.6 }));
  expect(JSON.parse(localStorage.getItem(draftKey)!).current.globalSpeed).toBe(
    1.6,
  );
  await act(async () => pending.resolve({ success: true, data: view('old') }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(localStorage.getItem(draftKey)).toBeNull();
  expect(hook.result.current.config.globalSpeed).toBe(1.6);
});

it('offers failed config after remount without overwriting it, then restores by explicit choice', async () => {
  const original = invoke.getMockImplementation()!;
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState'
      ? Promise.resolve({ success: false, error: 'disk full' })
      : original(channel, payload),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.7 }));
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('disk full'),
  );
  const raw = localStorage.getItem(draftKey);
  hook.unmount();
  invoke.mockImplementation(original);
  invoke.mockClear();
  const resumed = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() =>
    expect(resumed.result.current.configRecovery).not.toBeNull(),
  );
  expect(resumed.result.current.canStart).toBe(false);
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:syncVoiceState'),
  ).toBe(false);
  act(() => {
    expect(resumed.result.current.updateConfig({ globalSpeed: 1 })).toBe(false);
    resumed.result.current.clearSubtitle();
  });
  expect(resumed.result.current.session?.sessionId).toBe('old');
  expect(localStorage.getItem(draftKey)).toBe(raw);
  act(() => expect(resumed.result.current.restoreConfigDraft()).toBe(true));
  await waitFor(() => expect(resumed.result.current.canStart).toBe(true));
  expect(resumed.result.current.config.globalSpeed).toBe(1.7);
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it.each([
  '{corrupt',
  JSON.stringify({ ...configDraft(), sessionId: 'different' }),
])(
  'preserves unreadable draft bytes until explicit discard: %s',
  async (raw) => {
    localStorage.setItem(draftKey, raw);
    const hook = renderHook(() =>
      useDubbing({ initialSubtitlePath: '/old.srt' }),
    );
    await waitFor(() =>
      expect(hook.result.current.configRecovery).toBe('unreadable'),
    );
    expect(localStorage.getItem(draftKey)).toBe(raw);
    expect(
      invoke.mock.calls.some(([name]) => name === 'dubbing:syncVoiceState'),
    ).toBe(false);
    act(() => expect(hook.result.current.restoreConfigDraft()).toBe(false));
    await act(async () => {
      await hook.result.current.discardConfig();
    });
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    expect(localStorage.getItem(draftKey)).toBeNull();
  },
);

it('retries unreadable storage without deleting unseen drafts', async () => {
  localStorage.setItem(draftKey, JSON.stringify(configDraft()));
  const original = Storage.prototype.getItem;
  const spy = jest
    .spyOn(Storage.prototype, 'getItem')
    .mockImplementation(function (key) {
      if (key === draftKey) throw new Error('storage offline');
      return original.call(this, key);
    });
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() =>
    expect(hook.result.current.configRecovery).toBe('unreadable'),
  );
  await act(async () =>
    expect(await hook.result.current.discardConfig()).toBe(false),
  );
  spy.mockRestore();
  expect(localStorage.getItem(draftKey)).not.toBeNull();
  await act(async () =>
    expect(await hook.result.current.retryConfigDraft()).toBe(true),
  );
  expect(hook.result.current.configRecovery).toEqual(configDraft());
  act(() => hook.result.current.restoreConfigDraft());
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
});

it('keeps draft write or cleanup errors dirty and prevents false success', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = Storage.prototype.setItem;
  const writing = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(function (key, raw) {
      if (key === draftKey) throw new Error('draft quota');
      original.call(this, key, raw);
    });
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.3 }));
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('draft quota'),
  );
  expect(hook.result.current.canStart).toBe(false);
  writing.mockRestore();
  const removing = jest
    .spyOn(Storage.prototype, 'removeItem')
    .mockImplementation(() => {
      throw new Error('cleanup denied');
    });
  await act(async () =>
    expect(await hook.result.current.saveConfig()).toBe(false),
  );
  expect(hook.result.current.configDirty).toBe(true);
  expect(localStorage.getItem(draftKey)).not.toBeNull();
  removing.mockRestore();
  await act(async () =>
    expect(await hook.result.current.saveConfig()).toBe(true),
  );
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('never clears a replaced journal from a late save acknowledgement', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState'
      ? pending.promise
      : original(channel, payload),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.3 }));
  await waitFor(() => expect(hook.result.current.configSaving).toBe(true));
  const replacement = JSON.stringify(configDraft(1.8));
  localStorage.setItem(draftKey, replacement);
  await act(async () => pending.resolve({ success: true, data: view('old') }));
  expect(localStorage.getItem(draftKey)).toBe(replacement);
  expect(hook.result.current.configDirty).toBe(true);
  expect(hook.result.current.configError).toContain('another editor');
});

it('restores a newer durable journal when localStorage retained an older revision', async () => {
  localStorage.setItem(
    draftKey,
    JSON.stringify({ ...configDraft(1.1), revision: 1 }),
  );
  const original = invoke.getMockImplementation()!;
  const draft = { ...configDraft(1.8), revision: 2 };
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:readConfigDraft'
      ? Promise.resolve({ success: true, data: JSON.stringify(draft) })
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() =>
    expect(hook.result.current.configRecovery).toEqual(draft),
  );
  act(() => hook.result.current.restoreConfigDraft());
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.config.globalSpeed).toBe(1.8);
});

it('does not mark saved or lose a new edit arriving during journal cleanup', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const cleanup = deferred();
  const original = invoke.getMockImplementation()!;
  let held = false;
  invoke.mockImplementation((channel, payload) => {
    if (
      channel === 'dubbing:writeConfigDraft' &&
      payload.raw === null &&
      !held
    ) {
      held = true;
      return cleanup.promise;
    }
    return original(channel, payload);
  });
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.2 }));
  await waitFor(() => expect(held).toBe(true));
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.7 }));
  expect(JSON.parse(localStorage.getItem(draftKey)!).current.globalSpeed).toBe(
    1.7,
  );
  await act(async () => cleanup.resolve({ success: true, data: null }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(1.7);
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('reconciles a durable journal write whose acknowledgement was lost', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = invoke.getMockImplementation()!;
  let raw: string | null = null;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'dubbing:writeConfigDraft') {
      raw = payload.raw;
      return Promise.reject(new Error('journal response lost'));
    }
    if (channel === 'dubbing:readConfigDraft')
      return Promise.resolve({ success: true, data: raw });
    return original(channel, payload);
  });
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.3 }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.configError).toBeNull();
  expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(1.3);
  expect(raw).toBeNull();
});

it('retries journal acknowledgement and read failure without overwriting an unknown snapshot', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = invoke.getMockImplementation()!;
  let raw: string | null = null;
  let offline = true;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'dubbing:writeConfigDraft') {
      raw = payload.raw;
      return offline
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve({ success: true, data: raw });
    }
    if (channel === 'dubbing:readConfigDraft')
      return offline
        ? Promise.reject(new Error('read offline'))
        : Promise.resolve({ success: true, data: raw });
    return original(channel, payload);
  });
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.3 }));
  await waitFor(() => expect(hook.result.current.configSaving).toBe(false));
  expect(hook.result.current.configDirty).toBe(true);
  expect(hook.result.current.canStart).toBe(false);
  offline = false;
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.8 }));
  await act(async () =>
    expect(await hook.result.current.saveConfig()).toBe(true),
  );
  expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(1.8);
  expect(raw).toBeNull();
});

it('keeps journal failures guarded while the saved project remains untouched', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = invoke.getMockImplementation()!;
  invoke.mockClear();
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:writeConfigDraft'
      ? Promise.resolve({ success: false, error: 'journal disk full' })
      : original(channel, payload),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.3 }));
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('journal disk full'),
  );
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:syncVoiceState'),
  ).toBe(false);
  expect(hook.result.current.configDirty).toBe(true);
  expect(localStorage.getItem(draftKey)).not.toBeNull();
  invoke.mockImplementation(original);
  await act(async () =>
    expect(await hook.result.current.saveConfig()).toBe(true),
  );
});

it('waits for the other window, then reloads its latest config without saving stale defaults', async () => {
  jest.useFakeTimers();
  try {
    let locked = true;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'dubbing:loadSubtitle'
        ? Promise.resolve({
            success: true,
            data: locked
              ? { locked: true, sessionId: 'old' }
              : {
                  ...view('old'),
                  configSnapshot: {
                    engine: { kind: 'cloud', providerId: 'test' },
                    voice: 'voice',
                    globalSpeed: 1.4,
                    background: 'mute',
                    output: 'audioOnly',
                  },
                },
          })
        : original(channel, payload),
    );
    const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
    await act(async () => {});
    expect(hook.result.current.sessionLocked).toBe(true);
    expect(hook.result.current.configBlocked).toBe(true);
    act(() =>
      expect(hook.result.current.updateConfig({ globalSpeed: 1.8 })).toBe(
        false,
      ),
    );
    await act(async () =>
      expect(await hook.result.current.saveConfig()).toBe(false),
    );
    expect(
      invoke.mock.calls.some(([name]) => name === 'dubbing:syncVoiceState'),
    ).toBe(false);
    locked = false;
    await act(async () => jest.advanceTimersByTime(1000));
    expect(hook.result.current.sessionLocked).toBe(false);
    expect(hook.result.current.config.globalSpeed).toBe(1.4);
    expect(hook.result.current.canStart).toBe(true);
    hook.unmount();
  } finally {
    jest.useRealTimers();
  }
});

it('does not dispose another window session when leaving the waiting screen', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? Promise.resolve({
          success: true,
          data: { locked: true, sessionId: 'old' },
        })
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() => expect(hook.result.current.sessionLocked).toBe(true));
  hook.unmount();
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:disposeSession'),
  ).toBe(false);
});

it('releases a stale project reservation when rebuilding is declined', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? Promise.resolve({
          success: true,
          data: { stale: true, sessionId: 'old', subtitlePath: '/old.srt' },
        })
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() => expect(hook.result.current.staleRestore).not.toBeNull());
  act(() => hook.result.current.cancelRebuild());
  expect(invoke).toHaveBeenCalledWith('dubbing:disposeSession', {
    sessionId: 'old',
    leaseId: expect.any(String),
    keepRunning: true,
  });
});

it('accepts completion snapshots only for the current background session', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? Promise.resolve({
          success: true,
          data: { ...view('old'), running: true },
        })
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() => expect(hook.result.current.running).toBe(true));
  const listener = (window.ipc.on as jest.Mock).mock.calls.find(
    ([name]) => name === 'dubbing:sessionState',
  )[1];
  act(() =>
    listener({
      session: { ...view('new'), running: false },
      error: 'unrelated',
    }),
  );
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.actionError).toBeNull();
  act(() =>
    listener({
      session: { ...view('old'), leaseId: 'previous-editor', running: false },
      error: 'stale event',
    }),
  );
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.actionError).toBeNull();
  await act(async () =>
    listener({
      session: {
        ...view('old'),
        leaseId: hook.result.current.session?.leaseId,
        running: false,
      },
      exportResult: { outputPath: '/result.wav' },
      error: 'Recoverable detail',
    }),
  );
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.exportResult?.outputPath).toBe('/result.wav');
  expect(hook.result.current.actionError).toBe('Recoverable detail');
});

it('keeps the stale reservation throughout an asynchronous confirmed rebuild', async () => {
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) => {
    if (channel !== 'dubbing:loadSubtitle') return original(channel, payload);
    if (payload.rebuildSessionId) return pending.promise;
    return Promise.resolve({
      success: true,
      data: { stale: true, sessionId: 'old', subtitlePath: '/old.srt' },
    });
  });
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() => expect(hook.result.current.staleRestore).not.toBeNull());
  const leaseId = invoke.mock.calls.find(
    ([name]) => name === 'dubbing:loadSubtitle',
  )![1].leaseId;
  act(() => hook.result.current.confirmRebuild());
  await act(async () => {});
  expect(
    invoke.mock.calls.filter(([name]) => name === 'dubbing:loadSubtitle'),
  ).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith(
    'dubbing:loadSubtitle',
    expect.objectContaining({ leaseId, rebuildSessionId: 'old' }),
  );
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:disposeSession'),
  ).toBe(false);
  await act(async () => pending.resolve({ success: true, data: view('new') }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.session?.leaseId).toBe(leaseId);
  hook.unmount();
  expect(invoke).toHaveBeenCalledWith('dubbing:disposeSession', {
    sessionId: 'new',
    leaseId,
    keepRunning: true,
  });
});

it('cancels an abandoned pending load before its result returns', async () => {
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? pending.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(([name]) => name === 'dubbing:loadSubtitle'),
    ).toBe(true),
  );
  const leaseId = invoke.mock.calls.find(
    ([name]) => name === 'dubbing:loadSubtitle',
  )![1].leaseId;
  hook.unmount();
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('dubbing:disposeSession', {
    leaseId,
    keepRunning: true,
  });
  await act(async () =>
    pending.resolve({ success: false, error: 'cancelled' }),
  );
});

it('assigns a fresh lease when reopening the same project and ignores its old progress', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const leaseId = hook.result.current.session!.leaseId;
  act(() => hook.result.current.clearSubtitle());
  await waitFor(() => expect(hook.result.current.session).toBeNull());
  act(() => hook.result.current.setSubtitlePath('/old.srt'));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.session!.leaseId).not.toBe(leaseId);
  const progress = (window.ipc.on as jest.Mock).mock.calls.find(
    ([name]) => name === 'dubbing:progress',
  )[1];
  act(() =>
    progress({
      taskId: 'old',
      leaseId,
      percent: 99,
      stage: 'done',
      cue: { ...view('old').cues[0], text: 'stale' },
    }),
  );
  expect(hook.result.current.cues[0].text).toBe('old');
  act(() =>
    progress({
      taskId: 'old',
      leaseId: hook.result.current.session!.leaseId,
      percent: 99,
      stage: 'done',
      cue: { ...view('old').cues[0], text: 'current' },
    }),
  );
  expect(hook.result.current.cues[0].text).toBe('current');
});

it('retains config after local storage rejection, blocks actions and guards same-event navigation until retry', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = Storage.prototype.setItem;
  const write = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation((key, value) => {
      if (key === 'dubbingConfig') throw new Error('Quota exceeded');
      return original.call(localStorage, key, value);
    });
  const before = invoke.mock.calls.filter(
    ([name]) => name === 'dubbing:syncVoiceState',
  ).length;
  act(() => {
    hook.result.current.updateConfig({ globalSpeed: 1.3 });
    const guard = (useNavigationGuard as jest.Mock).mock.calls.at(-1)[1];
    expect(guard.getIsDirty()).toBe(true);
  });
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('Quota'),
  );
  expect(hook.result.current.config.globalSpeed).toBe(1.3);
  expect(hook.result.current.canStart).toBe(false);
  await act(async () => {
    await hook.result.current.start();
  });
  expect(invoke.mock.calls.some(([name]) => name === 'dubbing:start')).toBe(
    false,
  );
  expect(
    invoke.mock.calls.filter(([name]) => name === 'dubbing:syncVoiceState'),
  ).toHaveLength(before);
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  expect(hook.result.current.subtitlePath).toBe('/old.srt');
  write.mockRestore();
  await act(async () => {
    expect(await hook.result.current.saveConfig()).toBe(true);
  });
  expect(hook.result.current.configError).toBeNull();
  expect(hook.result.current.canStart).toBe(true);
  expect(JSON.parse(localStorage.getItem('dubbingConfig')!).globalSpeed).toBe(
    1.3,
  );
});

it('serializes config saves and saves edits arriving during an in-flight acknowledgement', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const first = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState' && payload.config.globalSpeed === 1.1
      ? first.promise
      : original(channel, payload),
  );
  await act(async () => {
    hook.result.current.updateConfig({ globalSpeed: 1.1 });
  });
  expect(hook.result.current.configSaving).toBe(true);
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.4 }));
  expect(await hook.result.current.discardConfig()).toBe(false);
  expect(
    invoke.mock.calls.some(
      ([channel, payload]) =>
        channel === 'dubbing:syncVoiceState' &&
        payload.config.globalSpeed === 1.4,
    ),
  ).toBe(false);
  await act(async () => first.resolve({ success: true, data: view('old') }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'dubbing:syncVoiceState')
      .at(-1)[1].config.globalSpeed,
  ).toBe(1.4);
  expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(1.4);
});

it('rejects failed IPC saves and reverts only to the last acknowledged settings', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState'
      ? Promise.resolve({ success: false, error: 'disk denied' })
      : original(channel, payload),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.5 }));
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('disk denied'),
  );
  expect(hook.result.current.configDirty).toBe(true);
  expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(1);
  await act(async () => {
    expect(await hook.result.current.discardConfig()).toBe(true);
  });
  expect(hook.result.current.config.globalSpeed).toBe(1);
  expect(JSON.parse(localStorage.getItem('dubbingConfig')!).globalSpeed).toBe(
    1,
  );
  expect(hook.result.current.canStart).toBe(true);
});

it('reconfirms the reverted configuration after a lost save acknowledgement', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:syncVoiceState' && payload.config.globalSpeed === 1.5
      ? Promise.reject(new Error('response lost'))
      : original(channel, payload),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.5 }));
  await waitFor(() =>
    expect(hook.result.current.configError).toContain('response lost'),
  );
  await act(async () => {
    expect(await hook.result.current.discardConfig()).toBe(true);
  });
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const writes = invoke.mock.calls.filter(
    ([channel]) => channel === 'dubbing:syncVoiceState',
  );
  expect(writes.at(-1)[1].config.globalSpeed).toBe(1);
});

it('preserves corrupt stored config until explicit reset and retries unavailable reads', async () => {
  localStorage.setItem('dubbingConfig', '{bad');
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  expect(hook.result.current.configError).not.toBeNull();
  expect(localStorage.getItem('dubbingConfig')).toBe('{bad');
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:loadSubtitle'),
  ).toBe(false);
  await act(async () => {
    expect(await hook.result.current.discardConfig()).toBe(true);
  });
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  hook.unmount();
  const read = jest
    .spyOn(Storage.prototype, 'getItem')
    .mockImplementation(() => {
      throw new Error('Read denied');
    });
  const retry = renderHook(() => useDubbing());
  expect(retry.result.current.configError).toContain('Read denied');
  read.mockRestore();
  await act(async () => {
    expect(await retry.result.current.saveConfig()).toBe(true);
  });
  expect(retry.result.current.configReady).toBe(true);
});

it.each([
  { engine: { kind: 'cloud', providerId: 'removed' }, voice: 'voice' },
  { engine: { kind: 'cloud', providerId: 'test' }, voice: 'removed' },
])(
  'retains an unavailable saved engine or voice without selecting a replacement: %j',
  async (selection) => {
    const snapshot = {
      ...selection,
      globalSpeed: 1.25,
      background: 'mute',
      output: 'audioOnly',
    };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'dubbing:loadSubtitle'
        ? Promise.resolve({
            success: true,
            data: { ...view('old'), configSnapshot: snapshot },
          })
        : original(channel, payload),
    );
    const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
    await waitFor(() =>
      expect(hook.result.current.session?.configSnapshot?.globalSpeed).toBe(
        1.25,
      ),
    );
    await waitFor(() => expect(hook.result.current.configSaving).toBe(false));
    expect(hook.result.current.canStart).toBe(false);
    expect(hook.result.current.config.engineKey).toBe(
      `cloud:${selection.engine.providerId}`,
    );
    expect(hook.result.current.config.voice).toBe(selection.voice);
    const writes = invoke.mock.calls.filter(
      ([channel]) => channel === 'dubbing:syncVoiceState',
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const [, payload] of writes) {
      expect(payload.config.engine).toEqual(selection.engine);
      expect(payload.config.voice).toBe(selection.voice);
    }
    act(() =>
      hook.result.current.updateConfig({
        engineKey: 'cloud:test',
        voice: 'voice',
      }),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    expect(hook.result.current.session?.configSnapshot?.voice).toBe('voice');
  },
);

it.each([
  { background: 'invalid' },
  { output: 'invalid' },
  { audioFormat: 'invalid' },
  { overlapMode: 'invalid' },
  { overflow: 'invalid' },
  { cloneQuality: 'invalid' },
  { localConcurrency: 1.5 },
  { exportShiftedSubtitle: 'false' },
  { language: 4 },
  { engineKey: 'cloud:' },
])(
  'preserves invalid stored fields for explicit recovery: %j',
  async (invalid) => {
    const raw = JSON.stringify(invalid);
    localStorage.setItem('dubbingConfig', raw);
    const hook = renderHook(() => useDubbing());
    expect(hook.result.current.configReady).toBe(false);
    expect(hook.result.current.configError).not.toBeNull();
    expect(localStorage.getItem('dubbingConfig')).toBe(raw);
    await act(async () => {});
  },
);

it('allows replacing an unconfigured project but never acknowledges incomplete edits as saved', async () => {
  localStorage.setItem(
    'dubbingConfig',
    JSON.stringify({ engineKey: 'cloud:missing', voice: '' }),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('old'),
  );
  expect(hook.result.current.configBlocked).toBe(false);
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  act(() => hook.result.current.updateConfig({ globalSpeed: 1.2 }));
  await waitFor(() => expect(hook.result.current.configError).not.toBeNull());
  expect(hook.result.current.configDirty).toBe(true);
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'dubbing:syncVoiceState'),
  ).toBe(false);
});

it.each(['start', 'export'] as const)(
  'keeps %s IPC errors visible and retryable without erasing cues',
  async (operation) => {
    const hook = renderHook(() =>
      useDubbing({ initialSubtitlePath: '/old.srt' }),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === `dubbing:${operation}`
        ? Promise.reject(new Error('Transport unavailable'))
        : original(channel, payload),
    );
    const before = hook.result.current.cues;
    await act(async () => {
      if (operation === 'start')
        await hook.result.current.start({ force: true });
      else expect(await hook.result.current.exportDubbing()).toBeNull();
    });
    expect(hook.result.current.actionError).toContain('Transport unavailable');
    expect(hook.result.current.cues).toEqual(before);
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.exporting).toBe(false);
    invoke.mockImplementation((channel, payload) =>
      channel === `dubbing:${operation}`
        ? Promise.resolve({
            success: true,
            data:
              operation === 'start'
                ? view('old')
                : { outputPath: '/result.wav' },
          })
        : original(channel, payload),
    );
    await act(async () => {
      if (operation === 'start') await hook.result.current.start();
      else
        expect(await hook.result.current.exportDubbing()).toEqual({
          outputPath: '/result.wav',
        });
    });
    expect(hook.result.current.actionError).toBeNull();
  },
);

it.each(['start', 'export'] as const)(
  'serializes same-event %s and isolates late results from another session',
  async (operation) => {
    const hook = renderHook(() =>
      useDubbing({ initialSubtitlePath: '/old.srt' }),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    const pending = deferred();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === `dubbing:${operation}`
        ? pending.promise
        : original(channel, payload),
    );
    let first!: Promise<unknown>;
    await act(async () => {
      first =
        operation === 'start'
          ? hook.result.current.start()
          : hook.result.current.exportDubbing();
      if (operation === 'start') await hook.result.current.start();
      else await hook.result.current.exportDubbing();
    });
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === `dubbing:${operation}`,
      ),
    ).toHaveLength(1);
    act(() => hook.result.current.setSubtitlePath('/new.srt'));
    await waitFor(() =>
      expect(hook.result.current.session?.sessionId).toBe('new'),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    await act(async () => {
      pending.resolve({
        success: true,
        data: operation === 'start' ? view('old') : { outputPath: '/old.wav' },
      });
      await first;
    });
    expect(hook.result.current.cues[0].text).toBe('new');
    expect(hook.result.current.exportResult).toBeNull();
    expect(hook.result.current.batchSummary).toBeNull();
  },
);

it('restores an interrupted operation warning without resubmitting it', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? Promise.resolve({
          success: true,
          data: {
            ...view('old'),
            operationRecovery: {
              requestId: 'prior',
              channel: 'dubbing:start',
              status: 'interrupted',
            },
          },
        })
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  expect(hook.result.current.actionError).toContain('operationInterrupted');
  expect(invoke.mock.calls.some(([name]) => name === 'dubbing:start')).toBe(
    false,
  );
});

it('restores a completed export receipt after remount', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? Promise.resolve({
          success: true,
          data: {
            ...view('old'),
            operationRecovery: {
              requestId: 'prior',
              channel: 'dubbing:export',
              status: 'complete',
              result: { success: true, data: { outputPath: '/saved.wav' } },
            },
          },
        })
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }));
  await waitFor(() =>
    expect(hook.result.current.exportResult?.outputPath).toBe('/saved.wav'),
  );
  expect(invoke.mock.calls.some(([name]) => name === 'dubbing:export')).toBe(
    false,
  );
});

it.each(['start', 'export'] as const)(
  'retains a successful %s result and exposes a failed recovery receipt',
  async (operation) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === `dubbing:${operation}`
        ? Promise.resolve({
            success: true,
            data:
              operation === 'start'
                ? view('old')
                : { outputPath: '/saved.wav' },
            recoveryWarning: 'disk full',
          })
        : original(channel, payload),
    );
    const hook = renderHook(() =>
      useDubbing({ initialSubtitlePath: '/old.srt' }),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    await act(async () => {
      if (operation === 'start') await hook.result.current.start();
      else
        expect((await hook.result.current.exportDubbing())?.outputPath).toBe(
          '/saved.wav',
        );
    });
    expect(hook.result.current.actionError).toContain('operationReceiptFailed');
  },
);

it('reports cancellation rejection and releases the button for retry', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:cancel' ? pending.promise : original(channel, payload),
  );
  let first!: Promise<void>;
  await act(async () => {
    first = hook.result.current.cancel();
    await hook.result.current.cancel();
  });
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'dubbing:cancel'),
  ).toHaveLength(1);
  await act(async () => {
    pending.resolve({ success: false, error: 'Cancel rejected' });
    await first;
  });
  expect(hook.result.current.actionError).toContain('Cancel rejected');
  expect(hook.result.current.isCancelling).toBe(false);
  invoke.mockImplementation(original);
  await act(async () => hook.result.current.cancel());
  expect(hook.result.current.actionError).toBeNull();
});

it('reuses a StrictMode in-flight restore and retains its task identity', async () => {
  const pending = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle'
      ? pending.promise
      : original(channel, payload),
  );
  const hook = renderHook(() => useDubbing({ initialSessionId: 'old' }), {
    wrapper: React.StrictMode,
  });
  await act(async () => pending.resolve({ success: true, data: view('old') }));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('old'),
  );
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'dubbing:loadSubtitle'),
  ).toHaveLength(1);
  expect(hook.result.current.subtitlePath).toBe('/old.srt');
  expect(hook.result.current.session?.workItemId).toBe('work-old');
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'dubbing:disposeSession',
    ),
  ).toHaveLength(0);
});

it('discards late loads and keeps a replacement subtitle in a separate task', async () => {
  const old = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:loadSubtitle' && payload.subtitlePath === '/old.srt'
      ? old.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt', workItemId: 'old-work' }),
  );
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  await act(async () => old.resolve({ success: true, data: view('old') }));
  expect(hook.result.current.cues[0].text).toBe('new');
  expect(invoke).toHaveBeenCalledWith('dubbing:disposeSession', {
    leaseId: invoke.mock.calls.find(
      ([channel]) => channel === 'dubbing:loadSubtitle',
    )![1].leaseId,
    keepRunning: true,
  });
  const payload = invoke.mock.calls.find(
    ([channel, value]) =>
      channel === 'dubbing:loadSubtitle' && value.subtitlePath === '/new.srt',
  )![1];
  expect(payload.workItemId).toBeUndefined();
});

it('serializes role saves and does not apply a late response to another session', async () => {
  const saving = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:setSpeakerSettings'
      ? saving.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => {
    first = hook.result.current.setSpeakerSettings(1, { speed: 1.5, pitch: 2 });
    second = hook.result.current.setSpeakerVoice(1, 'other');
  });
  expect(await second).toBe(false);
  expect(hook.result.current.canStart).toBe(false);
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'dubbing:setSpeakerSettings',
    ),
  ).toHaveLength(1);
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  await act(async () => {
    saving.resolve({
      success: true,
      data: {
        speakerSettings: { 1: { speed: 1.5, pitch: 2 } },
        cues: view('old').cues,
      },
    });
    expect(await first).toBe(false);
  });
  expect(hook.result.current.cues[0].text).toBe('new');
  expect(hook.result.current.speakerSettings).toEqual({});
});

it('releases a load that completes after unmount', async () => {
  const pending = deferred();
  invoke.mockImplementation((channel) =>
    channel === 'dubbing:loadSubtitle'
      ? pending.promise
      : Promise.resolve({ success: true }),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  hook.unmount();
  await act(async () => pending.resolve({ success: true, data: view('old') }));
  expect(invoke).toHaveBeenCalledWith('dubbing:disposeSession', {
    leaseId: invoke.mock.calls.find(
      ([channel]) => channel === 'dubbing:loadSubtitle',
    )![1].leaseId,
    keepRunning: true,
  });
});
it('clears a subtitle imported after initial mount without reusing the prior task', async () => {
  const hook = renderHook(() => useDubbing());
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  act(() => hook.result.current.clearSubtitle());
  await waitFor(() => expect(hook.result.current.session).toBeNull());
  expect(hook.result.current.subtitlePath).toBeNull();
  expect(hook.result.current.cues).toEqual([]);
});
it('updates media on the same session and retains cues; failed edits retain the previous media', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:setMedia'
      ? Promise.resolve(
          payload.videoPath === '/bad.mp4'
            ? { success: false, error: 'media failed' }
            : {
                success: true,
                data: { videoPath: payload.videoPath, mediaDurationMs: 3000 },
              },
        )
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  await act(async () => hook.result.current.setVideoPath('/media.mp4'));
  expect(hook.result.current.videoPath).toBe('/media.mp4');
  expect(hook.result.current.session?.sessionId).toBe('old');
  expect(hook.result.current.cues[0].text).toBe('old');
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'dubbing:loadSubtitle'),
  ).toHaveLength(1);
  await act(async () => hook.result.current.setVideoPath('/bad.mp4'));
  expect(hook.result.current.videoPath).toBe('/media.mp4');
  expect(hook.result.current.actionError).toBe('media failed');
  await act(async () => hook.result.current.clearVideo());
  expect(hook.result.current.videoPath).toBeNull();
});
it('imports a new subtitle and its media together without editing the old session', async () => {
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  act(() => {
    hook.result.current.setSubtitlePath('/new.srt');
    void hook.result.current.setVideoPath('/new.mp4');
  });
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  expect(
    invoke.mock.calls.find(
      ([channel, payload]) =>
        channel === 'dubbing:loadSubtitle' &&
        payload.subtitlePath === '/new.srt',
    )![1].videoPath,
  ).toBe('/new.mp4');
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'dubbing:setMedia'),
  ).toHaveLength(0);
});

it('acknowledges a cue voice only after persistence, and keeps errors retryable', async () => {
  const save = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:setCueVoice'
      ? save.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  let result!: Promise<boolean>;
  act(() => {
    result = hook.result.current.setCueVoice(0, 'other');
  });
  expect(hook.result.current.cues[0].voiceId).toBeUndefined();
  expect(hook.result.current.canStart).toBe(false);
  await act(async () => {
    save.resolve({ success: false, error: 'disk full' });
    expect(await result).toBe(false);
  });
  expect(hook.result.current.actionError).toBe('disk full');
  expect(hook.result.current.cues[0].voiceId).toBeUndefined();
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:setCueVoice'
      ? { success: true, data: { ...view('old').cues[0], voiceId: 'other' } }
      : original(channel, payload),
  );
  await act(async () => {
    expect(await hook.result.current.setCueVoice(0, 'other')).toBe(true);
  });
  expect(hook.result.current.cues[0].voiceId).toBe('other');
});

it('ignores a cue save response after switching sessions', async () => {
  const save = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:setCueVoice'
      ? save.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  let result!: Promise<boolean>;
  act(() => {
    result = hook.result.current.setCueVoice(0, 'other');
  });
  act(() => hook.result.current.setSubtitlePath('/new.srt'));
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe('new'),
  );
  await act(async () => {
    save.resolve({
      success: true,
      data: { ...view('old').cues[0], voiceId: 'other' },
    });
    expect(await result).toBe(false);
  });
  expect(hook.result.current.cues[0].text).toBe('new');
  expect(hook.result.current.cues[0].voiceId).toBeUndefined();
});

it('reports resynthesis failures and rejects concurrent cue mutations', async () => {
  const generate = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:resynthesizeCue'
      ? generate.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  let result!: Promise<boolean>;
  act(() => {
    result = hook.result.current.resynthesizeCue(0, { text: 'replacement' });
  });
  expect(await hook.result.current.setCueVoice(0, 'other')).toBe(false);
  await act(async () => {
    generate.resolve({ success: false, error: 'synthesis unavailable' });
    expect(await result).toBe(false);
  });
  expect(hook.result.current.actionError).toBe('synthesis unavailable');
  expect(hook.result.current.cues[0].status).toBe('failed');
  expect(hook.result.current.speakerUpdating).toBe(false);
});

it('keeps borrowing retryable, blocks concurrent saves, and only accepts durable results', async () => {
  const save = deferred();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:borrowSilence'
      ? save.promise
      : original(channel, payload),
  );
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  let result!: Promise<boolean>;
  act(() => {
    result = hook.result.current.borrowSilence(0);
  });
  expect(await hook.result.current.setCueVoice(0, 'other')).toBe(false);
  await act(async () => {
    save.resolve({ success: false, error: 'disk full' });
    expect(await result).toBe(false);
  });
  expect(hook.result.current.actionError).toBe('disk full');
  expect(hook.result.current.cues[0].borrowedMs).toBeUndefined();
  invoke.mockImplementation((channel, payload) =>
    channel === 'dubbing:borrowSilence'
      ? Promise.resolve({
          success: true,
          data: { ...view('old').cues[0], status: 'accepted', borrowedMs: 800 },
        })
      : original(channel, payload),
  );
  await act(async () =>
    expect(await hook.result.current.borrowSilence(0)).toBe(true),
  );
  expect(hook.result.current.cues[0].borrowedMs).toBe(800);
});

it.each(['cancel', 'session', 'config'])(
  'does not synthesize late AI output after %s',
  async (kind) => {
    const ai = deferred();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'optimizeSubtitle' ? ai.promise : original(channel, payload),
    );
    const hook = renderHook(() =>
      useDubbing({ initialSubtitlePath: '/old.srt' }),
    );
    await waitFor(() => expect(hook.result.current.canStart).toBe(true));
    let result!: Promise<boolean>;
    act(() => {
      result = hook.result.current.resynthesizeCue(0, {
        shortenProviderId: 'ai',
      });
    });
    await act(async () => {
      if (kind === 'cancel') hook.result.current.cancelShortening();
      if (kind === 'session') hook.result.current.setSubtitlePath('/new.srt');
      if (kind === 'config')
        hook.result.current.updateConfig({ globalSpeed: 1.1 });
    });
    await act(async () => {
      ai.resolve({ success: true, data: 'X' });
      expect(await result).toBe(false);
    });
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === 'dubbing:resynthesizeCue',
      ),
    ).toBe(false);
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'cancelProofreadBatch'),
    ).toBe(true);
    expect(hook.result.current.speakerUpdating).toBe(false);
  },
);

it('rejects AI text that is not shorter, and preserves speaker labels on successful resynthesis', async () => {
  const original = invoke.getMockImplementation()!;
  let proposed = 'Not shorter';
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'optimizeSubtitle')
      return Promise.resolve({ success: true, data: proposed });
    if (
      channel === 'dubbing:loadSubtitle' ||
      channel === 'dubbing:syncVoiceState'
    ) {
      const data = view('old');
      data.cues[0].text = '[Speaker 1] Hello.';
      data.cues[0].status = 'overlong';
      return Promise.resolve({ success: true, data });
    }
    if (channel === 'dubbing:resynthesizeCue')
      return Promise.resolve({
        success: true,
        data: {
          ...view('old').cues[0],
          text: payload.text,
          status: 'done',
          wavPath: '/new.wav',
        },
      });
    return original(channel, payload);
  });
  const hook = renderHook(() =>
    useDubbing({ initialSubtitlePath: '/old.srt' }),
  );
  await waitFor(() => expect(hook.result.current.canStart).toBe(true));
  await act(async () =>
    expect(
      await hook.result.current.resynthesizeCue(0, { shortenProviderId: 'ai' }),
    ).toBe(false),
  );
  expect(hook.result.current.cues[0].status).toBe('overlong');
  expect(hook.result.current.cues[0].text).toBe('[Speaker 1] Hello.');
  proposed = 'Hi.';
  await act(async () =>
    expect(
      await hook.result.current.resynthesizeCue(0, { shortenProviderId: 'ai' }),
    ).toBe(true),
  );
  const call = invoke.mock.calls.find(
    ([channel]) => channel === 'dubbing:resynthesizeCue',
  )![1];
  expect(call.text).toBe('[Speaker 1] Hi.');
  expect(call.expectedCue.text).toBe('[Speaker 1] Hello.');
  expect(hook.result.current.cues[0].text).toBe('[Speaker 1] Hi.');
});
