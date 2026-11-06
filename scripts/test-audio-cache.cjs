/**
 * Regression test for issue #510: the extracted-audio cache must not be reused
 * once the file at the same path has been replaced.
 *
 * Drives the real extractAudioFromVideo with the real ffmpeg-static binary and
 * the real fileUtils; only electron and the electron-store backed storeManager
 * are replaced. Every scenario is independent so a failure never hides the rest.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const logs = [];
let root;
let passed = 0;
let failed = 0;

// Whole-second timestamps: independent of the filesystem's mtime granularity.
const MTIME = {
  original: new Date('2024-03-01T00:00:00Z'),
  // A video downloaded earlier and then moved into place keeps its old mtime,
  // so it looks older than the audio that was cached for the file it replaces.
  older: new Date('2023-06-01T00:00:00Z'),
  newer: new Date('2025-01-01T00:00:00Z'),
};

require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => root } };
  if (request.endsWith('/storeManager'))
    return {
      logMessage: (message, level) =>
        logs.push({ message: String(message), level }),
      store: { get: () => ({}) },
    };
  return originalLoad.call(this, request, parent, isMain);
};

const event = { sender: { send() {} } };
const logsSince = (mark) => logs.slice(mark).map((entry) => entry.message);

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    const detail = String(error?.message ?? error)
      .trim()
      .split('\n')
      .slice(0, 6)
      .join('\n         ');
    console.log(`FAIL - ${name}\n         ${detail}`);
  }
}

/**
 * Writes (or overwrites) <root>/<name>/视频 素材/videoplayback.wav with a sine
 * tone. The directory is CJK on purpose: cache file names must stay plain ASCII
 * (that is why the cache is keyed on an MD5 at all, see "fix: chinese path").
 * Byte size depends only on the duration, never on the frequency.
 */
