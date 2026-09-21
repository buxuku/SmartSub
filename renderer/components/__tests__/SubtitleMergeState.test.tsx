import { act, renderHook, waitFor } from '@testing-library/react';
import { useSubtitleMerge } from '../subtitleMerge/hooks/useSubtitleMerge';
import { getDefaultStyle } from '../subtitleMerge/constants';
import {
  clearComposeDraft,
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from '../../lib/composeDraft';

jest.mock('../../lib/composeDraftLock', () => ({
  acquireComposeDraftLock: (_key: string, acquired: () => void) => {
    acquired();
    return () => {};
  },
}));

let invoke: jest.Mock;
let listeners: Map<string, (...args: any[]) => void>;
const queuedJob = (id: string, requestId = id) => ({
  id,
  requestId,
  source: 'subtitleMerge' as const,
  status: 'queued' as const,
  videoPath: '/first.mp4',
  subtitlePath: '/first.srt',
  outputPath: '/result.mp4',
  subtitleMode: 'hard' as const,
  style: getDefaultStyle(),
  videoQuality: 'high' as const,
  encoderMode: 'cpu' as const,
  createdAt: 1,
});
beforeEach(() => {
  jest.restoreAllMocks();
  clearComposeDraft(composeDraftKey());
  clearComposeDraft(composeDraftKey('/first.mp4'));
  invoke = jest.fn().mockImplementation(async (channel, payload) => {
    if (channel === 'subtitleMerge:getPreferences')
      return { success: true, data: {} };
    if (channel === 'subtitleMerge:getVideoInfo')
      return {
        success: true,
        data: { path: payload.videoPath, width: 360, height: 640 },
      };
    if (channel === 'subtitleMerge:getSubtitleInfo')
      return { success: true, data: { path: payload.subtitlePath, count: 1 } };
    if (channel === 'subtitleMerge:generateOutputPath')
      return {
        success: true,
        data: payload.videoPath.replace('.mp4', '_subtitled.mp4'),
      };
    if (
      channel === 'subtitleMerge:listStylePresets' ||
      channel === 'subtitleMerge:getQueue'
    )
      return { success: true, data: [] };
    return { success: true, data: true };
  });
  listeners = new Map();
  window.ipc = {
    invoke,
    on: jest.fn((channel, handler) => {
      listeners.set(channel, handler);
      return () => {
        if (listeners.get(channel) === handler) listeners.delete(channel);
      };
    }),
  } as any;
});

it('persists request identity before IPC and reconnects the exact second same-path job without an acknowledgement', async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(channel, payload),
  );
  const first = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await first.result.current.setVideoPath('/first.mp4');
    await first.result.current.setSubtitlePath('/first.srt');
  });
  act(() => first.result.current.setOutputPath('/result.mp4'));
  await act(async () => {
    await first.result.current.document.save();
  });
  let run!: Promise<void>;
  act(() => {
    run = first.result.current.startMerge();
  });
  const request = invoke.mock.calls.find(
    ([channel]) => channel === 'subtitleMerge:startMerge',
  )![1];
  expect(readComposeDraft(composeDraftKey())?.job).toEqual({
    requestId: request.requestId,
  });
  expect(first.result.current.document.dirty).toBe(false);
  first.unmount();
  const ours = {
    ...queuedJob('ours', request.requestId),
    style: { ...getDefaultStyle(), fontSize: 48 },
  };
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getQueue'
      ? Promise.resolve({ success: true, data: [queuedJob('unrelated'), ours] })
      : original(channel, payload),
  );
  const second = renderHook(() => useSubtitleMerge());
  await waitFor(() =>
    expect(second.result.current.progress.jobId).toBe('ours'),
  );
  expect(second.result.current.style.fontSize).toBe(48);
  await act(async () => second.result.current.cancelMerge());
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:cancelMerge', {
    jobId: 'ours',
  });
  await act(async () => {
    finish({ success: true, cancelled: true });
    await run;
  });
});

