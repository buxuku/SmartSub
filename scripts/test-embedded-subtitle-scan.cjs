/**
 * Pre-start embedded subtitle probe.
 *
 * Part 1 drives the real scheduler (`scanForEmbeddedSubtitles`) with fake probes, so
 * early exit, the concurrency cap, the time budget, abort and failure handling are
 * deterministic. Part 2 runs the real `probeEmbeddedSubtitles` against small files
 * generated with the real ffmpeg-static binary, end to end through the scheduler.
 * Only electron and the logger (which needs electron) are replaced. Every scenario is
 * independent so a failure never hides the rest.
 */
const assert = require('node:assert/strict');
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
let passed = 0;
let failed = 0;

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
  if (request === 'electron') return {};
  if (request === './logger')
    return {
      logMessage: (message, level) =>
        logs.push({ message: String(message), level }),
    };
  return originalLoad.call(this, request, parent, isMain);
};

const root = path.resolve(__dirname, '..');
const { scanForEmbeddedSubtitles, normalizeScanFilePaths } = require(
  path.join(root, 'main/helpers/embeddedSubtitleScan.ts'),
);
const { probeEmbeddedSubtitles } = require(
  path.join(root, 'main/helpers/embeddedSubtitleProbe.ts'),
);
const {
  EMBEDDED_SCAN_CONCURRENCY,
  EMBEDDED_SCAN_BUDGET_MS,
  EMBEDDED_SCAN_MAX_PATHS,
} = require(path.join(root, 'types/embeddedSubtitle.ts'));

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

const text = (codec = 'subrip', language = 'eng') => ({
  subIndex: 0,
  codec,
  language,
  isText: true,
  isDefault: false,
  isForced: false,
});
const bitmap = (codec = 'hdmv_pgs_subtitle') => ({
  subIndex: 0,
  codec,
  language: undefined,
  isText: false,
  isDefault: false,
  isForced: false,
});
const mkv = (count) =>
  Array.from({ length: count }, (_, i) => `/media/video-${i}.mkv`);
