import { act, renderHook } from '@testing-library/react';
import { useParameterConfig } from '../useParameterConfig';
import type { CustomParameterConfig } from '../../../types/provider';

const initial: CustomParameterConfig = {
  headerParameters: {},
  bodyParameters: { temperature: 0.7 },
  configVersion: '1.0.0',
  lastModified: 1,
};
const invoke = jest.fn();
beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(window, { ipc: { invoke } });
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'config-manager:get') return structuredClone(initial);
    if (
      channel === 'config-manager:save' ||
      channel === 'config-manager:delete'
    )
      return { success: true };
    if (channel === 'config-manager:validate') return { errors: [] };
    return [];
  });
});
afterEach(() => {
  jest.useRealTimers();
});

it('loads actual IPC configuration and supports typed CRUD/export/import', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  expect(result.current.state.config).toEqual(initial);
  act(() => {
    result.current.addHeaderParameter('X-Test', 'one');
    result.current.updateHeaderParameter('X-Test', 'two');
    result.current.addBodyParameter('max_tokens', 50);
    result.current.updateBodyParameter('temperature', 0.2);
  });
  expect(result.current.state.hasUnsavedChanges).toBe(true);
  expect(
    JSON.parse(result.current.exportConfiguration()!).configuration
      .bodyParameters,
  ).toEqual({ temperature: 0.2, max_tokens: 50 });
  act(() => {
    result.current.removeHeaderParameter('X-Test');
    result.current.removeBodyParameter('max_tokens');
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(invoke).toHaveBeenCalledWith(
    'config-manager:save',
    'a',
    expect.objectContaining({
      headerParameters: {},
      bodyParameters: { temperature: 0.2 },
    }),
  );
  expect(result.current.state.hasUnsavedChanges).toBe(false);
  act(() => {
    expect(result.current.importConfiguration('{bad')).toBe(false);
  });
  act(() => {
    expect(
      result.current.importConfiguration(
        JSON.stringify({ configuration: initial }),
      ),
    ).toBe(true);
  });
  await act(async () => {
    expect(await result.current.validateConfiguration('a')).toEqual([]);
  });
});

it.each([undefined, {}, { success: false }, { success: 'yes' }])(
  'retains edits and a persistent error for malformed/failed saves %j',
  async (reply) => {
    const { result } = renderHook(useParameterConfig);
    await act(async () => {
      await result.current.loadConfig('a');
    });
    act(() => {
      result.current.addBodyParameter('temperature', 0.1);
    });
    invoke.mockResolvedValue(reply);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.state.hasUnsavedChanges).toBe(true);
    expect(result.current.state.saveStatus).toBe('error');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.state.saveStatus).toBe('error');
    invoke.mockResolvedValue({ success: true });
    await act(async () => {
      expect(
        await result.current.saveConfig('a', result.current.state.config!),
      ).toBe(true);
    });
    expect(result.current.state.hasUnsavedChanges).toBe(false);
  },
);

it('does not clear newer edits or reorder overlapping manual and automatic saves', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  let finish: (value: any) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    result.current.updateBodyParameter('temperature', 0.1);
  });
  let pending: Promise<boolean>;
  act(() => {
    pending = result.current.saveConfig('a', result.current.state.config!);
  });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    result.current.updateBodyParameter('temperature', 0.2);
  });
  await act(async () => {
    finish!({ success: true });
    await pending!;
  });
  expect(result.current.state.config!.bodyParameters.temperature).toBe(0.2);
  expect(result.current.state.hasUnsavedChanges).toBe(true);
  invoke.mockResolvedValue({ success: true });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(result.current.state.hasUnsavedChanges).toBe(false);
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'config-manager:save')
      .map(([, , config]) => config.bodyParameters.temperature),
  ).toEqual([0.1, 0.2]);
});