it('restores the terminal result by identity even when collision-safe publication changed its output path', async () => {
  const first = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await first.result.current.setVideoPath('/first.mp4');
    await first.result.current.setSubtitlePath('/first.srt');
  });
  act(() => first.result.current.setOutputPath('/result.mp4'));
  await act(async () => {
    await first.result.current.document.save();
  });
  const draft = readComposeDraft(composeDraftKey())!;
  first.unmount();
  writeComposeDraft(composeDraftKey(), {
    ...draft,
    job: { requestId: 'finished' },
  });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getQueue'
      ? Promise.resolve({
          success: true,
          data: [
            queuedJob('unrelated'),
            {
              ...queuedJob('finished'),
              status: 'done',
              outputPath: '/result_2.mp4',
            },
          ],
        })
      : original(channel, payload),
  );
  const second = renderHook(() => useSubtitleMerge());
  await waitFor(() => expect(second.result.current.status).toBe('completed'));
  expect(second.result.current.outputPath).toBe('/result_2.mp4');
  expect(second.result.current.document.getIsDirty()).toBe(false);
  expect(readComposeDraft(composeDraftKey())?.dirty).toBe(false);
  act(() => second.result.current.updateStyle({ fontSize: 52 }));
  expect(second.result.current.document.getIsDirty()).toBe(true);
  act(() => listeners.get('compose:queue')!([queuedJob('unrelated')]));
  expect(second.result.current.status).toBe('idle');
  expect(second.result.current.style.fontSize).toBe(52);
  expect(readComposeDraft(composeDraftKey())?.job).toBeNull();
});

it('offers ambiguous legacy jobs for explicit selection and ignores older read responses', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getQueue'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  act(() =>
    listeners.get('compose:queue')!([queuedJob('first'), queuedJob('second')]),
  );
  expect(result.current.status).toBe('idle');
  expect(result.current.reconnectJobs.map((job) => job.id)).toEqual([
    'first',
    'second',
  ]);
  await act(async () =>
    release({ success: true, data: [queuedJob('obsolete')] }),
  );
  expect(result.current.reconnectJobs.map((job) => job.id)).toEqual([
    'first',
    'second',
  ]);
  act(() => result.current.reconnectJob('second'));
  expect(result.current.progress.jobId).toBe('second');
  expect(result.current.reconnectJobs).toEqual([]);
  await act(async () => result.current.cancelMerge());
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:cancelMerge', {
    jobId: 'second',
  });
});

it('never automatically substitutes a different job when the persisted identity is missing', async () => {
  const first = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await first.result.current.setVideoPath('/first.mp4');
    await first.result.current.setSubtitlePath('/first.srt');
  });
  act(() => first.result.current.setOutputPath('/result.mp4'));
  await act(async () => {
    await first.result.current.document.save();
  });
  const draft = readComposeDraft(composeDraftKey())!;
  first.unmount();
  writeComposeDraft(composeDraftKey(), { ...draft, job: { jobId: 'expired' } });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getQueue'
      ? Promise.resolve({ success: true, data: [queuedJob('different')] })
      : original(channel, payload),
  );
  const second = renderHook(() => useSubtitleMerge());
  await waitFor(() =>
    expect(second.result.current.reconnectJobs).toHaveLength(1),
  );
  expect(second.result.current.status).toBe('idle');
  await act(async () => second.result.current.cancelMerge());
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel === 'subtitleMerge:cancelMerge',
    ),
  ).toBe(false);
  act(() => second.result.current.reconnectJob('different'));
  expect(second.result.current.progress.jobId).toBe('different');
});

it('recovers a lost start response from the queue without unlocking or duplicating the running export', async () => {
  const original = invoke.getMockImplementation()!;
  let requestId: string | undefined;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:startMerge') {
      requestId = payload.requestId;
      return Promise.reject(new Error('Response lost'));
    }
    if (channel === 'subtitleMerge:getQueue')
      return Promise.resolve({
        success: true,
        data: requestId
          ? [{ ...queuedJob('still-running', requestId), status: 'running' }]
          : [],
      });
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  await act(async () => result.current.startMerge());
  expect(result.current.status).toBe('processing');
  expect(result.current.progress.jobId).toBe('still-running');
  expect(result.current.canMerge).toBe(false);
  await act(async () => result.current.startMerge());
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'subtitleMerge:startMerge',
    ),
  ).toHaveLength(1);
  await act(async () => result.current.cancelMerge());
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:cancelMerge', {
    jobId: 'still-running',
  });
});

it('a reconnected job saves its exported snapshot when the queue reports completion', async () => {
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  act(() => listeners.get('compose:queue')!([queuedJob('reconnected')]));
  act(() => result.current.reconnectJob('reconnected'));
  expect(result.current.status).toBe('processing');
  expect(result.current.document.getIsDirty()).toBe(true);
  act(() =>
    listeners.get('compose:queue')!([
      {
        ...queuedJob('reconnected'),
        status: 'done',
        outputPath: '/result_2.mp4',
      },
    ]),
  );
  expect(result.current.status).toBe('completed');
  expect(result.current.outputPath).toBe('/result_2.mp4');
  expect(result.current.document.getIsDirty()).toBe(false);
  expect(readComposeDraft(composeDraftKey())?.saved.outputPath).toBe(
    '/result_2.mp4',
  );
});

