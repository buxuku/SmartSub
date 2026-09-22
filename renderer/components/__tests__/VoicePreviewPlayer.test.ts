import { VoicePreviewPlayer } from '../../lib/voicePreviewPlayer';

let contexts: any[];
beforeEach(() => {
  jest.useFakeTimers();
  contexts = [];
  global.AudioContext = jest.fn().mockImplementation(() => {
    const context = {
      currentTime: 0,
      destination: {},
      sources: [] as any[],
      resume: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      createBuffer: jest.fn((_channels, count, rate) => ({
        duration: count / rate,
        getChannelData: () => new Float32Array(count),
      })),
      createBufferSource: () => {
        const source = {
          start: jest.fn(),
          stop: jest.fn(),
          connect: jest.fn(),
          disconnect: jest.fn(),
          onended: null as (() => void) | null,
        };
        context.sources.push(source);
        return source;
      },
    };
    contexts.push(context);
    return context;
  });
});
afterEach(() => {
  jest.useRealTimers();
  delete (global as any).AudioContext;
});

it('queues at most three seconds and stops stalled streams on the playback deadline', async () => {
  const playing = jest.fn(),
    failed = jest.fn();
  const player = new VoicePreviewPlayer(playing, failed);
  player.append(new Uint8Array(48000), 24000);
  player.append(new Uint8Array(48000 * 4), 24000);
  player.append(new Uint8Array(48000), 24000);
  await Promise.resolve();
  expect(contexts[0].sources).toHaveLength(2);
  expect(contexts[0].sources[0].start).toHaveBeenCalledWith(0.02);
  expect(contexts[0].sources[1].start).toHaveBeenCalledWith(1.02);
  expect(playing).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(3000);
  await player.completed;
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
  for (const source of contexts[0].sources)
    expect(source.stop).toHaveBeenCalled();
  player.stop();
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

it('finishes only after queued audio ends, and cancellation releases sources immediately', async () => {
  const player = new VoicePreviewPlayer(jest.fn(), jest.fn());
  player.append(new Uint8Array(24000), 24000);
  const finished = jest.fn();
  const completion = player.finish().then(finished);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  contexts[0].sources[0].onended();
  await completion;
  expect(finished).toHaveBeenCalledTimes(1);
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
  const cancelled = new VoicePreviewPlayer(jest.fn(), jest.fn());
  cancelled.append(new Uint8Array(24000), 24000);
  cancelled.stop();
  cancelled.append(new Uint8Array(24000), 24000);
  expect(contexts[1].sources).toHaveLength(1);
  expect(contexts[1].sources[0].stop).toHaveBeenCalledTimes(1);
});

it('rejects invalid chunks before scheduling and surfaces audio-device failure', async () => {
  const error = jest.fn();
  const player = new VoicePreviewPlayer(jest.fn(), error);
  expect(() => player.append(new Uint8Array(3), 24000)).toThrow(/Invalid/);
  expect(() => player.append(new Uint8Array(4), 48000)).toThrow(/Invalid/);
  contexts[0].resume.mockRejectedValue(new Error('device unavailable'));
  player.append(new Uint8Array(24000), 24000);
  await Promise.resolve();
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'device unavailable' }),
  );
  player.stop();
});
