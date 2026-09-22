import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import useTaskDependencies from '../useTaskDependencies';

const responses: Record<string, unknown> = {
  getSystemInfo: {
    modelsInstalled: ['base'],
    modelsPath: '/models',
    downloadingModels: [],
  },
  getTranslationProviders: [
    { id: 'translation', type: 'openai', name: 'Translator' },
  ],
  getAsrProviders: [{ id: 'asr', type: 'openai', name: 'Transcriber' }],
  getSettings: { useLocalWhisper: true },
};
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel) => structuredClone(responses[channel]));
  window.ipc = { invoke } as any;
});

test.each(Object.keys(responses))(
  '%s failure keeps dependencies unavailable and retry publishes the complete snapshot',
  async (failed) => {
    invoke.mockImplementation(async (channel) => {
      if (channel === failed) throw new Error('EACCES');
      return responses[channel];
    });
    const { result } = renderHook(() => useTaskDependencies());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBe('EACCES');
    expect(result.current.providers).toEqual([]);
    expect(result.current.systemInfo.modelsInstalled).toEqual([]);
    invoke.mockImplementation(async (channel) => responses[channel]);
    await act(async () => result.current.load());
    expect(result.current.loaded).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.systemInfo.modelsInstalled).toEqual(['base']);
    expect(result.current.settings.useLocalWhisper).toBe(true);
  },
);

test.each(Object.keys(responses))(
  '%s malformed response is not accepted as an empty dependency list',
  async (failed) => {
    invoke.mockImplementation(async (channel) =>
      channel === failed ? null : responses[channel],
    );
    const { result } = renderHook(() => useTaskDependencies());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toMatch(/INVALID_/);
  },
);

test('late first read cannot replace a successful retry', async () => {
  let fail!: (error: Error) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const { result } = renderHook(() => useTaskDependencies());
  await act(async () => result.current.load());
  await act(async () => fail(new Error('old failure')));
  expect(result.current.loaded).toBe(true);
  expect(result.current.error).toBeNull();
});

test('StrictMode discards the abandoned request and loads the active instance', async () => {
  const { result } = renderHook(() => useTaskDependencies(), {
    wrapper: StrictMode,
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.providers[0].id).toBe('translation');
});