it('successful video export retains the guard if saving its project fails', async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  let run!: Promise<void>;
  act(() => {
    run = result.current.startMerge();
  });
  const write = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Disk full');
    });
  await act(async () => {
    finish({ success: true, data: '/result.mp4' });
    await run;
  });
  expect(result.current.status).toBe('completed');
  expect(result.current.document.getIsDirty()).toBe(true);
  expect(result.current.document.error).toContain('Disk full');
  write.mockRestore();
  await act(async () =>
    expect(await result.current.document.save()).toBe(true),
  );
  expect(result.current.document.getIsDirty()).toBe(false);
});

it('does not enqueue an export when its recovery identity cannot be saved', async () => {
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Disk full');
  });
  await act(async () => result.current.startMerge());
  expect(result.current.document.error).toContain('Disk full');
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel === 'subtitleMerge:startMerge',
    ),
  ).toBe(false);
});

it('ignores old video metadata and derived output after a newer selection', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (result: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getVideoInfo' &&
    payload.videoPath === '/first.mp4'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.setVideoPath('/first.mp4');
  });
  await act(async () => result.current.setVideoPath('/second.mp4'));
  await act(async () => {
    release({ success: true, data: { path: '/first.mp4' } });
    await pending;
  });
  expect(result.current.videoInfo?.path).toBe('/second.mp4');
  expect(result.current.outputPath).toBe('/second_subtitled.mp4');
});

it('preserves incomplete style edits in the draft but blocks hard export until corrected; soft mux ignores styling', async () => {
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    result.current.setVideoPath('/first.mp4');
    result.current.setSubtitlePath('/first.srt');
  });
  await waitFor(() => expect(result.current.canMerge).toBe(true));
  act(() => result.current.updateStyle({ primaryColor: '#F', marginV: -1 }));
  expect(result.current.invalidStyleFields).toEqual([
    'primaryColor',
    'marginV',
  ]);
  expect(result.current.canMerge).toBe(false);
  await act(async () => result.current.startMerge());
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel === 'subtitleMerge:startMerge',
    ),
  ).toBe(false);
  expect(readComposeDraft(composeDraftKey())?.current.style.primaryColor).toBe(
    '#F',
  );
  await act(async () => result.current.setOutputMode('softmux'));
  expect(result.current.canMerge).toBe(true);
  expect(result.current.invalidStyleFields).toEqual([]);
  await act(async () => {
    result.current.setOutputMode('hardcode');
    result.current.updateStyle({ primaryColor: '#FFFFFF', marginV: 20 });
  });
  expect(result.current.canMerge).toBe(true);
});

it('does not restore metadata or output after files are cleared during a read', async () => {
  const original = invoke.getMockImplementation()!;
  let releaseVideo!: (result: unknown) => void;
  let releaseSubtitle!: (result: unknown) => void;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:getVideoInfo')
      return new Promise((resolve) => {
        releaseVideo = resolve;
      });
    if (channel === 'subtitleMerge:getSubtitleInfo')
      return new Promise((resolve) => {
        releaseSubtitle = resolve;
      });
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  let video!: Promise<void>, subtitle!: Promise<void>;
  act(() => {
    video = result.current.setVideoPath('/first.mp4');
    subtitle = result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.clearFiles());
  await act(async () => {
    releaseVideo({ success: true, data: { path: '/first.mp4' } });
    releaseSubtitle({ success: true, data: { path: '/first.srt' } });
    await Promise.all([video, subtitle]);
  });
  expect(result.current.videoInfo).toBeNull();
  expect(result.current.subtitleInfo).toBeNull();
  expect(result.current.outputPath).toBeNull();
});

it('keeps MKV as default, selects MP4 and restores the chosen soft container after dual audio', async () => {
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setVideoPath('/first.mp4'));
  await waitFor(() =>
    expect(result.current.outputPath).toBe('/first_subtitled.mp4'),
  );
  await act(async () => result.current.setOutputMode('softmux'));
  expect(result.current.outputPath).toBe('/first_subtitled.mkv');
  await act(async () => result.current.setSoftContainer('mp4'));
  expect(result.current.outputPath).toBe('/first_subtitled.mp4');
  act(() => result.current.setAudioTrackPath('/voice.wav'));
  act(() => result.current.setAudioTrackMode('addTrack'));
  expect(result.current.outputPath).toBe('/first_subtitled.mkv');
  act(() => result.current.clearAudioTrack());
  expect(result.current.outputPath).toBe('/first_subtitled.mp4');
  expect(invoke).toHaveBeenCalledWith(
    'subtitleMerge:setPreferences',
    expect.objectContaining({ softContainer: 'mp4' }),
  );
});

