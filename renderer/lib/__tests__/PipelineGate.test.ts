import { releasePipelineGate } from '../pipelineGate';

const item = (state: string, extra: any[] = []) => ({
  pipelineFiles: [{ uuid: 'a', dubbingGate: state }, ...extra],
});
const payload = {
  projectId: 'project',
  gate: 'dubbing' as const,
  leaseId: 'lease',
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it.each(['reject', 'hang'])(
  'recovers a %s reply using the original files without resubmission',
  async (mode) => {
    let reads = 0;
    const invoke = jest.fn((channel) => {
      if (channel === 'getWorkItem')
        return Promise.resolve(
          ++reads === 1
            ? item('review')
            : item('passed', [{ uuid: 'later', dubbingGate: 'review' }]),
        );
      return mode === 'reject'
        ? Promise.reject(new Error('lost'))
        : new Promise(() => {});
    });
    window.ipc = { invoke } as any;
    const operation = releasePipelineGate(payload, () => true, jest.fn());
    await jest.advanceTimersByTimeAsync(1100);
    await operation;
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === 'pipeline:releaseGate',
      ),
    ).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('pipeline:releaseGate', {
      ...payload,
      fileUuids: ['a'],
    });
  },
);

it('reports a rejected uncommitted release and retains real business errors', async () => {
  const invoke = jest.fn(
    (channel): Promise<any> =>
      channel === 'getWorkItem'
        ? Promise.resolve(item('review'))
        : Promise.reject(new Error('lost')),
  );
  window.ipc = { invoke } as any;
  await expect(
    releasePipelineGate(payload, () => true, jest.fn()),
  ).rejects.toThrow('lost');
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'getWorkItem'
        ? item('review')
        : { success: false, error: 'disk full' },
    ),
  );
  await expect(
    releasePipelineGate(payload, () => true, jest.fn()),
  ).rejects.toThrow('disk full');
});

it('keeps one hung status request and accepts the original acknowledgement', async () => {
  let reads = 0;
  let finish: (value: any) => void;
  window.ipc = {
    invoke: jest.fn((channel) => {
      if (channel === 'getWorkItem')
        return ++reads === 1
          ? Promise.resolve(item('review'))
          : new Promise(() => {});
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  } as any;
  const operation = releasePipelineGate(payload, () => true, jest.fn());
  await jest.advanceTimersByTimeAsync(5000);
  expect(reads).toBe(2);
  finish!({ success: true });
  await operation;
});

it('retries failed confirmation reads and stops when the editor changes', async () => {
  let current = true,
    reads = 0;
  const warning = jest.fn();
  window.ipc = {
    invoke: jest.fn((channel) => {
      if (channel === 'getWorkItem')
        return ++reads === 1
          ? Promise.resolve(item('review'))
          : Promise.reject(new Error('offline'));
      return new Promise(() => {});
    }),
  } as any;
  const operation = releasePipelineGate(payload, () => current, warning);
  const rejected = expect(operation).rejects.toThrow('editor has changed');
  await jest.advanceTimersByTimeAsync(2100);
  expect(reads).toBe(3);
  expect(warning).toHaveBeenCalledWith('Error: offline');
  current = false;
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
});

it('does not send another release for already passed files', async () => {
  const invoke = jest.fn(async () => item('passed'));
  window.ipc = { invoke } as any;
  await releasePipelineGate(
    { ...payload, fileUuids: ['a'] },
    () => true,
    jest.fn(),
  );
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('keeps the retry target snapshot even if another file arrives after a failed release', async () => {
  let targets: string[] | undefined;
  let current = item('review');
  const invoke = jest.fn(async (channel, payload) => {
    if (channel === 'getWorkItem') return current;
    current = item('review', [{ uuid: 'later', dubbingGate: 'review' }]);
    return { success: false, error: 'disk full' };
  });
  window.ipc = { invoke } as any;
  await expect(
    releasePipelineGate(
      payload,
      () => true,
      jest.fn(),
      (ids) => {
        targets = ids;
      },
    ),
  ).rejects.toThrow('disk full');
  expect(targets).toEqual(['a']);
  await expect(
    releasePipelineGate(
      { ...payload, fileUuids: targets },
      () => true,
      jest.fn(),
    ),
  ).rejects.toThrow('disk full');
  expect(invoke).toHaveBeenLastCalledWith('pipeline:releaseGate', {
    ...payload,
    fileUuids: ['a'],
  });
});