/** A probe that waits until it is aborted (or `ms`), like a killed ffmpeg would. */
const waitForAbort = (signal, ms = 3000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), ms);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve([]);
      },
      { once: true },
    );
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function schedulerScenarios() {
  await step(
    'only string paths are accepted: deduped, capped, junk ignored',
    () => {
      assert.deepEqual(normalizeScanFilePaths(undefined), []);
      assert.deepEqual(normalizeScanFilePaths({}), []);
      assert.deepEqual(normalizeScanFilePaths({ filePaths: 'a.mkv' }), []);
      assert.deepEqual(
        normalizeScanFilePaths({
          filePaths: ['a.mkv', '', 7, null, 'a.mkv', 'b.mp4'],
        }),
        ['a.mkv', 'b.mp4'],
      );
      const many = normalizeScanFilePaths({
        filePaths: Array.from(
          { length: EMBEDDED_SCAN_MAX_PATHS + 50 },
          (_, i) => `/m/${i}.mkv`,
        ),
      });
      assert.equal(many.length, EMBEDDED_SCAN_MAX_PATHS);
    },
  );

  await step(
    'no candidates: nothing is probed and the answer is none',
    async () => {
      const probed = [];
      const result = await scanForEmbeddedSubtitles([], {
        probe: async (file) => (probed.push(file), []),
      });
      assert.equal(result.status, 'none');
      assert.equal(result.candidates, 0);
      assert.equal(result.checked, 0);
      assert.deepEqual(probed, []);
    },
  );

  await step(
    'only containers that can carry subtitles are probed, once each',
    async () => {
      const probed = [];
      const result = await scanForEmbeddedSubtitles(
        [
          '/m/a.mkv',
          '/m/a.mkv',
          '/m/b.MP4',
          '/m/c.avi',
          '/m/d.mp3',
          '/m/e.srt',
          '/m/f.wav',
          '/m/noext',
          'C:\\Videos\\g.mov',
        ],
        { probe: async (file) => (probed.push(file), []) },
      );
      assert.deepEqual(probed.sort(), [
        '/m/a.mkv',
        '/m/b.MP4',
        'C:\\Videos\\g.mov',
      ]);
      assert.equal(result.candidates, 3);
      assert.equal(result.status, 'none');
      assert.equal(result.checked, 3);
    },
  );

  await step('a hit reports the file and only its text tracks', async () => {
    const result = await scanForEmbeddedSubtitles(['/m/a.mkv'], {
      probe: async () => [
        bitmap(),
        text('subrip', 'eng'),
        { ...text('ass'), language: undefined },
      ],
    });
    assert.equal(result.status, 'found');
    assert.equal(result.hit.filePath, '/m/a.mkv');
    assert.deepEqual(result.hit.tracks, [
      { language: 'eng', codec: 'subrip' },
      { language: undefined, codec: 'ass' },
    ]);
  });

  await step('bitmap-only subtitle tracks are not a hit', async () => {
    const result = await scanForEmbeddedSubtitles(mkv(3), {
      probe: async () => [bitmap('hdmv_pgs_subtitle'), bitmap('dvd_subtitle')],
    });
    assert.equal(result.status, 'none');
    assert.equal(result.hit, undefined);
    assert.equal(result.checked, 3);
  });

  await step(
    'the first hit wins at once: the rest is aborted and never started',
    async () => {
      const files = mkv(20);
      const started = [];
      const aborted = [];
      const result = await scanForEmbeddedSubtitles(files, {
        probe: async (file, signal) => {
          started.push(file);
          if (file === files[2]) return [text()];
          const out = await waitForAbort(signal);
          if (signal.aborted) aborted.push(file);
          return out;
        },
      });
      assert.equal(result.status, 'found');
      assert.equal(result.hit.filePath, files[2]);
      assert.equal(result.checked, 1, 'only the hit ran to completion');
      assert.deepEqual(started, files.slice(0, EMBEDDED_SCAN_CONCURRENCY));
      assert.deepEqual(
        aborted.sort(),
        [files[0], files[1], files[3]],
        'the in-flight probes were told to stop',
      );
      assert.ok(result.elapsedMs < 1000, `answered in ${result.elapsedMs} ms`);
    },
  );

  await step(
    'no more than the concurrency cap probe at the same time',
    async () => {
      let running = 0;
      let peak = 0;
      const result = await scanForEmbeddedSubtitles(mkv(12), {
        concurrency: 3,
        probe: async () => {
          running++;
          peak = Math.max(peak, running);
          await delay(8);
          running--;
          return [];
        },
      });
      assert.equal(peak, 3);
      assert.equal(result.status, 'none');
      assert.equal(result.checked, 12);
    },
  );

  await step('the default concurrency is the shared constant', async () => {
    let running = 0;
    let peak = 0;
    await scanForEmbeddedSubtitles(mkv(EMBEDDED_SCAN_CONCURRENCY * 3), {
      probe: async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(5);
        running--;
        return [];
      },
    });
    assert.equal(peak, EMBEDDED_SCAN_CONCURRENCY);
  });

  await step(
    'running out of budget gives up: unknown, in time, probes told to stop',
    async () => {
      const aborted = [];
      const started = Date.now();
      const result = await scanForEmbeddedSubtitles(mkv(6), {
        budgetMs: 60,
        probe: async (file, signal) => {
          const out = await waitForAbort(signal);
          aborted.push(file);
          return out;
        },
      });
      const took = Date.now() - started;
      assert.equal(result.status, 'unknown');
      assert.equal(result.checked, 0);
      assert.equal(result.candidates, 6);
      assert.ok(took >= 50 && took < 500, `gave up after ${took} ms`);
      assert.equal(aborted.length, EMBEDDED_SCAN_CONCURRENCY);
    },
  );

  await step(
    'the budget holds even for a probe that ignores the abort signal',
    async () => {
      const started = Date.now();
      const result = await scanForEmbeddedSubtitles(mkv(3), {
        budgetMs: 50,
        probe: () => new Promise(() => {}),
      });
      assert.equal(result.status, 'unknown');
      assert.ok(Date.now() - started < 500);
    },
  );

  await step(
    'what was checked before the budget ran out is reported',
    async () => {
      const files = mkv(10);
      const result = await scanForEmbeddedSubtitles(files, {
        budgetMs: 80,
        concurrency: 1,
        probe: async (file, signal) =>
          files.indexOf(file) < 2 ? [] : waitForAbort(signal),
      });
      assert.equal(result.status, 'unknown');
      assert.equal(result.checked, 2);
      assert.equal(result.candidates, 10);
    },
  );

  await step(
    'a hit that arrives after the winner is ignored, even from a deaf probe',
    async () => {
      const files = mkv(2);
      const result = await scanForEmbeddedSubtitles(files, {
        concurrency: 2,
        probe: async (file) => {
          if (file === files[0]) {
            await delay(5);
            return [text('subrip', 'eng')];
          }
          await delay(40);
          return [text('ass', 'jpn')];
        },
      });
      assert.equal(result.status, 'found');
      assert.equal(result.hit.filePath, files[0]);
      assert.deepEqual(result.hit.tracks, [
        { language: 'eng', codec: 'subrip' },
      ]);
      await delay(60);
    },
  );

  await step(
    'a probe that throws or rejects counts as no result, the scan carries on',
    async () => {
      const files = mkv(4);
      const result = await scanForEmbeddedSubtitles(files, {
        probe: (file) => {
          if (file === files[0]) throw new Error('sync boom');
          if (file === files[1]) return Promise.reject(new Error('async boom'));
          return Promise.resolve(file === files[3] ? [text()] : []);
        },
      });
      assert.equal(result.status, 'found');
      assert.equal(result.hit.filePath, files[3]);
    },
  );

  await step('every probe failing is not an error and not a hit', async () => {
    const result = await scanForEmbeddedSubtitles(mkv(3), {
      probe: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(result.status, 'none');
    assert.equal(result.hit, undefined);
  });

  await step('an external abort ends the scan as unknown', async () => {
    const controller = new AbortController();
    const pending = scanForEmbeddedSubtitles(mkv(5), {
      signal: controller.signal,
      probe: (file, signal) => waitForAbort(signal),
    });
    await delay(15);
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.equal(result.checked, 0);
  });

  await step('an already aborted signal probes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const probed = [];
    const result = await scanForEmbeddedSubtitles(mkv(3), {
      signal: controller.signal,
      probe: async (file) => (probed.push(file), []),
    });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(probed, []);
  });

  await step('the default budget is one second', () => {
    assert.equal(EMBEDDED_SCAN_BUDGET_MS, 1000);
  });
}