it('restores soft container preferences before asynchronous default path generation', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getPreferences'
      ? Promise.resolve({
          success: true,
          data: { outputMode: 'softmux', softContainer: 'mp4' },
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() =>
    useSubtitleMerge({ initialVideoPath: '/first.mp4' }),
  );
  await waitFor(() =>
    expect(result.current.outputPath).toBe('/first_subtitled.mp4'),
  );
  expect(result.current.outputMode).toBe('softmux');
  expect(result.current.softContainer).toBe('mp4');
});

it('preserves a hard export format chosen in the save dialog, and adds a missing soft extension', async () => {
  const original = invoke.getMockImplementation()!;
  let destination = '/custom.mkv';
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:selectOutputPath'
      ? Promise.resolve({ success: true, data: destination })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setVideoPath('/first.mp4'));
  await act(async () => result.current.selectOutputPath());
  expect(result.current.outputPath).toBe('/custom.mkv');
  await act(async () => result.current.setOutputMode('softmux'));
  await act(async () => result.current.setSoftContainer('mp4'));
  destination = '/custom';
  await act(async () => result.current.selectOutputPath());
  expect(result.current.outputPath).toBe('/custom.mp4');
});

it('does not overwrite a manual output path with a late generated default', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:generateOutputPath'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setVideoPath('/first.mp4'));
  await waitFor(() => expect(release).toBeDefined());
  act(() => result.current.setOutputPath('/manual.mp4'));
  await act(async () => release({ success: true, data: '/automatic.mp4' }));
  expect(result.current.outputPath).toBe('/manual.mp4');
});

it('rejects late preferences after user edits and undo/redo applies container changes atomically', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getPreferences'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setVideoPath('/first.mp4'));
  await waitFor(() =>
    expect(result.current.outputPath).toBe('/first_subtitled.mp4'),
  );
  await act(async () => result.current.setOutputMode('softmux'));
  await act(async () =>
    release({
      success: true,
      data: { outputMode: 'hardcode', videoQuality: 'standard' },
    }),
  );
  expect(result.current.outputMode).toBe('softmux');
  expect(result.current.videoQuality).toBe('original');
  await act(async () => result.current.document.undo());
  expect(result.current.outputMode).toBe('hardcode');
  expect(result.current.outputPath).toBe('/first_subtitled.mp4');
  await act(async () => result.current.document.redo());
  expect(result.current.outputPath).toBe('/first_subtitled.mkv');
});

it('invalidates in-flight metadata on undo and restores saved state without default-path replacement', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getVideoInfo' &&
    payload.videoPath === '/late.mp4'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const first = renderHook(() => useSubtitleMerge());
  await act(async () => first.result.current.setVideoPath('/first.mp4'));
  act(() => first.result.current.setOutputPath('/manual.mp4'));
  await act(async () => {
    await first.result.current.document.save();
  });
  await act(async () => first.result.current.setVideoPath('/late.mp4'));
  await act(async () => first.result.current.document.undo());
  await act(async () =>
    release({ success: true, data: { path: '/late.mp4' } }),
  );
  expect(first.result.current.videoPath).toBe('/first.mp4');
  expect(first.result.current.outputPath).toBe('/manual.mp4');
  first.unmount();
  const second = renderHook(() => useSubtitleMerge());
  await waitFor(() =>
    expect(second.result.current.videoInfo?.path).toBe('/first.mp4'),
  );
  expect(second.result.current.outputPath).toBe('/manual.mp4');
  expect(second.result.current.document.recovery).toBeNull();
  expect(readComposeDraft(composeDraftKey())?.dirty).toBe(false);
});

