import { act, renderHook } from '@testing-library/react';
import { useDubbingCueDrafts } from '../../hooks/useDubbingCueDrafts';
import { dubbingCueDraftKey } from '../../../types/dubbingCueDraft';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));
const lease = { sessionId: 'project', leaseId: 'editor' };
const cue = (index: number) => ({
  index,
  startMs: index * 1000,
  endMs: (index + 1) * 1000,
  text: `Original ${index}`,
  status: 'pending' as const,
  overlap: false,
});
let disk: string | null;
let saved: ReturnType<typeof cue>[];
let invoke: jest.Mock;
let current: boolean;
const apply = jest.fn();
beforeEach(() => {
  localStorage.clear();
  disk = null;
  saved = [cue(0), cue(1)];
  current = true;
  apply.mockClear();
  invoke = jest.fn(async (name, payload) => {
    if (name === 'dubbing:readCueDraft') return { success: true, data: disk };
    if (name === 'dubbing:writeCueDraft') {
      if (payload.expected !== disk && payload.raw !== disk)
        return { success: false, error: 'conflict' };
      disk = payload.raw;
      return { success: true, data: disk };
    }
    if (name === 'dubbing:saveCueTexts') {
      for (const edit of payload.edits)
        saved[edit.index] = { ...saved[edit.index], text: edit.text };
    }
    return { success: true, data: { ...lease, cues: saved } };
  });
  window.ipc = { invoke } as any;
});
const mount = () =>
  renderHook(() =>
    useDubbingCueDrafts({
      owns: () => current,
      busy: () => false,
      acquire: () => {},
      release: () => {},
      apply,
    }),
  );
const open = async () => {
  const hook = mount();
  await act(async () => {
    expect(await hook.result.current.inspect(lease)).toBe(true);
  });
  return hook;
};

it('retains separate rows including blank input, synchronously journals, and saves without synthesis', async () => {
  const hook = await open();
  act(() => {
    hook.result.current.edit(cue(0), 'First');
    expect(
      JSON.parse(localStorage.getItem(dubbingCueDraftKey('project'))!)
        .entries[0].text,
    ).toBe('First');
    hook.result.current.edit(cue(1), '');
  });
  expect(hook.result.current.entries[0].text).toBe('First');
  expect(hook.result.current.entries[1].text).toBe('');
  expect(hook.result.current.blocked()).toBe(true);
  await act(async () => {
    expect(await hook.result.current.save(0)).toBe(true);
  });
  expect(Object.keys(hook.result.current.entries)).toEqual(['1']);
  expect(JSON.parse(disk!).entries).toHaveLength(1);
  await act(async () => {
    expect(await hook.result.current.save()).toBe(true);
  });
  expect(saved.map((item) => item.text)).toEqual(['First', '']);
  expect(disk).toBeNull();
  expect(localStorage.getItem(dubbingCueDraftKey('project'))).toBeNull();
  expect(hook.result.current.blocked()).toBe(false);
  expect(
    invoke.mock.calls.some(([name]) => /resynthesize|start/.test(name)),
  ).toBe(false);
});

it('retains unacknowledged commits, discards to the current saved snapshot', async () => {
  const hook = await open();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, payload) => {
    const result = await original(name, payload);
    if (name === 'dubbing:saveCueTexts') throw new Error('lost reply');
    return result;
  });
  act(() => hook.result.current.edit(cue(0), 'Committed'));
  await act(async () => {
    expect(await hook.result.current.save()).toBe(false);
  });
  expect(hook.result.current.entries[0].text).toBe('Committed');
  expect(disk).not.toBeNull();
  invoke.mockImplementation(original);
  await act(async () => {
    expect(await hook.result.current.discard()).toBe(true);
  });
  expect(apply.mock.calls.at(-1)[0].cues[0].text).toBe('Committed');
  expect(hook.result.current.blocked()).toBe(false);
});

it('requires explicit recovery and keeps comparison bases for conflict detection', async () => {
  const hook = await open();
  act(() => hook.result.current.edit(cue(0), 'Recovered'));
  await act(async () => {});
  hook.unmount();
  localStorage.clear();
  const next = await open();
  expect(next.result.current.recovery).not.toBeNull();
  act(() => expect(next.result.current.edit(cue(1), 'Blocked')).toBe(false));
  await act(async () => {
    expect(await next.result.current.save()).toBe(false);
  });
  act(() => expect(next.result.current.restore()).toBe(true));
  expect(next.result.current.entries[0]).toMatchObject({
    baseText: 'Original 0',
    text: 'Recovered',
  });
  expect(
    invoke.mock.calls.some(([name]) => name === 'dubbing:saveCueTexts'),
  ).toBe(false);
});