function makeFixtures(dir) {
  const run = (args) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
  const srt = path.join(dir, 'cues.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,900\nHello\n');
  const video = ['-f', 'lavfi', '-i', 'color=size=32x32:duration=1'];
  const files = {
    plain: path.join(dir, 'plain.mkv'),
    withText: path.join(dir, 'with-text.mkv'),
    twoTracks: path.join(dir, 'two-tracks.mkv'),
    movText: path.join(dir, 'mov-text.mp4'),
    notAContainer: path.join(dir, 'broken.mkv'),
    avi: path.join(dir, 'ignored.avi'),
    missing: path.join(dir, 'missing.mkv'),
  };
  run([...video, '-c:v', 'libx264', files.plain]);
  run([
    ...video,
    '-i',
    srt,
    '-map',
    '0:v',
    '-map',
    '1:s',
    '-metadata:s:s:0',
    'language=eng',
    '-c:v',
    'libx264',
    '-c:s',
    'copy',
    files.withText,
  ]);
  run([
    ...video,
    '-i',
    srt,
    '-i',
    srt,
    '-map',
    '0:v',
    '-map',
    '1:s',
    '-map',
    '2:s',
    '-metadata:s:s:0',
    'language=jpn',
    '-metadata:s:s:1',
    'language=chi',
    '-c:v',
    'libx264',
    '-c:s',
    'copy',
    files.twoTracks,
  ]);
  run([
    ...video,
    '-i',
    srt,
    '-map',
    '0:v',
    '-map',
    '1:s',
    '-c:v',
    'libx264',
    '-c:s',
    'mov_text',
    files.movText,
  ]);
  fs.writeFileSync(files.notAContainer, 'this is not a matroska file');
  fs.copyFileSync(files.withText, files.avi);
  return files;
}