it('rejects duplicate submission and malformed successful responses', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  let run!: Promise<void>;
  act(() => {
    run = result.current.startMerge();
    void result.current.startMerge();
    result.current.setOutputPath('/wrong.mp4');
  });
  expect(
    invoke.mock.calls.filter((call) => call[0] === 'subtitleMerge:startMerge'),
  ).toHaveLength(1);
  expect(result.current.outputPath).toBe('/result.mp4');
  await act(async () => {
    release({ success: true });
    await run;
  });
  expect(result.current.status).toBe('error');
  expect(result.current.progress.errorMessage).toContain('output path');
  expect(result.current.document.getIsDirty()).toBe(true);
});

it('binds progress and cancellation to the acknowledged job, ignoring unrelated and stale events', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  let run!: Promise<void>;
  act(() => {
    run = result.current.startMerge();
  });
  const config = invoke.mock.calls.find(
    (call) => call[0] === 'subtitleMerge:startMerge',
  )![1];
  act(() => {
    listeners.get('subtitleMerge:queued')!({
      requestId: 'wrong',
      jobId: 'wrong',
    });
    listeners.get('subtitleMerge:progress')!({
      jobId: 'wrong',
      source: 'subtitleMerge',
      status: 'processing',
      percent: 90,
    });
  });
  expect(result.current.progress.percent).toBe(0);
  act(() => {
    listeners.get('subtitleMerge:queued')!({
      requestId: config.requestId,
      jobId: 'ours',
    });
    listeners.get('subtitleMerge:progress')!({
      jobId: 'ours',
      source: 'subtitleMerge',
      status: 'processing',
      percent: 23,
    });
    listeners.get('subtitleMerge:progress')!({
      jobId: 'wrong',
      source: 'subtitleMerge',
      status: 'completed',
      percent: 100,
    });
  });
  expect(result.current.progress.percent).toBe(23);
  await act(async () => result.current.cancelMerge());
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:cancelMerge', {
    jobId: 'ours',
  });
  await act(async () => {
    release({ success: true, cancelled: true });
    await run;
  });
  expect(result.current.status).toBe('idle');
  expect(result.current.isCancelling).toBe(false);
  act(() =>
    listeners.get('subtitleMerge:progress')!({
      jobId: 'ours',
      source: 'subtitleMerge',
      status: 'completed',
      percent: 100,
    }),
  );
  expect(result.current.status).toBe('idle');
});

it('reconnects an active job with its actual style/quality and keeps terminal progress scoped', async () => {
  const original = invoke.getMockImplementation()!;
  const style = { ...getDefaultStyle(), positionY: 35, fontSize: 48 };
  const job = {
    id: 'resume',
    source: 'subtitleMerge',
    status: 'running',
    videoPath: '/first.mp4',
    subtitlePath: '/first.srt',
    outputPath: '/resume.mp4',
    subtitleMode: 'hard',
    style,
    videoQuality: 'high',
    encoderMode: 'cpu',
  };
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:getQueue'
      ? Promise.resolve({ success: true, data: [job] })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await waitFor(() => expect(result.current.status).toBe('processing'));
  expect(result.current.style).toEqual(style);
  expect(result.current.videoQuality).toBe('high');
  expect(result.current.outputPath).toBe('/resume.mp4');
  act(() =>
    listeners.get('compose:queue')!([
      { ...job, status: 'error', error: 'FFmpeg failed' },
    ]),
  );
  expect(result.current.status).toBe('error');
  expect(result.current.progress.errorMessage).toBe('FFmpeg failed');
  expect(result.current.canMerge).toBe(true);
});

it('does not report completion to an unmounted owner', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const onComplete = jest.fn();
  const { result, unmount } = renderHook(() =>
    useSubtitleMerge({ onComplete }),
  );
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  let run!: Promise<void>;
  act(() => {
    run = result.current.startMerge();
  });
  unmount();
  await act(async () => {
    release({ success: true, data: '/result.mp4' });
    await run;
  });
  expect(onComplete).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

it('uses the actual published collision path for the success UI and folder action', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:startMerge'
      ? Promise.resolve({ success: true, data: '/result_2.mp4' })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  act(() => result.current.setOutputPath('/result.mp4'));
  await act(async () => result.current.startMerge());
  expect(result.current.outputPath).toBe('/result_2.mp4');
  expect(result.current.document.getIsDirty()).toBe(false);
  expect(readComposeDraft(composeDraftKey())?.dirty).toBe(false);
  expect(readComposeDraft(composeDraftKey())?.saved.outputPath).toBe(
    '/result_2.mp4',
  );
  await act(async () => result.current.openOutputFolder());
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:openOutputFolder', {
    filePath: '/result_2.mp4',
  });
  act(() => result.current.updateStyle({ fontSize: 60 }));
  expect(result.current.document.getIsDirty()).toBe(true);
});

