import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { acquireComposeDraftLock } from '../../lib/composeDraftLock';
import { useComposeDocument } from '../subtitleMerge/hooks/useComposeDocument';
import { getDefaultStyle } from '../subtitleMerge/constants';
import type { ComposeDocument } from '../../lib/composeDraft';

const initial: ComposeDocument = {
  videoPath: '/video.mp4',
  subtitlePath: '/subtitle.srt',
  audioTrackPath: null,
  audioTrackMode: 'replace',
  style: getDefaultStyle(),
  activePresetId: null,
  outputPath: '/out.mp4',
  outputMode: 'hardcode',
  softContainer: 'mkv',
  videoQuality: 'original',
  encoderMode: 'cpu',
};

function mockLockManager() {
  const queues = new Map<string, (() => void)[]>();
  return {
    request: jest.fn(
      (
        key: string,
        { signal }: { signal: AbortSignal },
        callback: () => Promise<void>,
      ) =>
        new Promise<void>((resolve, reject) => {
          const queue = queues.get(key) || [];
          queues.set(key, queue);
          const abort = () => {
            const index = queue.indexOf(start);
            if (index < 0) return;
            queue.splice(index, 1);
            reject(new DOMException('Aborted', 'AbortError'));
            if (index === 0) queueMicrotask(() => queue[0]?.());
          };
          const start = () => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) {
              abort();
              return;
            }
            Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => {
                queue.shift();
                queue[0]?.();
              });
          };
          signal.addEventListener('abort', abort, { once: true });
          queue.push(start);
          if (queue.length === 1) queueMicrotask(start);
        }),
    ),
  };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: mockLockManager(),
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

it('serializes same-document windows, reads the latest saved baseline after handoff, and permits different documents', async () => {
  const first = renderHook(() => useComposeDocument('shared', initial));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  const second = renderHook(() => useComposeDocument('shared', initial));
  const different = renderHook(() => useComposeDocument('different', initial));
  await waitFor(() => expect(different.result.current.ready).toBe(true));
  expect(second.result.current.lockState).toBe('waiting');
  act(() =>
    expect(second.result.current.update({ outputPath: '/wrong.mp4' })).toBe(
      false,
    ),
  );
  act(() => expect(second.result.current.discard()).toBe(false));
  await act(async () => expect(await second.result.current.save()).toBe(false));
  act(() => first.result.current.update({ outputPath: '/latest.mp4' }));
  await act(async () => expect(await first.result.current.save()).toBe(true));
  first.unmount();
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(second.result.current.value.outputPath).toBe('/latest.mp4');
  expect(second.result.current.dirty).toBe(false);
});

it('restores dirty work after the lock is released and handles StrictMode cleanup', async () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <React.StrictMode>{children}</React.StrictMode>
  );
  const first = renderHook(() => useComposeDocument('dirty', initial), {
    wrapper,
  });
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  act(() => first.result.current.update({ outputPath: '/dirty.mp4' }));
  const second = renderHook(() => useComposeDocument('dirty', initial), {
    wrapper,
  });
  first.unmount();
  await waitFor(() => expect(second.result.current.recovery?.dirty).toBe(true));
  act(() => second.result.current.restore());
  expect(second.result.current.value.outputPath).toBe('/dirty.mp4');
  expect(second.result.current.dirty).toBe(true);
});

it('aborts abandoned waiters without acquiring or leaking the lock', async () => {
  const acquired = jest.fn(),
    failed = jest.fn();
  const release = acquireComposeDraftLock('queued', acquired, failed);
  await waitFor(() => expect(acquired).toHaveBeenCalledTimes(1));
  const abandoned = jest.fn();
  const cancel = acquireComposeDraftLock('queued', abandoned, failed);
  cancel();
  release();
  const third = jest.fn();
  const finish = acquireComposeDraftLock('queued', third, failed);
  await waitFor(() => expect(third).toHaveBeenCalledTimes(1));
  expect(abandoned).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  finish();
});

it('fails closed when locking is unavailable and can retry after recovery', async () => {
  Reflect.deleteProperty(navigator, 'locks');
  const { result } = renderHook(() => useComposeDocument('failed', initial));
  expect(result.current.lockState).toBe('error');
  expect(result.current.isBlocked()).toBe(true);
  act(() =>
    expect(result.current.update({ outputPath: '/wrong.mp4' })).toBe(false),
  );
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: mockLockManager(),
  });
  act(() => result.current.retryLock());
  await waitFor(() => expect(result.current.lockState).toBe('owned'));
  expect(result.current.error).toBeNull();
});
