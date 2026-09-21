const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const running = new Map();
let acquired = 0,
  released = 0;
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/composeQueue.ts')) {
    if (request === '../storeManager') return { logMessage() {} };
    if (request === '../powerSaveManager')
      return {
        acquireTaskPowerSaveBlocker() {
          acquired++;
        },
        releaseTaskPowerSaveBlocker() {
          released++;
        },
      };
    if (request === '../subtitleMerger')
      return { MERGE_CANCELLED: 'cancelled' };
    if (request === './composeRunner')
      return {
        runComposeJob: (config, context) =>
          new Promise((resolve, reject) => {
            running.set(context.jobId, { resolve, reject, config });
            context.setCancel(() => reject(new Error('cancelled')));
          }),
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};
async function main() {
  const {
    enqueueCompose,
    getComposeQueueSnapshot,
    cancelComposeJob,
    isComposeBusy,
  } = require('../../main/helpers/compose/composeQueue.ts');
  const config = {
    videoPath: '/same.mp4',
    outputPath: '/out.mp4',
    subtitle: { mode: 'soft', subtitlePath: '/same.srt' },
    audio: { mode: 'keep' },
  };
  const one = enqueueCompose(config, 'subtitleMerge', { requestId: 'one' });
  const two = enqueueCompose(config, 'subtitleMerge', { requestId: 'two' });
  const replay = enqueueCompose(structuredClone(config), 'subtitleMerge', {
    requestId: 'two',
  });
  assert.equal(replay.jobId, two.jobId);
  assert.equal(replay.done, two.done);
  assert.deepEqual(
    getComposeQueueSnapshot().map((job) => [job.requestId, job.status]),
    [
      ['one', 'running'],
      ['two', 'queued'],
    ],
  );
  assert.throws(
    () =>
      enqueueCompose(
        { ...config, outputPath: '/different.mp4' },
        'subtitleMerge',
        { requestId: 'two' },
      ),
    /different settings/,
  );
  assert.throws(
    () => enqueueCompose(config, 'subtitleMerge', { requestId: '' }),
    /Invalid/,
  );
  assert.throws(
    () =>
      enqueueCompose(config, 'subtitleMerge', { requestId: 'x'.repeat(129) }),
    /Invalid/,
  );
  assert.equal(cancelComposeJob(two.jobId), true);
  assert.equal((await two.done).cancelled, true);
  assert.equal(
    getComposeQueueSnapshot().find((job) => job.id === one.jobId).status,
    'running',
  );
  running.get(one.jobId).resolve('/out_2.mp4');
  assert.equal((await one.done).outputPath, '/out_2.mp4');
  assert.equal(
    getComposeQueueSnapshot().find((job) => job.id === one.jobId).requestId,
    'one',
  );
  assert.equal(
    getComposeQueueSnapshot().find((job) => job.id === one.jobId).outputPath,
    '/out_2.mp4',
  );
  assert.equal(
    enqueueCompose(config, 'subtitleMerge', { requestId: 'one' }).jobId,
    one.jobId,
  );
  const other = enqueueCompose(config, 'pipeline', { requestId: 'one' });
  assert.notEqual(other.jobId, one.jobId);
  assert.equal(cancelComposeJob(other.jobId), true);
  await other.done;
  assert.equal(isComposeBusy(), false);
  assert.equal(acquired, released);
  console.log(
    'Compose queue: same-path identities, exact cancellation, idempotent request replay, conflicting payload rejection, terminal published path and source isolation passed.',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
  });