it.each(['cancelled', 'failed'])(
  '%s export keeps the unsaved project guarded',
  async (outcome) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'subtitleMerge:startMerge'
        ? Promise.resolve(
            outcome === 'cancelled'
              ? { success: true, cancelled: true }
              : { success: false, error: 'Export failed' },
          )
        : original(channel, payload),
    );
    const { result } = renderHook(() => useSubtitleMerge());
    await act(async () => {
      await result.current.setVideoPath('/first.mp4');
      await result.current.setSubtitlePath('/first.srt');
    });
    act(() => result.current.setOutputPath('/result.mp4'));
    await act(async () => result.current.startMerge());
    expect(result.current.document.getIsDirty()).toBe(true);
    expect(readComposeDraft(composeDraftKey())?.dirty).toBe(true);
  },
);

it('retries failed folder actions and dialogs without unrelated preference writes; repeated retry is single-flight', async () => {
  const original = invoke.getMockImplementation()!;
  let failFolder = true;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:openOutputFolder') {
      if (failFolder)
        return Promise.resolve({ success: false, error: 'Folder unavailable' });
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    if (channel === 'subtitleMerge:selectOutputPath')
      return Promise.resolve({ success: false, error: 'Dialog unavailable' });
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setOutputPath('/result.mp4'));
  await act(async () => result.current.openOutputFolder());
  expect(result.current.operationError).toContain('Folder unavailable');
  failFolder = false;
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.retryErrors();
    void result.current.retryErrors();
  });
  expect(result.current.isRetrying).toBe(true);
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'subtitleMerge:openOutputFolder',
    ),
  ).toHaveLength(2);
  await act(async () => {
    release({ success: true, data: true });
    await pending;
  });
  expect(result.current.operationError).toBe('');
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel === 'subtitleMerge:setPreferences',
    ),
  ).toBe(false);
  await act(async () => result.current.selectOutputPath());
  expect(result.current.operationError).toContain('Dialog unavailable');
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:selectOutputPath'
      ? Promise.resolve({ success: true, cancelled: true })
      : original(channel, payload),
  );
  await act(async () => result.current.retryErrors());
  expect(result.current.operationError).toBe('');
  expect(result.current.outputPath).toBe('/result.mp4');
});

it('drops obsolete selection retries and ignores a late selection after a manual change', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'selectFile'
      ? Promise.reject(new Error('Selection failed'))
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.selectVideo());
  expect(result.current.operationError).toContain('Selection failed');
  await act(async () => result.current.setVideoPath('/first.mp4'));
  await act(async () => result.current.retryErrors());
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'selectFile'),
  ).toHaveLength(1);
  expect(result.current.operationError).toBe('');
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'selectFile'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.selectVideo();
    void result.current.selectVideo();
  });
  await act(async () => result.current.setVideoPath('/newer.mp4'));
  await act(async () => {
    release({ filePath: '/late.mp4' });
    await pending;
  });
  expect(result.current.videoPath).toBe('/newer.mp4');
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'selectFile'),
  ).toHaveLength(2);
});

it('retains failed preset writes across successful reads and retries the original id and style after edits', async () => {
  const original = invoke.getMockImplementation()!;
  let releaseRead!: (value: unknown) => void;
  let failSave = true;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:listStylePresets')
      return new Promise((resolve) => {
        releaseRead = resolve;
      });
    if (channel === 'subtitleMerge:saveStylePreset')
      return Promise.resolve(
        failSave
          ? { success: false, error: 'Preset disk full' }
          : { success: true, data: { ...payload, createdAt: 1, updatedAt: 2 } },
      );
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.saveStylePreset('Original'));
  const payload = invoke.mock.calls.find(
    ([channel]) => channel === 'subtitleMerge:saveStylePreset',
  )![1];
  await act(async () => releaseRead({ success: true, data: [] }));
  expect(result.current.operationError).toContain('Preset disk full');
  act(() => result.current.updateStyle({ fontSize: 55 }));
  failSave = false;
  await act(async () => result.current.retryErrors());
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'subtitleMerge:saveStylePreset')
      .map(([, data]) => data),
  ).toEqual([payload, payload]);
  expect(result.current.userPresets[0].style.fontSize).toBe(
    payload.style.fontSize,
  );
  expect(result.current.style.fontSize).toBe(55);
  expect(result.current.activePresetId).toBeNull();
  expect(result.current.operationError).toBe('');
});