it('ignores a stale provider load and does not overwrite the latest provider', async () => {
  const { result } = renderHook(useParameterConfig);
  let resolveA: (config: CustomParameterConfig) => void;
  invoke.mockImplementation(async (_channel: string, id: string) =>
    id === 'a'
      ? new Promise((resolve) => {
          resolveA = resolve;
        })
      : { ...initial, bodyParameters: { provider: id } },
  );
  let loadA: Promise<void>;
  act(() => {
    loadA = result.current.loadConfig('a');
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await result.current.loadConfig('b');
  });
  await act(async () => {
    resolveA!(initial);
    await loadA!;
  });
  expect(result.current.state.config!.bodyParameters).toEqual({
    provider: 'b',
  });
});

it('disabling auto-save really disables debounce and enabling it uses latest edits', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  act(() => {
    result.current.disableAutoSave();
    result.current.addBodyParameter('temperature', 0.3);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'config-manager:save'),
  ).toHaveLength(0);
  act(() => {
    result.current.enableAutoSave('a', 500);
    result.current.addBodyParameter('temperature', 0.4);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(result.current.state.hasUnsavedChanges).toBe(false);
});

it('cannot redirect a pending edit to a different provider through enableAutoSave', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  act(() => {
    result.current.updateBodyParameter('temperature', 0.6);
    result.current.enableAutoSave('b');
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(invoke).toHaveBeenCalledWith(
    'config-manager:save',
    'a',
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    'config-manager:save',
    'b',
    expect.anything(),
  );
});

it('blocks flush when new edits arrive while saving', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  let finish: (value: any) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    result.current.updateBodyParameter('temperature', 0.1);
  });
  let pending: Promise<boolean>;
  await act(async () => {
    pending = result.current.flush();
    await Promise.resolve();
  });
  act(() => {
    result.current.updateBodyParameter('temperature', 0.2);
  });
  await act(async () => {
    finish!({ success: true });
    expect(await pending!).toBe(false);
  });
  expect(result.current.getIsDirty()).toBe(true);
});

it('keeps read failures visible and prevents editing stale provider data', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  invoke.mockRejectedValue(new Error('EACCES'));
  await act(async () => {
    await result.current.loadConfig('b');
  });
  expect(result.current.state.loadError).toBe('EACCES');
  act(() => {
    result.current.updateBodyParameter('temperature', 0.1);
  });
  expect(result.current.state.config).toEqual(initial);
  expect(result.current.getIsDirty()).toBe(false);
});

it('discard cancels pending debounce and prevents unmount from saving discarded edits', async () => {
  const { result, unmount } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  act(() => {
    result.current.updateBodyParameter('temperature', 0.1);
    result.current.discardChanges();
  });
  expect(result.current.getIsDirty()).toBe(false);
  expect(result.current.state.config).toEqual(initial);
  unmount();
  await jest.advanceTimersByTimeAsync(5000);
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'config-manager:save'),
  ).toHaveLength(0);
});

it('reset updates the discard baseline and failed resets keep edits', async () => {
  const { result } = renderHook(useParameterConfig);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  act(() => {
    result.current.addBodyParameter('temperature', 0.1);
  });
  invoke.mockResolvedValue({ success: false, error: 'ENOSPC' });
  await act(async () => {
    expect(await result.current.resetConfig('a')).toBe(false);
  });
  expect(result.current.getIsDirty()).toBe(true);
  invoke.mockResolvedValue({ success: true });
  await act(async () => {
    expect(await result.current.resetConfig('a')).toBe(true);
  });
  act(() => {
    result.current.addBodyParameter('temperature', 0.2);
    result.current.discardChanges();
  });
  expect(result.current.state.config!.bodyParameters).toEqual({});
  expect(result.current.getIsDirty()).toBe(false);
});

it('does not treat a missing read response as an empty configuration', async () => {
  const { result } = renderHook(useParameterConfig);
  invoke.mockResolvedValue(undefined);
  await act(async () => {
    await result.current.loadConfig('a');
  });
  expect(result.current.state.loadError).toBeTruthy();
  expect(result.current.state.config).toBeNull();
});