it('preserves malformed bytes and fails closed on unread storage', async () => {
  disk = '{broken';
  const hook = mount();
  await act(async () => {
    expect(await hook.result.current.inspect(lease)).toBe(false);
  });
  expect(hook.result.current.recovery).toBe('unreadable');
  expect(disk).toBe('{broken');
  await act(async () => {
    expect(await hook.result.current.discard()).toBe(true);
  });
  expect(disk).toBeNull();
});

it('keeps the guard dirty while a revert journal clear fails, then retries', async () => {
  const hook = await open();
  act(() => hook.result.current.edit(cue(0), 'Temporary'));
  await act(async () => {});
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name, payload) =>
    name === 'dubbing:writeCueDraft' && payload.raw === null
      ? Promise.resolve({ success: false, error: 'cleanup denied' })
      : original(name, payload),
  );
  await act(async () => {
    hook.result.current.edit(cue(0), cue(0).text);
  });
  expect(Object.keys(hook.result.current.entries)).toHaveLength(0);
  expect(hook.result.current.blocked()).toBe(true);
  expect(hook.result.current.error).toContain('cleanup denied');
  invoke.mockImplementation(original);
  await act(async () => {
    expect(await hook.result.current.save()).toBe(true);
  });
  expect(hook.result.current.blocked()).toBe(false);
});

it('serializes rapid journal writes and recovers a journal acknowledgement loss', async () => {
  const hook = await open();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, payload) => {
    const result = await original(name, payload);
    if (name === 'dubbing:writeCueDraft') throw new Error('reply lost');
    return result;
  });
  act(() => {
    for (let i = 0; i < 15; i++) hook.result.current.edit(cue(0), `Text ${i}`);
  });
  await act(async () => {
    expect(await hook.result.current.save()).toBe(true);
  });
  expect(saved[0].text).toBe('Text 14');
  expect(disk).toBeNull();
});

it('does not erase unseen data on read errors or allow a retired lease to write', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name, payload) =>
    name === 'dubbing:readCueDraft'
      ? Promise.resolve({ success: false, error: 'read denied' })
      : original(name, payload),
  );
  const hook = mount();
  await act(async () => {
    await hook.result.current.inspect(lease);
  });
  await act(async () => {
    expect(await hook.result.current.discard()).toBe(false);
  });
  invoke.mockImplementation(original);
  await act(async () => {
    expect(await hook.result.current.retry()).toBe(true);
  });
  current = false;
  act(() => expect(hook.result.current.edit(cue(0), 'No')).toBe(false));
  await act(async () => {
    expect(await hook.result.current.save()).toBe(false);
  });
});

it('preserves drafts on local quota errors even when the main journal succeeds', async () => {
  const hook = await open();
  const spy = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota');
    });
  await act(async () => {
    hook.result.current.edit(cue(0), 'Main backup');
  });
  expect(JSON.parse(disk!).entries[0].text).toBe('Main backup');
  await act(async () => {
    expect(await hook.result.current.save()).toBe(false);
  });
  expect(saved[0].text).toBe('Original 0');
  spy.mockRestore();
  await act(async () => {
    expect(await hook.result.current.save()).toBe(true);
  });
});

it('keeps a return-to-original dirty after an unacknowledged save', async () => {
  const hook = await open();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, payload) => {
    const result = await original(name, payload);
    if (name === 'dubbing:saveCueTexts') throw new Error('lost reply');
    return result;
  });
  act(() => hook.result.current.edit(cue(0), 'Unacknowledged'));
  await act(async () => {
    expect(await hook.result.current.save()).toBe(false);
  });
  await act(async () => {
    hook.result.current.edit(cue(0), cue(0).text);
  });
  expect(hook.result.current.entries[0].text).toBe(cue(0).text);
  expect(hook.result.current.blocked()).toBe(true);
  expect(JSON.parse(disk!).entries[0].text).toBe(cue(0).text);
});

it('keeps the comparison interval until explicit conflict confirmation', async () => {
  const hook = await open();
  act(() => hook.result.current.edit(cue(0), 'My text'));
  const changed = { ...cue(0), startMs: 100, text: 'New saved text' };
  act(() => hook.result.current.edit(changed, 'Revised text'));
  expect(hook.result.current.entries[0]).toMatchObject({
    startMs: 0,
    baseText: 'Original 0',
  });
  act(() => expect(hook.result.current.rebase(changed)).toBe(true));
  expect(hook.result.current.entries[0]).toMatchObject({
    startMs: 100,
    baseText: 'New saved text',
    text: 'Revised text',
  });
  await act(async () => {});
});