it('uses stable preset ids on save retry, blocks duplicate writes, and rejects malformed success', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:saveStylePreset'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  let save!: Promise<unknown>;
  act(() => {
    save = result.current.saveStylePreset('Same');
    void result.current.saveStylePreset('Same');
  });
  const calls = () =>
    invoke.mock.calls.filter(
      ([channel]) => channel === 'subtitleMerge:saveStylePreset',
    );
  expect(calls()).toHaveLength(1);
  const payload = calls()[0][1];
  await act(async () => {
    release({ success: true, data: { ...payload, id: 'wrong' } });
    await save;
  });
  expect(result.current.operationError).toContain('Invalid saved style');
  act(() => {
    save = result.current.saveStylePreset('Same');
  });
  expect(calls()[1][1]).toEqual(payload);
  await act(async () => {
    release({
      success: true,
      data: { ...payload, createdAt: 1, updatedAt: 1 },
    });
    await save;
  });
  expect(result.current.operationError).toBe('');
  expect(result.current.userPresets).toHaveLength(1);
});

it('serializes preference writes and only the latest response controls the error; retry saves current settings', async () => {
  const original = invoke.getMockImplementation()!;
  const releases: ((value: unknown) => void)[] = [];
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:setPreferences'
      ? new Promise((resolve) => releases.push(resolve))
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.setOutputMode('softmux'));
  await act(async () => result.current.setSoftContainer('mp4'));
  expect(releases).toHaveLength(1);
  await act(async () => releases[0]({ success: false, error: 'Old failure' }));
  expect(releases).toHaveLength(2);
  expect(result.current.operationError).not.toContain('Old failure');
  await act(async () => releases[1]({ success: true, data: false }));
  expect(result.current.operationError).toContain('Preferences were not saved');
  let retry!: Promise<void>;
  act(() => {
    retry = result.current.retryErrors();
  });
  await waitFor(() => expect(releases).toHaveLength(3));
  await act(async () => {
    releases[2]({ success: true, data: true });
    await retry;
  });
  const writes = invoke.mock.calls.filter(
    ([channel]) => channel === 'subtitleMerge:setPreferences',
  );
  expect(writes[2][1]).toEqual(
    expect.objectContaining({ outputMode: 'softmux', softContainer: 'mp4' }),
  );
  expect(result.current.operationError).toBe('');
});

it('merges a stale preset list with completed saves and retries deletion of the exact preset', async () => {
  const original = invoke.getMockImplementation()!;
  let releaseRead!: (value: unknown) => void;
  let failDelete = true;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:listStylePresets')
      return new Promise((resolve) => {
        releaseRead = resolve;
      });
    if (channel === 'subtitleMerge:saveStylePreset')
      return Promise.resolve({
        success: true,
        data: { ...payload, createdAt: 1, updatedAt: 1 },
      });
    if (channel === 'subtitleMerge:deleteStylePreset')
      return Promise.resolve(
        failDelete
          ? { success: true, data: false }
          : { success: true, data: true },
      );
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.saveStylePreset('Persisted'));
  const id = result.current.userPresets[0].id;
  const existing = {
    id: 'existing',
    name: 'Existing',
    style: getDefaultStyle(),
  };
  await act(async () => releaseRead({ success: true, data: [existing] }));
  expect(result.current.userPresets.map((preset) => preset.id)).toEqual([
    'existing',
    id,
  ]);
  await act(async () => result.current.deleteStylePreset(id));
  expect(result.current.operationError).toContain('Preset was not deleted');
  expect(result.current.userPresets).toHaveLength(2);
  failDelete = false;
  await act(async () => result.current.retryErrors());
  expect(result.current.userPresets).toEqual([existing]);
  expect(result.current.operationError).toBe('');
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'subtitleMerge:deleteStylePreset')
      .map(([, payload]) => payload),
  ).toEqual([id, id]);
});

it('does not resurrect a preset deleted while the initial list is in flight', async () => {
  const original = invoke.getMockImplementation()!;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:listStylePresets'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(channel, payload),
  );
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => result.current.deleteStylePreset('deleted'));
  await act(async () =>
    release({
      success: true,
      data: [
        { id: 'deleted', name: 'Deleted', style: getDefaultStyle() },
        { id: 'other', name: 'Other', style: getDefaultStyle() },
      ],
    }),
  );
  expect(result.current.userPresets.map((preset) => preset.id)).toEqual([
    'other',
  ]);
});

