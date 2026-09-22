import { act, renderHook } from '@testing-library/react';
import { useVoicePreview } from '../../hooks/useVoicePreview';
import type { DubbingConfig } from '../../../types/dubbing';

const config: DubbingConfig = {
  engine: { kind: 'cloud', providerId: 'test' },
  voice: 'a',
  globalSpeed: 1,
  background: 'mute',
  output: 'audioOnly',
};
let invoke: jest.Mock;
let audios: any[];
beforeEach(() => {
  jest.useFakeTimers();
  audios = [];
  global.Audio = jest.fn().mockImplementation((src) => {
    const audio: any = {
      src,
      pause: jest.fn(),
      play: jest.fn(async () => audio.onplaying?.()),
    };
    audios.push(audio);
    return audio;
  });
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => `preview-${Math.random()}`,
  });
  invoke = jest.fn(async (channel) => ({
    success: true,
    data: channel === 'dubbing:previewVoice' ? '/sample.wav' : true,
  }));
  window.ipc = { invoke } as any;
});
afterEach(() => {
  jest.useRealTimers();
  delete (global as any).AudioContext;
});
function setup() {
  return { config, session: null, stopPlayback: jest.fn(), onError: jest.fn() };
}

it('caps playback at three seconds and sends a request-scoped cancellation', async () => {
  const options = setup();
  const hook = renderHook(() => useVoicePreview(options));
  let result!: Promise<boolean>;
  await act(async () => {
    result = hook.result.current.previewVoice('a');
  });
  expect(hook.result.current.previewing).toBe(true);
  expect(hook.result.current.previewLoading).toBe(false);
  await act(async () => {
    jest.advanceTimersByTime(3000);
    expect(await result).toBe(true);
  });
  expect(audios[0].pause).toHaveBeenCalled();
  expect(hook.result.current.previewing).toBe(false);
  const id = invoke.mock.calls.find(
    ([channel]) => channel === 'dubbing:previewVoice',
  )![1].requestId;
  expect(invoke).toHaveBeenCalledWith('dubbing:cancelPreview', {
    requestId: id,
  });
});

it('does not play late audio after hover changes, cancellation, or unmount', async () => {
  const replies: Array<(value: any) => void> = [];
  invoke.mockImplementation((channel) =>
    channel === 'dubbing:previewVoice'
      ? new Promise((resolve) => replies.push(resolve))
      : Promise.resolve({ success: true }),
  );
  const hook = renderHook(() => useVoicePreview(setup()));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => {
    first = hook.result.current.previewVoice('a');
    second = hook.result.current.previewVoice('b');
  });
  await act(async () => {
    replies[0]({ success: true, data: '/old.wav' });
    expect(await first).toBe(false);
  });
  expect(audios).toHaveLength(0);
  hook.unmount();
  await act(async () => {
    replies[1]({ success: true, data: '/new.wav' });
    expect(await second).toBe(false);
  });
  expect(audios).toHaveLength(0);
});

it('changing engine cancels playback and failure remains visible', async () => {
  const options = setup();
  const hook = renderHook((value) => useVoicePreview(value), {
    initialProps: options,
  });
  let playing!: Promise<boolean>;
  await act(async () => {
    playing = hook.result.current.previewVoice();
  });
  hook.rerender({
    ...options,
    config: { ...config, engine: { kind: 'cloud', providerId: 'other' } },
  });
  expect(await playing).toBe(false);
  expect(audios[0].pause).toHaveBeenCalled();
  invoke.mockResolvedValue({ success: false, error: 'provider unavailable' });
  await act(async () => {
    expect(await hook.result.current.previewVoice()).toBe(false);
  });
  expect(options.onError).toHaveBeenLastCalledWith('provider unavailable');
});

function streaming() {
  const listeners = new Set<(value: any) => void>();
  window.ipc.on = jest.fn((_channel, callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  });
  const close = jest.fn().mockResolvedValue(undefined);
  const sources: any[] = [];
  global.AudioContext = jest.fn().mockImplementation(() => ({
    currentTime: 0,
    destination: {},
    close,
    resume: jest.fn().mockResolvedValue(undefined),
    createBuffer: (_channels: number, count: number, rate: number) => ({
      duration: count / rate,
      getChannelData: () => new Float32Array(count),
    }),
    createBufferSource: () => {
      const source = {
        connect: jest.fn(),
        disconnect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };
      sources.push(source);
      return source;
    },
  }));
  return {
    listeners,
    close,
    sources,
    emit: (requestId: string) =>
      listeners.forEach((callback) =>
        callback({ requestId, sampleRate: 24000, pcm: new Uint8Array(48000) }),
      ),
  };
}

it('stops and cancels at the stream playback deadline even if the provider never finishes', async () => {
  const stream = streaming();
  let reply!: (value: any) => void;
  invoke.mockImplementation((channel) =>
    channel === 'dubbing:previewVoice'
      ? new Promise((resolve) => {
          reply = resolve;
        })
      : Promise.resolve({ success: true }),
  );
  const options = setup();
  const hook = renderHook(() => useVoicePreview(options));
  let playback!: Promise<boolean>;
  act(() => {
    playback = hook.result.current.previewVoice('a');
  });
  const id = invoke.mock.calls.find(
    ([channel]) => channel === 'dubbing:previewVoice',
  )![1].requestId;
  await act(async () => stream.emit(id));
  expect(hook.result.current.previewLoading).toBe(false);
  await act(async () => {
    jest.advanceTimersByTime(3000);
    expect(await playback).toBe(true);
  });
  expect(stream.close).toHaveBeenCalledTimes(1);
  expect(stream.listeners.size).toBe(0);
  expect(invoke).toHaveBeenCalledWith('dubbing:cancelPreview', {
    requestId: id,
  });
  await act(async () => reply({ success: true, data: '/late.wav' }));
  expect(audios).toHaveLength(0);
  expect(hook.result.current.previewing).toBe(false);
});

it('drops old request chunks without cancelling a newer audition', async () => {
  const stream = streaming();
  const replies: Array<(value: any) => void> = [];
  invoke.mockImplementation((channel) =>
    channel === 'dubbing:previewVoice'
      ? new Promise((resolve) => replies.push(resolve))
      : Promise.resolve({ success: true }),
  );
  const hook = renderHook(() => useVoicePreview(setup()));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => {
    first = hook.result.current.previewVoice('a');
  });
  const oldId = invoke.mock.calls.find(
    ([channel]) => channel === 'dubbing:previewVoice',
  )![1].requestId;
  act(() => {
    second = hook.result.current.previewVoice('b');
  });
  const newId = invoke.mock.calls.filter(
    ([channel]) => channel === 'dubbing:previewVoice',
  )[1][1].requestId;
  await act(async () => {
    expect(await first).toBe(false);
    stream.emit(oldId);
  });
  expect(stream.sources).toHaveLength(0);
  await act(async () => stream.emit(newId));
  expect(stream.sources).toHaveLength(1);
  expect(hook.result.current.previewVoiceId).toBe('b');
  hook.unmount();
  expect(await second).toBe(false);
  expect(stream.listeners.size).toBe(0);
  expect(stream.sources[0].stop).toHaveBeenCalled();
  await act(async () =>
    replies.forEach((reply) => reply({ success: true, data: '/late.wav' })),
  );
  expect(audios).toHaveLength(0);
});
