import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  useTaskProjectPersistence,
  taskProjectSaveKey,
  type TaskProjectSave,
} from '../renderer/hooks/useTaskProjectPersistence';

async function main() {
  const runtime = {
    id: 'running',
    taskType: 'generateOnly',
    preserveTaskProgress: true as const,
    files: [{ uuid: 'f', filePath: '/f.mp4', extractSubtitle: 'loading' }],
  };
  assert.equal(
    taskProjectSaveKey(runtime),
    taskProjectSaveKey({
      ...runtime,
      files: [{ ...runtime.files[0], extractSubtitle: 'done' }],
    }),
    'background progress is not unsaved input',
  );
  let response: 'success' | 'failure' | 'malformed' = 'success';
  let release: (() => void) | undefined;
  let delayed = false;
  const writes: TaskProjectSave[] = [];
  const notifications: string[] = [];
  (globalThis as any).window = {
    ipc: {
      invoke: async (_channel: string, payload: TaskProjectSave) => {
        writes.push(payload);
        if (delayed)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (response === 'failure') throw new Error('ENOSPC');
        if (response === 'malformed') return {};
        return { id: payload.id };
      },
    },
  };
  const payload = (name: string, id = 'a'): TaskProjectSave => ({
    id,
    taskType: 'generateOnly',
    files: [],
    taskDraft: { config: { name }, manuscripts: [] },
    preserveTaskProgress: true,
  });
  let hook: ReturnType<typeof useTaskProjectPersistence>;
  function Harness({ value }: { value: TaskProjectSave | null }) {
    hook = useTaskProjectPersistence(value, (saved) =>
      notifications.push(saved.id),
    );
    return null;
  }
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness value={payload('first')} />);
  });
  assert.equal(hook!.getIsDirty(), true);
  await act(async () => {
    assert.equal(await hook!.save(), true);
  });
  assert.equal(hook!.getIsDirty(), false);
  delayed = true;
  await act(async () => {
    root!.update(<Harness value={payload('second')} />);
  });
  let saving: Promise<boolean>;
  act(() => {
    saving = hook!.save();
  });
  await act(async () => {
    root!.update(<Harness value={payload('third')} />);
  });
  assert.equal(writes.length, 2, 'only one IPC save in flight');
  assert.equal(hook!.save(), saving!, 'explicit save joins the same queue');
  await act(async () => {
    delayed = false;
    release!();
    assert.equal(await saving!, true);
  });
  assert.deepEqual(
    writes.map((value) => value.taskDraft?.config.name),
    ['first', 'second', 'third'],
  );
  assert.equal(hook!.getIsDirty(), false);
  for (const failure of ['failure', 'malformed'] as const) {
    response = failure;
    await act(async () => {
      root!.update(<Harness value={payload(failure)} />);
    });
    await act(async () => {
      assert.equal(await hook!.save(), false);
    });
    assert.equal(hook!.getIsDirty(), true);
    assert.ok(hook!.error);
  }
  response = 'success';
  await act(async () => {
    assert.equal(await hook!.save(), true);
  });
  assert.equal(hook!.error, null);
  await act(async () => {
    root!.update(<Harness value={payload('first')} />);
  });
  assert.equal(
    hook!.getIsDirty(),
    true,
    'reverting to initial values still persists over newer disk values',
  );
  await act(async () => {
    await hook!.save();
  });
  delayed = true;
  await act(async () => {
    root!.update(<Harness value={payload('late')} />);
  });
  act(() => {
    saving = hook!.save();
  });
  await act(async () => {
    root!.update(<Harness value={payload('other', 'b')} />);
  });
  notifications.length = 0;
  await act(async () => {
    delayed = false;
    release!();
    await saving!;
  });
  assert.deepEqual(
    notifications,
    ['b'],
    'stale responses never update another project',
  );
  delayed = true;
  await act(async () => {
    root!.update(<Harness value={payload('saving', 'b')} />);
  });
  act(() => {
    saving = hook!.save();
  });
  await act(async () => {
    root!.update(<Harness value={payload('discarded', 'b')} />);
  });
  act(() => {
    hook!.discard();
  });
  const countBeforeDiscardReply = writes.length;
  notifications.length = 0;
  await act(async () => {
    delayed = false;
    release!();
    await saving!;
  });
  assert.equal(
    writes.length,
    countBeforeDiscardReply,
    'old acknowledgement cannot requeue discarded edits',
  );
  assert.deepEqual(
    notifications,
    [],
    'discarded request does not publish stale saved project',
  );
  assert.equal(hook!.getIsDirty(), false);
  await act(async () => {
    root!.unmount();
  });
  console.log(
    'Task project persistence: serialized saves, latest revision, failures, retry, initial-value revert, and cross-project response isolation passed',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
