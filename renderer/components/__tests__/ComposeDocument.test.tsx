import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { useComposeDocument } from '../subtitleMerge/hooks/useComposeDocument';
import { getDefaultStyle } from '../subtitleMerge/constants';
import {
  type ComposeDocument,
  readComposeDraft,
  writeComposeDraft,
} from '../../lib/composeDraft';

// Lock lifecycle and contention are exercised separately with the real helper.
jest.mock('../../lib/composeDraftLock', () => ({
  acquireComposeDraftLock: (_key: string, acquired: () => void) => {
    acquired();
    return () => {};
  },
}));

const initial = (): ComposeDocument => ({
  videoPath: '/video.mp4',
  subtitlePath: '/subtitle.srt',
  audioTrackPath: null,
  audioTrackMode: 'replace',
  style: getDefaultStyle(),
  activePresetId: 'classic',
  outputPath: '/result.mp4',
  outputMode: 'hardcode',
  softContainer: 'mkv',
  videoQuality: 'original',
  encoderMode: 'cpu',
});
let key: string;
beforeEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  key = `compose-test-${Math.random()}`;
});

it('groups one gesture, splits subsequent gestures, ignores no-ops and preserves redo until a real edit', () => {
  const { result } = renderHook(() => useComposeDocument(key, initial()));
  act(() => result.current.update({ outputPath: '/result.mp4' }));
  expect(result.current.canUndo).toBe(false);
  act(() => {
    result.current.update(
      (doc) => ({ style: { ...doc.style, positionY: 40 } }),
      { group: 'positionY' },
    );
    result.current.update(
      (doc) => ({ style: { ...doc.style, positionY: 45 } }),
      { group: 'positionY' },
    );
  });
  act(() => result.current.undo());
  expect(result.current.value.style.positionY).toBeUndefined();
  expect(result.current.dirty).toBe(false);
  act(() => result.current.update({ outputPath: '/result.mp4' }));
  expect(result.current.canRedo).toBe(true);
  act(() => result.current.redo());
  expect(result.current.value.style.positionY).toBe(45);
  act(() => {
    result.current.endGroup();
    result.current.update(
      (doc) => ({ style: { ...doc.style, positionY: 60 } }),
      { group: 'positionY' },
    );
  });
  act(() => result.current.undo());
  expect(result.current.value.style.positionY).toBe(45);
});

it('restores all fields and saved baseline after StrictMode remount', async () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <React.StrictMode>{children}</React.StrictMode>
  );
  const first = renderHook(() => useComposeDocument(key, initial()), {
    wrapper,
  });
  const change = {
    style: { ...getDefaultStyle(), positionY: 45, positionReferenceY: 30 },
    audioTrackPath: '/voice.wav',
    audioTrackMode: 'mix' as const,
    softContainer: 'mp4' as const,
    outputMode: 'softmux' as const,
    videoQuality: 'high' as const,
    encoderMode: 'hardware' as const,
    activePresetId: null,
  };
  act(() => first.result.current.update(change));
  first.unmount();
  const second = renderHook(() => useComposeDocument(key, initial()), {
    wrapper,
  });
  expect(second.result.current.recovery?.dirty).toBe(true);
  act(() =>
    second.result.current.update({ videoPath: '/must-not-change.mp4' }),
  );
  expect(second.result.current.value.videoPath).toBe('/video.mp4');
  act(() => second.result.current.restore());
  expect(second.result.current.value).toEqual({ ...initial(), ...change });
  expect(second.result.current.getIsDirty()).toBe(true);
  act(() => second.result.current.undo());
  expect(second.result.current.value).toEqual(initial());
  act(() => second.result.current.redo());
  await act(async () => {
    expect(await second.result.current.save()).toBe(true);
  });
  expect(second.result.current.dirty).toBe(false);
  second.unmount();
  const third = renderHook(() => useComposeDocument(key, initial()), {
    wrapper,
  });
  expect(third.result.current.recovery).toBeNull();
  expect(third.result.current.value).toEqual({ ...initial(), ...change });
});

