import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { ToolboxQueue } from '../../renderer/lib/toolboxQueue';
import {
  resolveToolboxVideoRange,
  useToolboxVideoSelection,
  type ToolboxVideoInput,
} from '../../renderer/hooks/useToolboxVideoSelection';

async function main() {
  (globalThis as any).window = {
    ipc: {
      invoke: async () => ({
        duration: 10,
        width: 320,
        height: 180,
        size: 1000,
      }),
    },
  };
  const queue = new ToolboxQueue<ToolboxVideoInput, { success: boolean }>();
  queue.add([
    { filePath: '/tmp/first.mp4', startSec: 9, endSec: 20 },
    { filePath: '/tmp/second.mp4' },
  ]);
  let selection: ReturnType<typeof useToolboxVideoSelection>;
  function Harness() {
    selection = useToolboxVideoSelection(queue, queue.getSnapshot().items, 5);
    return null;
  }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  assert.equal(
    selection!.info?.duration,
    10,
    'invalid range must not prevent loading metadata needed to correct it',
  );
  assert.equal(selection!.loadError, undefined);
  await assert.rejects(
    resolveToolboxVideoRange(queue.getSnapshot().items[0].input),
    /range/,
  );
  await act(async () => {
    selection!.setEndSec(10);
    root!.update(<Harness />);
  });
  assert.equal(
    (await resolveToolboxVideoRange(queue.getSnapshot().items[0].input)).endSec,
    10,
  );
  await act(async () => {
    selection!.select(queue.getSnapshot().items[1].id);
  });
  assert.equal(selection!.startSec, 0);
  assert.equal(selection!.endSec, 5);
  await act(async () => {
    selection!.select(queue.getSnapshot().items[0].id);
  });
  assert.equal(selection!.startSec, 9);
  assert.equal(selection!.endSec, 10);
  await act(async () => {
    root!.unmount();
  });
  console.log(
    'Toolbox preview: invalid ranges remain correctable, export validation and per-file range persistence passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
