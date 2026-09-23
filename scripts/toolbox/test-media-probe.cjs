const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let spawnOverride;
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
  if (request.endsWith('/logger')) return { logMessage() {} };
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === 'child_process')
    return {
      ...loaded,
      spawn: (...args) =>
        spawnOverride ? spawnOverride(...args) : loaded.spawn(...args),
    };
  return loaded;
};

async function main() {
  const {
    probeVideoInfo,
  } = require('../../main/helpers/toolbox/videoTrimmer.ts');
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-media-probe-'),
  );
  const silent = path.join(output, 'silent.mp4');
  const audible = path.join(output, 'audible.mp4');
  const run = (args) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
  run([
    '-f',
    'lavfi',
    '-i',
    'color=black:s=320x180:r=25:d=1',
    '-c:v',
    'libx264',
    silent,
  ]);
  run([
    '-i',
    silent,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    audible,
  ]);
  assert.deepEqual(await probeVideoInfo(silent), {
    duration: 1,
    width: 320,
    height: 180,
    size: fs.statSync(silent).size,
    hasAudio: false,
    videoCodec: 'h264',
    audioCodec: undefined,
  });
  assert.equal((await probeVideoInfo(audible)).hasAudio, true);
  const {
    executeVideoCompress,
  } = require('../../main/helpers/toolbox/videoCompressor.ts');
  const small = await executeVideoCompress(
    { videoPath: audible, preset: 'wechat_25mb' },
    'small',
  );
  assert.equal(small.success, true);
  assert.equal(small.skipped, true);
  assert.equal(small.outputPath, audible);
  assert.equal(small.originalSize, small.compressedSize);
  const recoded = await executeVideoCompress(
    { videoPath: audible, preset: 'fast_720p' },
    'recode',
  );
  assert.equal(recoded.success, true);
  assert.notEqual(recoded.outputPath, audible);
  assert.notEqual(recoded.skipped, true);
  const aboveTarget = await executeVideoCompress(
    { videoPath: audible, preset: 'target_size', targetSizeMb: 0.001 },
    'above-target',
  );
  assert.equal(aboveTarget.success, true);
  assert.notEqual(aboveTarget.skipped, true);
  assert.notEqual(aboveTarget.outputPath, audible);
  const invalid = path.join(output, 'invalid.mp4');
  fs.writeFileSync(invalid, 'not a media file');
  await assert.rejects(probeVideoInfo(invalid), /Unable to parse/);
  await assert.rejects(
    probeVideoInfo(path.join(output, 'missing.mp4')),
    /not found/,
  );
  const empty = path.join(output, 'empty.mp4');
  fs.writeFileSync(empty, '');
  await assert.rejects(probeVideoInfo(empty), /empty/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(probeVideoInfo(silent, aborted.signal), /abort|cancel/i);

  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  try {
    let timeout;
    let cleared;
    let proc;
    let options;
    const timer = {};
    global.setTimeout = (callback, delay) => {
      assert.equal(delay, 15000);
      timeout = callback;
      cleared = false;
      return timer;
    };
    global.clearTimeout = (value) => {
      assert.equal(value, timer);
      cleared = true;
    };
    spawnOverride = (_command, _args, opts) => {
      options = opts;
      proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kills = [];
      proc.kill = (signal) => {
        proc.kills.push(signal);
        return true;
      };
      return proc;
    };
    const metadata =
      'Duration: 00:00:01.00\nStream #0:0: Video: h264, yuv420p, 320x180\nStream #0:1: Audio: aac\n';
    const begin = (signal) => {
      const state = { settled: false, value: null, error: null };
      state.done = probeVideoInfo(silent, signal)
        .then(
          (value) => {
            state.value = value;
          },
          (error) => {
            state.error = error;
          },
        )
        .finally(() => {
          state.settled = true;
        });
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe']);
      assert.equal(options.signal, signal);
      return state;
    };
    let state = begin();
    proc.stderr.emit('data', metadata);
    proc.emit('error', new Error('Injected spawn failure'));
    await Promise.resolve();
    assert.equal(
      state.settled,
      false,
      'wait for close before releasing the process',
    );
    proc.emit('close', 1);
    await state.done;
    assert.match(state.error.message, /Injected spawn failure/);
    assert.equal(cleared, true);

    state = begin();
    proc.stderr.emit('data', metadata);
    timeout();
    assert.deepEqual(proc.kills, ['SIGKILL']);
    assert.equal(state.settled, false);
    proc.emit('close', null);
    await state.done;
    assert.match(state.error.message, /timed out/);
    assert.equal(cleared, true);

    const cancel = new AbortController();
    state = begin(cancel.signal);
    proc.stderr.emit('data', metadata);
    cancel.abort();
    proc.emit('close', null);
    await state.done;
    assert.match(state.error.message, /cancelled/);

    state = begin();
    proc.stderr.emit('data', metadata);
    proc.stderr.emit('data', 'x'.repeat(2 * 1024 * 1024));
    proc.emit('close', 1);
    await state.done;
    assert.match(state.error.message, /Unable to parse/);
    assert.ok(
      state.error.message.length < 350,
      'bounded diagnostic without retaining oversized stderr',
    );

    state = begin();
    for (const chunk of [metadata.slice(0, 15), metadata.slice(15)])
      proc.stderr.emit('data', chunk);
    proc.emit('close', 1);
    await state.done;
    assert.equal(state.error, null);
    assert.equal(state.value.hasAudio, true);
    assert.equal(cleared, true);
  } finally {
    global.setTimeout = nativeSetTimeout;
    global.clearTimeout = nativeClearTimeout;
    spawnOverride = undefined;
  }
  console.log(
    JSON.stringify({
      output,
      checks:
        'real silent/audible/corrupt/empty/missing media and pre-abort; injected close ordering, timeout kill, cancellation, bounded stderr, split metadata and timer cleanup',
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  });
