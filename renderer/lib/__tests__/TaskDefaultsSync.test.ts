import {
  createTaskDefaultsSync,
  diffTaskDefaults,
  TASK_DEFAULTS_SYNC_DELAY_MS,
} from '../taskDefaultsSync';

type Patch = Record<string, any>;

const baseline = {
  taskType: 'generateAndTranslate',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  translateProvider: 'autoFree',
  maxContext: 3,
  customParameters: { temperature: 0.2, nested: { flag: true } },
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<undefined>((yes) => {
    resolve = () => yes(undefined);
  });
  return { promise, resolve };
};

/** Let every already-queued promise callback run. */
const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};
const tick = (ms = TASK_DEFAULTS_SYNC_DELAY_MS) =>
  jest.advanceTimersByTimeAsync(ms);

const okSend = () =>
  jest.fn(async (_patch: Patch): Promise<unknown> => undefined);

function setup(send = okSend()) {
  const onError = jest.fn();
  const sync = createTaskDefaultsSync({ send, onError });
  sync.start(baseline);
  return { sync, send, onError };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('diffTaskDefaults', () => {
  test('lists the preference keys whose value differs', () => {
    expect(
      diffTaskDefaults(baseline, {
        ...baseline,
        maxContext: 6,
        targetLanguage: 'ja',
      }),
    ).toEqual({ maxContext: 6, targetLanguage: 'ja' });
  });

  test('compares nested values deeply, ignoring key order, and reports a change as a whole', () => {
    expect(
      diffTaskDefaults(baseline, {
        ...baseline,
        customParameters: { nested: { flag: true }, temperature: 0.2 },
      }),
    ).toEqual({});
    expect(
      diffTaskDefaults(baseline, {
        ...baseline,
        customParameters: { temperature: 0.2, nested: { flag: false } },
      }),
    ).toEqual({
      customParameters: { temperature: 0.2, nested: { flag: false } },
    });
  });

  test('reports a removed key as undefined and a new key with its value', () => {
    const { maxContext: _removed, ...without } = baseline;
    const patch = diffTaskDefaults(baseline, { ...without, brandNew: 1 });
    expect(Object.keys(patch).sort()).toEqual(['brandNew', 'maxContext']);
    expect(patch.maxContext).toBeUndefined();
    expect(patch.brandNew).toBe(1);
  });

  test('ignores per-task inputs', () => {
    expect(
      diffTaskDefaults(baseline, {
        ...baseline,
        taskType: 'generateOnly',
        manuscriptPath: '/m.txt',
        manuscriptName: 'm.txt',
        dub: { engine: 'edge' },
        compose: { burn: true },
        gates: { subtitle: 'manual' },
        cloudUploadConsent: true,
      }),
    ).toEqual({});
  });

  test('returns copies, so a form that keeps mutating cannot change a patch', () => {
    const values = structuredClone(baseline);
    const patch = diffTaskDefaults(baseline, {
      ...values,
      customParameters: { temperature: 0.9, nested: { flag: true } },
    });
    patch.customParameters.temperature = 1;
    expect(patch.customParameters.temperature).toBe(1);
    expect(values.customParameters.temperature).toBe(0.2);
    const form = { ...baseline, customParameters: { temperature: 0.5 } };
    const copied = diffTaskDefaults(baseline, form);
    form.customParameters.temperature = 0.7;
    expect(copied.customParameters.temperature).toBe(0.5);
  });
});

describe('createTaskDefaultsSync', () => {
  test('writes nothing for a session nobody edited', async () => {
    const { sync, send } = setup();
    await tick(5000);
    await sync.flush();
    expect(send).not.toHaveBeenCalled();
  });

  test('merges a burst of edits into one debounced patch holding only the changed keys', async () => {
    const { sync, send } = setup();
    sync.edit({ ...baseline, maxContext: 4 });
    await tick(300);
    sync.edit({ ...baseline, maxContext: 5 });
    await tick(300);
    sync.edit({ ...baseline, maxContext: 5, targetLanguage: 'ja' });
    await tick(TASK_DEFAULTS_SYNC_DELAY_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await tick(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ maxContext: 5, targetLanguage: 'ja' });
  });

  test('never sends per-task inputs', async () => {
    const { sync, send } = setup();
    sync.edit({
      ...baseline,
      taskType: 'generateOnly',
      dub: { engine: 'edge' },
      manuscriptPath: '/m.txt',
      gates: {},
      compose: {},
      cloudUploadConsent: true,
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
    sync.edit({ ...baseline, taskType: 'translateOnly', maxContext: 6 });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ maxContext: 6 });
  });

  test('changing a value and changing it back sends nothing', async () => {
    const { sync, send } = setup();
    sync.edit({ ...baseline, maxContext: 9 });
    await tick(100);
    sync.edit({ ...baseline });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  test('a removed setting is sent as undefined so the stored key is deleted', async () => {
    const { sync, send } = setup();
    const { maxContext: _removed, ...without } = baseline;
    sync.edit(without);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    const patch = send.mock.calls[0][0];
    expect(Object.keys(patch)).toEqual(['maxContext']);
    expect(patch.maxContext).toBeUndefined();
  });

  test('only the keys that were saved advance the baseline', async () => {
    const { sync, send } = setup();
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline, maxContext: 4, targetLanguage: 'ja' });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, { maxContext: 4 });
    expect(send).toHaveBeenNthCalledWith(2, { targetLanguage: 'ja' });
  });

  test('flush saves the pending edit synchronously and resolves once it is saved', async () => {
    const saving = deferred();
    const { sync, send } = setup(jest.fn((_patch: Patch) => saving.promise));
    sync.edit({ ...baseline, maxContext: 4 });
    const flushed = sync.flush();
    // No timer and no microtask in between: a page that unmounts right now still sends
    // its edit before whatever the next page asks the main process.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ maxContext: 4 });
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    saving.resolve();
    await flushed;
    expect(done).toBe(true);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('flush with nothing pending resolves without sending', async () => {
    const { sync, send } = setup();
    await sync.flush();
    expect(send).not.toHaveBeenCalled();
  });

  test('starting a new session saves the old one first and never leaks it into the new baseline', async () => {
    const saving = deferred();
    const send = jest.fn(async (_patch: Patch): Promise<unknown> => undefined);
    send.mockImplementationOnce(() => saving.promise);
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    // Another project, with its own older values, is loaded into the form.
    const otherProject = { ...baseline, maxContext: 8 };
    sync.start(otherProject);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ maxContext: 4 });
    saving.resolve();
    await settle();
    sync.edit({ ...otherProject });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    sync.edit({ ...otherProject, targetLanguage: 'ja' });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ targetLanguage: 'ja' });
  });

  test('an old project that is only opened writes nothing, however often it is hydrated', async () => {
    const { sync, send } = setup();
    for (const maxContext of [8, 9, 10]) {
      sync.start({ ...baseline, maxContext });
      sync.edit({ ...baseline, maxContext });
    }
    await tick();
    await sync.flush();
    expect(send).not.toHaveBeenCalled();
  });

  test('a correction is not remembered, but a later user edit of the same key is', async () => {
    const { sync, send } = setup();
    sync.correct('translateProvider', 'googleFree');
    sync.edit({ ...baseline, translateProvider: 'googleFree' });
    await tick();
    expect(send).not.toHaveBeenCalled();
    sync.edit({ ...baseline, translateProvider: 'deepseek' });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ translateProvider: 'deepseek' });
  });

  test('a correction that removes a value is not remembered either', async () => {
    const { sync, send } = setup();
    sync.correct('maxContext', undefined);
    const { maxContext: _removed, ...without } = baseline;
    sync.edit(without);
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  test('a correction does not hide an edit made to another key in the same burst', async () => {
    const { sync, send } = setup();
    sync.correct('translateProvider', 'googleFree');
    sync.edit({
      ...baseline,
      translateProvider: 'googleFree',
      maxContext: 6,
    });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ maxContext: 6 });
  });

  test('a failed save is reported and the next one retries what was lost', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EACCES'));
    const { sync, onError } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('EACCES');
    sync.edit({ ...baseline, maxContext: 4, targetLanguage: 'ja' });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      maxContext: 4,
      targetLanguage: 'ja',
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('leaving the page retries what a failed save lost', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline, maxContext: 4 });
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 4 });
  });

  test('leaving the page retries a failed save even when the user changed nothing since', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync, onError } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 4 });
    expect(onError).toHaveBeenCalledTimes(1);
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('every flush tries again while saving keeps failing, one request each', async () => {
    const send = okSend();
    send.mockRejectedValue(new Error('EACCES'));
    const { sync, onError } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    await sync.flush();
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    send.mockResolvedValue(undefined);
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 4 });
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(4);
  });

  test('flushes that follow while a retry is in flight do not queue more retries', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync, onError } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    let failRetry!: (error: Error) => void;
    send.mockImplementationOnce(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          failRetry = reject;
        }),
    );
    const leaving = sync.flush();
    const unloading = sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
    failRetry(new Error('EIO again'));
    await Promise.all([leaving, unloading]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test('a pending edit after a failed save is sent once with what was lost, not twice', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline, maxContext: 4, targetLanguage: 'ja' });
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      maxContext: 4,
      targetLanguage: 'ja',
    });
  });

  test('starting another session retries what the previous one lost, without leaking it', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    const otherProject = { ...baseline, maxContext: 8, targetLanguage: 'fr' };
    sync.start(otherProject);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 4 });
    await settle();
    sync.edit({ ...otherProject, targetLanguage: 'ja' });
    await tick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ targetLanguage: 'ja' });
  });

  test('a flush that sends the pending edit does not retry the same save a second time', async () => {
    const send = okSend();
    send.mockRejectedValue(new Error('EACCES'));
    const { sync, onError } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline, maxContext: 5 });
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 5 });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test('a form that only went back to what is saved has nothing to retry', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    await sync.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a save that throws synchronously is reported, not thrown at the form', async () => {
    const boom = new Error('boom');
    const { sync, onError } = setup(
      jest.fn((_patch: Patch): Promise<unknown> => {
        throw boom;
      }),
    );
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  test('a failing error handler cannot stall later saves', async () => {
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const sync = createTaskDefaultsSync({
      send,
      onError: () => {
        throw new Error('handler');
      },
    });
    sync.start(baseline);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    sync.edit({ ...baseline, maxContext: 5 });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 5 });
  });

  test('failures are logged by default', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = okSend();
    send.mockRejectedValueOnce(new Error('EIO'));
    const sync = createTaskDefaultsSync({ send });
    sync.start(baseline);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    expect(log).toHaveBeenCalledWith(
      'Failed to update task defaults:',
      expect.any(Error),
    );
    log.mockRestore();
  });

  test('saves are serialized, so changing a value and reverting it ends with the reverted value', async () => {
    const saving = deferred();
    const send = okSend();
    send.mockImplementationOnce(() => saving.promise);
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 9 });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 9 });
    // The user reverts while the first save is still in flight.
    sync.edit({ ...baseline });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    saving.resolve();
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ maxContext: 3 });
  });

  test('flush also waits for a save that is already in flight', async () => {
    const saving = deferred();
    const send = okSend();
    send.mockImplementationOnce(() => saving.promise);
    const { sync } = setup(send);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    let done = false;
    void sync.flush().then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    saving.resolve();
    await settle();
    expect(done).toBe(true);
  });

  test('ignores edits and corrections before a session was started', async () => {
    const send = okSend();
    const sync = createTaskDefaultsSync({ send, onError: jest.fn() });
    sync.correct('maxContext', 4);
    sync.edit({ ...baseline, maxContext: 4 });
    await tick();
    await sync.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
