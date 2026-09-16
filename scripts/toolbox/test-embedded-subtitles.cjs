const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');

const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      AbortController,
      require(request) {
        if (request === '../logger') return { logMessage() {} };
        if (request.startsWith('.'))
          return load(path.resolve(path.dirname(filename), `${request}.ts`));
        return require(request);
      },
    },
    { filename },
  );
  return module.exports;
}

async function main() {
  const extractor = load(
    path.resolve(
      __dirname,
      '../../main/helpers/toolbox/embeddedSubtitleExtractor.ts',
    ),
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-embedded-tests-'),
  );
  try {
    const subtitle = path.join(root, 'source.srt');
    fs.writeFileSync(
      subtitle,
      '1\n00:00:00,000 --> 00:00:01,000\nReal subtitle output\n',
    );
    const video = path.join(root, 'source.mkv');
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=size=32x32:duration=1',
      '-i',
      subtitle,
      '-map',
      '0:v',
      '-map',
      '1:s',
      '-map',
      '1:s',
      '-c:v',
      'libx264',
      '-c:s',
      'copy',
      video,
    ]);
    const config = {
      videoPath: video,
      streamIndices: [0, 1],
      targetFormat: 'srt',
    };
    const streams = await extractor.scanEmbeddedSubtitles(video);
    assert.equal(streams.length, 2);
    const originalOpen = fs.openSync;
    let partial;
    try {
      fs.openSync = (file, ...args) => {
        if (String(file).endsWith('_track2.srt'))
          throw Object.assign(
            new Error('Injected second track reservation failure'),
            { code: 'EACCES' },
          );
        return originalOpen(file, ...args);
      };
      partial = await extractor.extractEmbeddedSubtitles(config, 'partial');
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(partial.success, false);
    assert.match(partial.error, /second track reservation failure/);
    assert.equal(partial.extractedFiles.length, 1);
    assert.match(
      fs.readFileSync(partial.extractedFiles[0].outputPath, 'utf8'),
      /Real subtitle output/,
    );
    const retried = await extractor.extractEmbeddedSubtitles(
      { ...config, streamIndices: [1] },
      'retry',
    );
    assert.equal(retried.success, true);
    assert.equal(retried.extractedFiles.length, 1);
    assert.equal(fs.existsSync(path.join(root, 'source_track1_2.srt')), false);

    const cancelled = await extractor.extractEmbeddedSubtitles(
      config,
      'cancel',
      (percent) => {
        if (percent === 50)
          assert.equal(
            extractor.cancelEmbeddedSubtitleExtraction('cancel'),
            true,
          );
      },
    );
    assert.equal(cancelled.success, false);
    assert.match(cancelled.error, /cancelled/);
    assert.equal(cancelled.extractedFiles.length, 1);
    assert.equal(extractor.cancelEmbeddedSubtitleExtraction('cancel'), false);
    assert.equal(
      fs.existsSync(path.join(root, 'source_track2_2.srt')),
      false,
      'no next track after cancellation',
    );
    const scanning = extractor.extractEmbeddedSubtitles(config, 'scanning');
    assert.equal(extractor.cancelEmbeddedSubtitleExtraction('scanning'), true);
    const aborted = await scanning;
    assert.equal(aborted.success, false);
    assert.equal(aborted.extractedFiles.length, 0);
    const resumed = await extractor.extractEmbeddedSubtitles(
      { ...config, streamIndices: [1, 1] },
      'scanning',
    );
    assert.equal(resumed.success, true);
    assert.equal(
      resumed.extractedFiles.length,
      1,
      'duplicate track indices export once',
    );
    for (const patch of [
      { streamIndices: [] },
      { streamIndices: [-1] },
      { targetFormat: 'bad' },
      { outputDir: path.join(root, 'absent') },
    ]) {
      const failed = await extractor.extractEmbeddedSubtitles({
        ...config,
        ...patch,
      });
      assert.equal(failed.success, false);
      assert.equal(failed.extractedFiles.length, 0);
    }
    const invalid = path.join(root, 'invalid.mkv');
    fs.writeFileSync(invalid, 'Not a video');
    await assert.rejects(
      extractor.scanEmbeddedSubtitles(invalid),
      /Unable to scan/,
    );
    const failed = await extractor.extractEmbeddedSubtitles({
      ...config,
      videoPath: invalid,
    });
    assert.equal(failed.success, false);
    assert.equal(
      fs
        .readdirSync(root)
        .some((file) => fs.statSync(path.join(root, file)).size === 0),
      false,
      'no empty reservations remain',
    );
    console.log(
      'Embedded subtitles: real extraction, partial reservation failure, independent retry, scan and between-track cancellation, validation and cleanup passed.',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
