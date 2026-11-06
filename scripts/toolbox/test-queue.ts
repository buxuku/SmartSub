import assert from 'node:assert/strict';
import { ToolboxQueue } from '../../renderer/lib/toolboxQueue';

async function main() {
  const queue = new ToolboxQueue<
    { filePath: string },
    { success: boolean; error?: string }
  >();
  queue.add([
    { filePath: '/a.mp4' },
    { filePath: '/b.mp4' },
    { filePath: '/a.mp4' },
  ]);
  queue.add([{ filePath: '/b.mp4' }]);
  assert.equal(queue.getSnapshot().items.length, 2);
  const calls: string[] = [];
  let fail = true;
  const runner = {
    failureMessage: 'Failed',
    execute: async ({ filePath }: { filePath: string }, jobId: string) => {
      calls.push(filePath);
      queue.progress('stale-job', 90);
      assert.equal(
        queue.getSnapshot().items.find((i) => i.status === 'running')!.progress,
        undefined,
      );
      queue.progress(jobId, 50);
      assert.equal(
        queue.getSnapshot().items.find((i) => i.status === 'running')!.progress,
        50,
      );
      return { success: !(fail && filePath === '/a.mp4'), error: 'disk full' };
    },
  };
  await queue.run(runner);
  assert.deepEqual(
    queue.getSnapshot().items.map((i) => i.status),
    ['error', 'done'],
  );
  await queue.run(runner);
  assert.equal(
    calls.length,
    2,
    'No implicit reruns of failed or successful items',
  );
  fail = false;
  await queue.run(runner, queue.getSnapshot().items[0].id);
  assert.deepEqual(calls, ['/a.mp4', '/b.mp4', '/a.mp4']);
  assert.ok(queue.getSnapshot().items.every((i) => i.status === 'done'));

  queue.clear();
  queue.add([{ filePath: '/a.mp4' }, { filePath: '/b.mp4' }]);
  let resolve: (result: { success: boolean }) => void;
  let jobs = 0;
  let cancelCalls = 0;
  const delayed = {
    failureMessage: 'Failed',
    execute: () => {
      jobs++;
      return new Promise<{ success: boolean }>((done) => {
        resolve = done;
      });
    },
    cancel: async () => {
      cancelCalls++;
    },
  };
  const run = queue.run(delayed);
  queue.clear();
  queue.remove(queue.getSnapshot().items[0].id);
  queue.add([{ filePath: '/c.mp4' }]);
  assert.equal(
    queue.getSnapshot().items.length,
    2,
    'Lock inputs while processing',
  );
  await queue.cancel();
  await queue.cancel();
  assert.equal(cancelCalls, 1);
  assert.equal(
    queue.getSnapshot().running,
    true,
    'Keep lock until backend settles',
  );
  await queue.run(delayed);
  assert.equal(jobs, 1, 'Cannot overlap restarted jobs with cancelled jobs');
  resolve!({ success: false });
  await run;
  assert.deepEqual(
    queue.getSnapshot().items.map((i) => i.status),
    ['cancelled', 'pending'],
  );
  await queue.run(runner);
  assert.ok(queue.getSnapshot().items.every((i) => i.status === 'done'));

  queue.clear();
  queue.add([{ filePath: '/a.mp4' }]);
  const completing = queue.run(delayed);
  await queue.cancel();
  resolve!({ success: true });
  await completing;
  assert.equal(
    queue.getSnapshot().items[0].status,
    'done',
    'Preserve an output that completed during stop',
  );

  for (const response of [undefined, {}, { success: false }]) {
    queue.clear();
    queue.add([{ filePath: '/a.mp4' }]);
    await queue.run({
      failureMessage: 'Malformed response',
      execute: async () => response as any,
    });
    assert.equal(queue.getSnapshot().items[0].status, 'error');
    assert.equal(queue.getSnapshot().items[0].error, 'Malformed response');
  }
  queue.clear();
  queue.add([{ filePath: '/a.mp4' }]);
  await queue.run({
    failureMessage: 'Failed',
    execute: async () => {
      throw new Error('IPC disconnected');
    },
  });
  assert.equal(queue.getSnapshot().items[0].error, 'IPC disconnected');
  assert.equal(queue.getSnapshot().running, false);
  queue.clear();
  queue.add([{ filePath: '/partial.mkv' }]);
  const partialResult = {
    success: false,
    error: 'Second track failed',
    extractedFiles: [{ outputPath: '/partial.srt' }],
  };
  await queue.run({
    failureMessage: 'Failed',
    execute: async () => partialResult,
  });
  assert.equal(queue.getSnapshot().items[0].status, 'error');
  assert.equal(
    queue.getSnapshot().items[0].result,
    partialResult,
    'failed jobs preserve successful partial outputs without reporting success',
  );
  await queue.run(
    {
      failureMessage: 'Failed',
      execute: async (_input, _jobId, _signal, previous) => {
        assert.equal(previous, partialResult, 'retry receives partial outputs');
        assert.equal(
          queue.getSnapshot().items[0].result,
          partialResult,
          'outputs remain available while retrying',
        );
        throw new Error('Retry preflight failed');
      },
    },
    queue.getSnapshot().items[0].id,
  );
  assert.equal(
    queue.getSnapshot().items[0].result,
    partialResult,
    'preflight failure does not lose previous outputs',
  );
  console.log(
    'Toolbox queue: deduplication, strict responses, independent retry, progress isolation, cancellation races and input locking passed.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
