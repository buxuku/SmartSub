import { act, renderHook, waitFor } from '@testing-library/react';
import { useDubbingDraftCleanup } from '../../hooks/useDubbingDraftCleanup';

beforeEach(() => localStorage.clear());

it('clears only main-confirmed missing sessions and successful deletion events', async () => {
  for (const id of ['gone', 'kept']) {
    localStorage.setItem(`smartsub_dubbing_cue_draft_v1:${id}`, 'text');
    localStorage.setItem(`smartsub_dubbing_config_draft_v1:${id}`, 'config');
  }
  localStorage.setItem('unrelated', 'retained');
  let onDelete!: (ids: string[]) => void;
  const unsubscribe = jest.fn();
  const invoke = jest.fn(async () => ['gone']);
  window.ipc = {
    invoke,
    on: jest.fn((_event, callback) => {
      onDelete = callback;
      return unsubscribe;
    }),
  } as any;
  const hook = renderHook(useDubbingDraftCleanup);
  await waitFor(() =>
    expect(
      localStorage.getItem('smartsub_dubbing_cue_draft_v1:gone'),
    ).toBeNull(),
  );
  expect(localStorage.getItem('smartsub_dubbing_config_draft_v1:kept')).toBe(
    'config',
  );
  expect(invoke).toHaveBeenCalledWith('dubbing:missingSessions', [
    'gone',
    'kept',
  ]);
  act(() => onDelete(['kept']));
  expect(
    localStorage.getItem('smartsub_dubbing_config_draft_v1:kept'),
  ).toBeNull();
  expect(localStorage.getItem('unrelated')).toBe('retained');
  hook.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('preserves recovery bytes on unavailable main process and ignores late responses after unmount', async () => {
  localStorage.setItem('smartsub_dubbing_cue_draft_v1:kept', 'recover');
  let resolve!: (ids: string[]) => void;
  window.ipc = {
    invoke: jest.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
    on: () => () => {},
  } as any;
  const hook = renderHook(useDubbingDraftCleanup);
  hook.unmount();
  await act(async () => resolve(['kept']));
  expect(localStorage.getItem('smartsub_dubbing_cue_draft_v1:kept')).toBe(
    'recover',
  );
});