function makeSource(name, { frequency, seconds, mtime }) {
  const dir = path.join(root, name, '视频 素材');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'videoplayback.wav');
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=24000:duration=${seconds}`,
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

async function run() {
  const audio = require('../main/helpers/audioProcessor.ts');
  const { ensureTempDir } = require('../main/helpers/fileUtils.ts');
  const { readWavInfo } = require('../main/helpers/dubbing/audioPipeline.ts');

  const extract = async (filePath) => {
    const file = { filePath, uuid: crypto.randomUUID() };
    const result = await audio.extractAudioFromVideo(event, file);
    assert.equal(
      file.tempAudioFile,
      result,
      'file.tempAudioFile follows the result',
    );
    return result;
  };
  const durationMs = (wav) => readWavInfo(wav).durationMs;
  // Zero-crossing estimate: enough to tell a 440 Hz tone from an 880 Hz one.
  const frequencyOf = (wav) => {
    const info = readWavInfo(wav);
    const bytes = fs.readFileSync(wav);
    const samples = Math.floor(info.dataBytes / 2);
    let crossings = 0;
    for (let i = 1; i < samples; i++) {
      if (
        bytes.readInt16LE(info.dataOffset + (i - 1) * 2) <= 0 &&
        bytes.readInt16LE(info.dataOffset + i * 2) > 0
      )
        crossings++;
    }
    return (crossings * info.sampleRate) / samples;
  };
  const near = (actual, expected, tolerance, label) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${label}: expected about ${expected}, got ${actual}`,
    );

  await step(
    'replacing the file at the same path re-extracts instead of reusing the old audio (#510)',
    async () => {
      const source = makeSource('replaced', {
        frequency: 440,
        seconds: 1,
        mtime: MTIME.original,
      });
      const first = await extract(source);
      near(frequencyOf(first), 440, 15, 'first extraction frequency');
      near(durationMs(first), 1000, 60, 'first extraction duration');

      // A different video lands on the very same path.
      makeSource('replaced', {
        frequency: 880,
        seconds: 2,
        mtime: MTIME.older,
      });
      const mark = logs.length;
      const second = await extract(source);

      assert.notEqual(
        second,
        first,
        'the replaced file must not share a cache entry',
      );
      near(durationMs(second), 2000, 60, 'second extraction duration');
      near(frequencyOf(second), 880, 20, 'second extraction frequency');
      assert.ok(
        !logsSince(mark).some((m) => m.startsWith('Using existing audio file')),
        'the second extraction must not report a cache hit',
      );
    },
  );

  await step('an unchanged file still reuses its cached audio', async () => {
    const source = makeSource('unchanged', {
      frequency: 440,
      seconds: 1,
      mtime: MTIME.original,
    });
    const first = await extract(source);
    const cachedAt = fs.statSync(first).mtimeMs;

    const mark = logs.length;
    const second = await extract(source);
    const seen = logsSince(mark);

    assert.equal(second, first);
    assert.ok(seen.some((m) => m.startsWith('Using existing audio file')));
    assert.ok(!seen.some((m) => m.startsWith('extract audio start')));
    assert.equal(
      fs.statSync(second).mtimeMs,
      cachedAt,
      'cached audio is not rewritten',
    );
  });

  await step(
    'the same byte size with a different mtime is a different file',
    async () => {
      const source = makeSource('same-size', {
        frequency: 440,
        seconds: 1,
        mtime: MTIME.original,
      });
      const sizeBefore = fs.statSync(source).size;
      const first = await extract(source);

      makeSource('same-size', {
        frequency: 880,
        seconds: 1,
        mtime: MTIME.newer,
      });
      assert.equal(
        fs.statSync(source).size,
        sizeBefore,
        'fixture keeps the byte size',
      );
      const second = await extract(source);

      assert.notEqual(
        second,
        first,
        'mtime alone must invalidate the cache entry',
      );
      near(frequencyOf(second), 880, 20, 'second extraction frequency');
    },
  );

  await step('a missing source never serves a stale cache entry', async () => {
    const dir = path.join(root, 'missing', '视频 素材');
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'videoplayback.wav'); // never created
    // The name the pre-fix code gave the cache entry of this path.
    const legacy = path.join(
      ensureTempDir(),
      `${crypto.createHash('md5').update(source).digest('hex')}.wav`,
    );
    fs.writeFileSync(legacy, 'audio left behind by an earlier video');

    const mark = logs.length;
    await assert.rejects(() =>
      audio.extractAudioFromVideo(event, {
        filePath: source,
        uuid: crypto.randomUUID(),
      }),
    );
    assert.ok(
      !logsSince(mark).some((m) => m.startsWith('Using existing audio file')),
      'a source that cannot be read must not be answered from the cache',
    );
  });

  await step(
    'getAudioCacheKey is ASCII-safe and tracks path, size and mtime',
    async () => {
      const { getAudioCacheKey } = require('../main/helpers/audioCacheKey.ts');
      const source = makeSource('key', {
        frequency: 440,
        seconds: 1,
        mtime: MTIME.original,
      });
      const key = getAudioCacheKey(source);

      assert.match(
        key,
        /^[0-9a-f]{32}$/,
        'plain ASCII even under a CJK directory',
      );
      assert.equal(
        getAudioCacheKey(source),
        key,
        'stable while the file is untouched',
      );

      const sibling = path.join(path.dirname(source), 'copy.wav');
      fs.copyFileSync(source, sibling);
      fs.utimesSync(sibling, MTIME.original, MTIME.original);
      assert.notEqual(
        getAudioCacheKey(sibling),
        key,
        'path is part of the key',
      );

      fs.utimesSync(source, MTIME.newer, MTIME.newer);
      assert.notEqual(
        getAudioCacheKey(source),
        key,
        'mtime is part of the key',
      );

      makeSource('key', { frequency: 440, seconds: 2, mtime: MTIME.original });
      assert.notEqual(getAudioCacheKey(source), key, 'size is part of the key');

      assert.equal(getAudioCacheKey(path.join(root, 'key', 'nope.wav')), null);
    },
  );
}

(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-audio-cache-'));
  try {
    await run();
    if (failed) {
      console.error(`Audio cache: ${failed} failed, ${passed} passed`);
      process.exitCode = 1;
    } else {
      console.log(`Audio cache: ${passed} checks passed`);
    }
  } finally {
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