it('keeps read retries busy until IPC settles, retains errors, and does not refresh unrelated reads', async () => {
  const original = invoke.getMockImplementation()!;
  let failed = true;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:getVideoInfo') {
      if (failed)
        return Promise.resolve({ success: false, error: 'Video unavailable' });
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return original(channel, payload);
  });
  const { result } = renderHook(() =>
    useSubtitleMerge({ initialVideoPath: '/first.mp4' }),
  );
  await waitFor(() =>
    expect(result.current.operationError).toContain('Video unavailable'),
  );
  const initialCalls = invoke.mock.calls.length;
  failed = false;
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.retryErrors();
    void result.current.retryErrors();
  });
  expect(result.current.isRetrying).toBe(true);
  expect(result.current.operationError).toContain('Video unavailable');
  expect(
    invoke.mock.calls.slice(initialCalls).map(([channel]) => channel),
  ).toEqual(['subtitleMerge:getVideoInfo']);
  await act(async () => {
    release({
      success: true,
      data: { path: '/first.mp4', width: 360, height: 640 },
    });
    await pending;
  });
  expect(result.current.isRetrying).toBe(false);
  expect(result.current.operationError).toBe('');
});

it('does not publish late metadata or errors after switching selection during a retry', async () => {
  const original = invoke.getMockImplementation()!;
  let failed = true;
  let release!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) => {
    if (
      channel === 'subtitleMerge:getVideoInfo' &&
      payload.videoPath === '/first.mp4'
    ) {
      if (failed)
        return Promise.resolve({
          success: false,
          error: 'Old video unavailable',
        });
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return original(channel, payload);
  });
  const { result } = renderHook(() =>
    useSubtitleMerge({ initialVideoPath: '/first.mp4' }),
  );
  await waitFor(() =>
    expect(result.current.operationError).toContain('Old video unavailable'),
  );
  failed = false;
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.retryErrors();
  });
  await act(async () => result.current.setVideoPath('/second.mp4'));
  await act(async () => {
    release({ success: false, error: 'Late failure' });
    await pending;
  });
  expect(result.current.videoInfo?.path).toBe('/second.mp4');
  expect(result.current.operationError).toBe('');
  expect(result.current.isRetrying).toBe(false);
});

it('retries cancellation of the acknowledged job only, blocks duplicate cancellation and clears obsolete failures', async () => {
  const original = invoke.getMockImplementation()!;
  let end!: (value: unknown) => void;
  let cancelled!: (value: unknown) => void;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'subtitleMerge:startMerge')
      return new Promise((resolve) => {
        end = resolve;
      });
    if (channel === 'subtitleMerge:cancelMerge')
      return new Promise((resolve) => {
        cancelled = resolve;
      });
    return original(channel, payload);
  });
  const { result } = renderHook(() => useSubtitleMerge());
  await act(async () => {
    await result.current.setVideoPath('/first.mp4');
    await result.current.setSubtitlePath('/first.srt');
  });
  let run!: Promise<void>;
  act(() => {
    run = result.current.startMerge();
  });
  const request = invoke.mock.calls.find(
    ([channel]) => channel === 'subtitleMerge:startMerge',
  )![1];
  act(() =>
    listeners.get('subtitleMerge:queued')!({
      requestId: request.requestId,
      jobId: 'owned',
    }),
  );
  let cancel!: Promise<void>;
  act(() => {
    cancel = result.current.cancelMerge();
    void result.current.cancelMerge();
  });
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'subtitleMerge:cancelMerge',
    ),
  ).toHaveLength(1);
  await act(async () => {
    cancelled({ success: false, error: 'Cancel unavailable' });
    await cancel;
  });
  expect(result.current.operationError).toContain('Cancel unavailable');
  act(() => {
    cancel = result.current.retryErrors();
  });
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'subtitleMerge:cancelMerge')
      .map(([, payload]) => payload),
  ).toEqual([{ jobId: 'owned' }, { jobId: 'owned' }]);
  await act(async () => {
    end({ success: true, cancelled: true });
    await run;
    cancelled({ success: false, error: 'Late failure' });
    await cancel;
  });
  expect(result.current.status).toBe('idle');
  expect(result.current.operationError).toBe('');
  expect(result.current.isCancelling).toBe(false);
  await act(async () => result.current.retryErrors());
  expect(
    invoke.mock.calls.filter(
      ([channel]) => channel === 'subtitleMerge:cancelMerge',
    ),
  ).toHaveLength(2);
});