async function realFfmpegScenarios() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-embedded-scan-'));
  try {
    const files = makeFixtures(dir);

    await step(
      'real ffmpeg: a text track is reported with its language and codec',
      async () => {
        const streams = await probeEmbeddedSubtitles(files.withText);
        assert.equal(streams.length, 1);
        assert.equal(streams[0].isText, true);
        assert.equal(streams[0].codec, 'subrip');
        assert.equal(streams[0].language, 'eng');
      },
    );

    await step('real ffmpeg: every track is listed in order', async () => {
      const streams = await probeEmbeddedSubtitles(files.twoTracks);
      assert.deepEqual(
        streams.map((s) => [s.language, s.codec, s.isText]),
        [
          ['jpn', 'subrip', true],
          ['chi', 'subrip', true],
        ],
      );
    });

    await step(
      'real ffmpeg: mov_text in mp4 counts as a text track',
      async () => {
        const streams = await probeEmbeddedSubtitles(files.movText);
        assert.equal(streams.length, 1);
        assert.equal(streams[0].codec, 'mov_text');
        assert.equal(streams[0].isText, true);
      },
    );

    await step(
      'real ffmpeg: no subtitle track, a broken file and a missing file all give an empty answer',
      async () => {
        assert.deepEqual(await probeEmbeddedSubtitles(files.plain), []);
        assert.deepEqual(await probeEmbeddedSubtitles(files.notAContainer), []);
        assert.deepEqual(await probeEmbeddedSubtitles(files.missing), []);
      },
    );

    await step(
      'real ffmpeg: an already aborted signal answers at once without a result',
      async () => {
        const controller = new AbortController();
        controller.abort();
        const started = Date.now();
        assert.deepEqual(
          await probeEmbeddedSubtitles(
            files.withText,
            15000,
            controller.signal,
          ),
          [],
        );
        assert.ok(Date.now() - started < 200);
      },
    );

    await step(
      'real ffmpeg: aborting right after the start gives an empty answer and no warning',
      async () => {
        const mark = logs.length;
        const controller = new AbortController();
        const pending = probeEmbeddedSubtitles(
          files.withText,
          15000,
          controller.signal,
        );
        controller.abort();
        assert.deepEqual(await pending, []);
        assert.deepEqual(
          logs.slice(mark).filter((entry) => entry.level === 'warning'),
          [],
        );
      },
    );

    // A named pipe nobody writes to keeps ffmpeg blocked on open, so there is a live
    // child to abort. Skipped where there is no mkfifo / pgrep (Windows).
    await step(
      'real ffmpeg: aborting kills the child process instead of leaking it',
      async () => {
        if (process.platform === 'win32') return;
        const fifo = path.join(dir, 'blocked-fifo.mkv');
        try {
          execFileSync('mkfifo', [fifo]);
        } catch {
          return;
        }
        const alive = () => {
          try {
            return (
              execFileSync('pgrep', ['-f', fifo], { encoding: 'utf8' })
                .trim()
                .split('\n')
                .filter(Boolean).length > 0
            );
          } catch {
            return false; // pgrep exits 1 when nothing matches
          }
        };
        const controller = new AbortController();
        const pending = probeEmbeddedSubtitles(fifo, 30000, controller.signal);
        for (let i = 0; i < 50 && !alive(); i++) await delay(20);
        assert.equal(alive(), true, 'ffmpeg is running on the pipe');
        controller.abort();
        assert.deepEqual(await pending, []);
        for (let i = 0; i < 50 && alive(); i++) await delay(20);
        assert.equal(alive(), false, 'the aborted ffmpeg is gone');
      },
    );

    await step('real ffmpeg: the per-file timeout still applies', async () => {
      const mark = logs.length;
      assert.deepEqual(await probeEmbeddedSubtitles(files.withText, 1), []);
      assert.ok(
        logs.slice(mark).some((entry) => /timeout/.test(entry.message)),
      );
    });

    await step(
      'real ffmpeg: the scan finds the file with a text track among others',
      async () => {
        const result = await scanForEmbeddedSubtitles(
          [
            files.plain,
            files.notAContainer,
            files.missing,
            files.avi,
            files.twoTracks,
          ],
          {
            probe: (file, signal) => probeEmbeddedSubtitles(file, 5000, signal),
          },
        );
        assert.equal(result.status, 'found');
        assert.equal(result.hit.filePath, files.twoTracks);
        assert.deepEqual(result.hit.tracks, [
          { language: 'jpn', codec: 'subrip' },
          { language: 'chi', codec: 'subrip' },
        ]);
        assert.equal(result.candidates, 4, 'the avi is not a candidate');
      },
    );

    await step(
      'real ffmpeg: the scan answers none when nothing carries a text track',
      async () => {
        const result = await scanForEmbeddedSubtitles(
          [files.plain, files.notAContainer, files.missing, files.avi],
          {
            probe: (file, signal) => probeEmbeddedSubtitles(file, 5000, signal),
          },
        );
        assert.equal(result.status, 'none');
        assert.equal(result.checked, 3);
        assert.equal(result.candidates, 3);
      },
    );

    await step(
      'real ffmpeg: a hit among many files comes back long before the budget',
      async () => {
        const copies = Array.from({ length: 12 }, (_, i) => {
          const copy = path.join(dir, `copy-${i}.mkv`);
          fs.copyFileSync(i === 5 ? files.withText : files.plain, copy);
          return copy;
        });
        const result = await scanForEmbeddedSubtitles(copies, {
          probe: (file, signal) => probeEmbeddedSubtitles(file, 5000, signal),
        });
        assert.equal(result.status, 'found');
        assert.equal(result.hit.filePath, copies[5]);
        assert.ok(
          result.elapsedMs < EMBEDDED_SCAN_BUDGET_MS,
          `took ${result.elapsedMs} ms`,
        );
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await schedulerScenarios();
    await realFfmpegScenarios();
  } finally {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