it('failed writes retain the unsaved memory draft and never advance the saved baseline', async () => {
  const storage = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Disk full');
    });
  const first = renderHook(() => useComposeDocument(key, initial()));
  act(() => first.result.current.update({ outputPath: '/changed.mp4' }));
  await act(async () => {
    expect(await first.result.current.save()).toBe(false);
  });
  expect(first.result.current.getIsDirty()).toBe(true);
  expect(first.result.current.error).toContain('Disk full');
  expect(readComposeDraft(key)?.dirty).toBe(true);
  first.unmount();
  const second = renderHook(() => useComposeDocument(key, initial()));
  expect(second.result.current.recovery?.current.outputPath).toBe(
    '/changed.mp4',
  );
  act(() => second.result.current.restore());
  act(() => {
    expect(second.result.current.discard()).toBe(false);
  });
  expect(second.result.current.getIsDirty()).toBe(true);
  storage.mockRestore();
  await act(async () => {
    expect(await second.result.current.save()).toBe(true);
  });
  expect(JSON.parse(localStorage.getItem(key)!).dirty).toBe(false);
});

it('reads the native canvas reference from disk without losing it during schema validation', () => {
  const value = {
    ...initial(),
    style: { ...getDefaultStyle(), positionY: 60, positionReferenceY: 32.5 },
  };
  localStorage.setItem(
    key,
    JSON.stringify({ version: 1, current: value, saved: value, dirty: false }),
  );
  expect(readComposeDraft(key)?.current.style.positionReferenceY).toBe(32.5);
});

it('failed recovery discard preserves the draft and dialog until removal succeeds', () => {
  writeComposeDraft(key, {
    version: 1,
    current: { ...initial(), outputPath: '/changed.mp4' },
    saved: initial(),
    dirty: true,
  });
  const storage = jest
    .spyOn(Storage.prototype, 'removeItem')
    .mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
  const { result } = renderHook(() => useComposeDocument(key, initial()));
  act(() => {
    expect(result.current.discard()).toBe(false);
  });
  expect(result.current.recovery).not.toBeNull();
  expect(readComposeDraft(key)?.current.outputPath).toBe('/changed.mp4');
  storage.mockRestore();
  act(() => {
    expect(result.current.discard()).toBe(true);
  });
  expect(result.current.recovery).toBeNull();
  expect(readComposeDraft(key)).toBeNull();
});

it('blocks malformed disk drafts without overwriting them and supports read retry', () => {
  localStorage.setItem(key, '{broken');
  const { result } = renderHook(() => useComposeDocument(key, initial()));
  expect(result.current.readFailed).toBe(true);
  act(() => result.current.update({ outputPath: '/no.mp4' }));
  expect(localStorage.getItem(key)).toBe('{broken');
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      current: initial(),
      saved: initial(),
      dirty: false,
    }),
  );
  act(() => result.current.retryRead());
  expect(result.current.readFailed).toBe(false);
  expect(result.current.error).toBeNull();
});

it('tracks dirty state synchronously and does not add system initialization to history', () => {
  const { result } = renderHook(() => useComposeDocument(key, initial()));
  const getIsDirty = result.current.getIsDirty;
  act(() =>
    result.current.update({ outputPath: '/default.mp4' }, { system: true }),
  );
  expect(result.current.dirty).toBe(false);
  expect(result.current.canUndo).toBe(false);
  act(() => {
    result.current.update({ outputPath: '/user.mp4' });
    expect(getIsDirty()).toBe(true);
  });
  expect(result.current.getIsDirty).toBe(getIsDirty);
});

it('retains a navigation guard when returning to the saved baseline cannot update disk', async () => {
  const { result } = renderHook(() => useComposeDocument(key, initial()));
  await act(async () => {
    await result.current.save();
  });
  act(() => result.current.update({ outputPath: '/changed.mp4' }));
  const write = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Disk full');
    });
  act(() => result.current.undo());
  expect(result.current.value).toEqual(initial());
  expect(result.current.getIsDirty()).toBe(true);
  expect(readComposeDraft(key)?.current).toEqual(initial());
  write.mockRestore();
  await act(async () => {
    expect(await result.current.save()).toBe(true);
  });
  expect(result.current.getIsDirty()).toBe(false);
});

it('reads external writes and deletions instead of returning stale successful-write memory', () => {
  const draft = {
    version: 1 as const,
    current: initial(),
    saved: initial(),
    dirty: false,
  };
  writeComposeDraft(key, draft);
  expect(readComposeDraft(key)?.current.outputPath).toBe('/result.mp4');
  localStorage.setItem(
    key,
    JSON.stringify({
      ...draft,
      current: { ...initial(), outputPath: '/external.mp4' },
    }),
  );
  expect(readComposeDraft(key)?.current.outputPath).toBe('/external.mp4');
  localStorage.removeItem(key);
  expect(readComposeDraft(key)).toBeNull();
  localStorage.setItem(key, '{broken');
  expect(() => readComposeDraft(key)).toThrow();
});
