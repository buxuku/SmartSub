import { act, renderHook, waitFor } from '@testing-library/react';
import useEngineSettings from '../useEngineSettings';
import { useNavigationGuard } from '../../context/NavigationGuardContext';
import {
  invalidEngineSettings,
  FASTER_WHISPER_COMPUTE_TYPES,
} from '../../../types/engineSettings';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));
const initial = {
  whisperCommand: 'original-command',
  useLocalWhisper: false,
  fasterWhisperDevice: 'auto',
  fasterWhisperComputeType: 'auto',
};
beforeEach(() => {
  window.ipc = {
    invoke: jest.fn(async (channel) =>
      channel === 'getSettings' ? initial : { rejectedKeys: [] },
    ),
  } as any;
});
afterEach(() => jest.useRealTimers());
const writes = () =>
  (window.ipc.invoke as jest.Mock).mock.calls.filter(
    ([channel]) => channel === 'setSettings',
  );

test.each([
  null,
  [],
  { success: false },
  { whisperCommand: 3 },
  { fasterWhisperDevice: 'bad' },
  { fasterWhisperComputeType: 'bad' },
])(
  'untrusted settings %p cannot enable an editable default or a write',
  async (value) => {
    (window.ipc.invoke as jest.Mock).mockResolvedValueOnce(value);
    const { result } = renderHook(() => useEngineSettings(jest.fn()));
    await waitFor(() => expect(result.current.persistence.loading).toBe(false));
    expect(result.current.persistence.loaded).toBe(false);
    act(() =>
      expect(result.current.change({ whisperCommand: 'overwrite' })).toBe(
        false,
      ),
    );
    expect(writes()).toHaveLength(0);
    await act(async () => result.current.persistence.load());
    expect(result.current.values.whisperCommand).toBe(initial.whisperCommand);
  },
);

test('unsaved command stays dirty until acknowledged, failed save blocks navigation, retry refreshes status', async () => {
  const onSaved = jest.fn();
  const { result } = renderHook(() => useEngineSettings(onSaved));
  await waitFor(() => expect(result.current.persistence.loaded).toBe(true));
  act(() => result.current.change({ whisperCommand: 'edited' }, null));
  const guard = (useNavigationGuard as jest.Mock).mock.calls.at(-1)![1];
  expect(guard.getIsDirty()).toBe(true);
  expect(writes()).toHaveLength(0);
  (window.ipc.invoke as jest.Mock).mockRejectedValueOnce(new Error('EACCES'));
  await act(async () => expect(await guard.onSave()).toBe(false));
  expect(result.current.values.whisperCommand).toBe('edited');
  expect(result.current.acknowledged.whisperCommand).toBe('original-command');
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () =>
    expect(await result.current.persistence.save()).toBe(true),
  );
  expect(result.current.acknowledged.whisperCommand).toBe('edited');
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test('rejected device stays selected for retry, accepted fields do not erase a newer command', async () => {
  const { result } = renderHook(() => useEngineSettings(jest.fn()));
  await waitFor(() => expect(result.current.persistence.loaded).toBe(true));
  act(() =>
    result.current.change(
      { fasterWhisperDevice: 'cpu', whisperCommand: 'new' },
      null,
    ),
  );
  (window.ipc.invoke as jest.Mock).mockResolvedValueOnce({
    rejectedKeys: ['fasterWhisperDevice'],
  });
  await act(async () =>
    expect(await result.current.persistence.save()).toBe(false),
  );
  expect(result.current.values.fasterWhisperDevice).toBe('cpu');
  expect(result.current.values.whisperCommand).toBe('new');
  await act(async () => result.current.persistence.save());
  expect(writes().at(-1)![1]).toEqual({ fasterWhisperDevice: 'cpu' });
  expect(result.current.acknowledged.whisperCommand).toBe('new');
});

test('discard restores acknowledged command and cancels queued device change', async () => {
  const { result } = renderHook(() => useEngineSettings(jest.fn()));
  await waitFor(() => expect(result.current.persistence.loaded).toBe(true));
  jest.useFakeTimers();
  act(() =>
    result.current.change({
      fasterWhisperDevice: 'cpu',
      whisperCommand: 'new',
    }),
  );
  await act(async () => result.current.persistence.discard());
  await act(async () => jest.runAllTimersAsync());
  expect(writes()).toHaveLength(0);
  expect(result.current.values).toEqual(initial);
});

test('engine field validation accepts supported CTranslate2 values and rejects invalid primitive types', () => {
  for (const value of FASTER_WHISPER_COMPUTE_TYPES)
    expect(invalidEngineSettings({ fasterWhisperComputeType: value })).toEqual(
      [],
    );
  for (const [key, values] of Object.entries({
    fasterWhisperDevice: ['bad', null, 3],
    fasterWhisperComputeType: ['', 'bad', false],
    whisperCommand: [null, 3, []],
    useLocalWhisper: ['true', 1, null],
  }))
    for (const value of values)
      expect(invalidEngineSettings({ [key]: value })).toEqual([key]);
});
