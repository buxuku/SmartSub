/** Real FFmpeg regressions for consistent first-audio selection across consumers. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-audio-streams-'));
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let passed = 0;
let failed = 0;

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
  if (request === 'electron') return { app: { getPath: () => root } };
  if (request.endsWith('/storeManager'))
    return { logMessage() {}, store: { get: () => ({}) } };
  // Exercise the real energy-based VAD fallback without requiring native models.
  if (request.endsWith('/sherpaOnnx/sherpaFunasrRuntime'))
    throw new Error('Native VAD is unavailable in this portable test');
  return originalLoad.call(this, request, parent, isMain);
};

function runFfmpeg(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function makeMultitrack(name, silentFirst = false, defaultSecond = false) {
  const source = path.join(root, name);
  runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    silentFirst
      ? 'anullsrc=r=24000:cl=mono:d=6'
      : 'sine=frequency=440:sample_rate=24000:duration=6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=24000:duration=6',
    '-map',
    '0:a',
    '-map',
    '1:a',
    '-ac:a:0',
    '1',
    '-ac:a:1',
    defaultSecond ? '1' : '2',
    '-disposition:a:0',
    '0',
    '-disposition:a:1',
    defaultSecond ? 'default' : '0',
    '-c:a',
    'pcm_s16le',
    source,
  ]);
  return source;
}

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n${error.stack || error}`);
  }
}

async function main() {
  const audio = require('../main/helpers/audioProcessor.ts');
  const clone = require('../main/helpers/voiceClone/cloneAudioPipeline.ts');
  const { extractWaveform } = require('../main/helpers/proofreadWaveform.ts');
  const { readWavInfo } = require('../main/helpers/dubbing/audioPipeline.ts');
  const { ensureTempDir } = require('../main/helpers/fileUtils.ts');
  const { CLONE_TARGET_RANGES } = require('../types/voiceClone.ts');
  const source = makeMultitrack('channels.mkv');

  const signalOf = (file) => {
    const info = readWavInfo(file);
    const bytes = fs.readFileSync(file);
    assert.equal(info.channels, 1);
    assert.equal(info.bitsPerSample, 16);
    let crossings = 0;
    let peak = 0;
    const samples = Math.floor(info.dataBytes / 2);
    for (let i = 0; i < samples; i++) {
      const sample = bytes.readInt16LE(info.dataOffset + i * 2);
      peak = Math.max(peak, Math.abs(sample));
      if (
        i &&
        sample > 0 &&
        bytes.readInt16LE(info.dataOffset + (i - 1) * 2) <= 0
      )
        crossings++;
    }
    return {
      ...info,
      peak,
      frequency: (crossings * info.sampleRate) / samples,
    };
  };
  const assertTone = (file, frequency) => {
    const signal = signalOf(file);
    assert.ok(
      Math.abs(signal.frequency - frequency) < 2,
      `expected ${frequency} Hz in ${path.basename(file)}, got ${signal.frequency}`,
    );
    assert.ok(signal.peak > 1000, 'the selected signal remains audible');
    return signal;
  };
  const clonePair = async (input, name) => {
    const session = await clone.analyzeCloneSource(input, 'zipvoice', {
      tempDir: root,
    });
    try {
      const prepared = await clone.prepareCloneReference(
        session,
        0,
        session.durationMs,
        CLONE_TARGET_RANGES.zipvoice,
        path.join(root, `${name}-reference.wav`),
      );
      return {
        analysis: signalOf(session.analysisWavPath),
        final: signalOf(prepared.refWavPath),
        report: prepared.report,
      };
    } finally {
      clone.disposeCloneAnalysisSession(session.id);
    }
  };

  await step(
    'clone analysis and final reference both use the first of distinct audio tracks',
    async () => {
      const pair = await clonePair(source, 'channels');
      assert.deepEqual(
        [Math.round(pair.analysis.frequency), Math.round(pair.final.frequency)],
        [440, 440],
        'the selected voice cannot change between preview and finalization',
      );
      assert.equal(pair.analysis.sampleRate, 16000);
      assert.equal(pair.final.sampleRate, 24000);
    },
  );

  await step(
    'transcription and waveform retain the first track when another has more channels',
    async () => {
      const output = path.join(root, 'extracted.wav');
      await audio.extractAudio(source, output);
      assertTone(output, 440);
      const waveform = await extractWaveform(source);
      assert.equal(waveform.duration, 6);
      assert.ok(waveform.peaks.every((peak) => peak > 0.1));
    },
  );

  await step(
    'a later default audio track does not override first-track selection',
    async () => {
      const input = makeMultitrack('default-second.mkv', false, true);
      const output = path.join(root, 'default-second.wav');
      await audio.extractAudio(input, output);
      assertTone(output, 440);
      const pair = await clonePair(input, 'default-second');
      assert.deepEqual(
        [Math.round(pair.analysis.frequency), Math.round(pair.final.frequency)],
        [440, 440],
      );
    },
  );

  await step(
    'silent first audio remains silent in extraction, clone analysis/finalization and waveform',
    async () => {
      const input = makeMultitrack('silent-first.mkv', true);
      const output = path.join(root, 'silent-first.wav');
      await audio.extractAudio(input, output);
      const pair = await clonePair(input, 'silent-first');
      const waveform = await extractWaveform(input);
      assert.deepEqual(
        [
          signalOf(output).peak,
          pair.analysis.peak,
          pair.final.peak,
          ...waveform.peaks,
        ],
        Array(3 + waveform.peaks.length).fill(0),
        'the audible second stream must not leak into any consumer',
      );
      assert.ok(pair.report.issues.some((issue) => issue.code === 'no-speech'));
    },
  );

  await step(
    'single-track media works with apostrophes, Unicode and filter punctuation in paths',
    async () => {
      const directory = path.join(root, "O'Brien 中文 [x],;");
      fs.mkdirSync(directory);
      const input = path.join(directory, "source ' [音频].wav");
      runFfmpeg([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=24000:duration=6',
        '-c:a',
        'pcm_s16le',
        input,
      ]);
      const output = path.join(directory, "output ' [音频].wav");
      await audio.extractAudio(input, output);
      assertTone(output, 660);
      const pair = await clonePair(input, "reference ' 中文 [x],;");
      assert.deepEqual(
        [Math.round(pair.analysis.frequency), Math.round(pair.final.frequency)],
        [660, 660],
      );
      const waveform = await extractWaveform(input);
      assert.equal(waveform.duration, 6);
      assert.ok(waveform.peaks.every((peak) => peak > 0.1));
    },
  );

  await step(
    'an old automatically selected audio cache is replaced by the first-track result',
    async () => {
      const stat = fs.statSync(source);
      const legacyKey = crypto
        .createHash('md5')
        .update(`${source}|${stat.size}|${Math.trunc(stat.mtimeMs)}`)
        .digest('hex');
      const legacyPath = path.join(ensureTempDir(), `${legacyKey}.wav`);
      runFfmpeg([
        '-i',
        source,
        '-map',
        '0:a:1',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        legacyPath,
      ]);
      assertTone(legacyPath, 880);
      const result = await audio.extractAudioFromVideo(
        { sender: { send() {} } },
        { filePath: source, uuid: crypto.randomUUID() },
      );
      assertTone(result, 440);
      assert.notEqual(result, legacyPath);
      assertTone(legacyPath, 880);
    },
  );

  await step(
    'a video without audio still returns the existing actionable extraction error',
    async () => {
      const input = path.join(root, 'no-audio.mp4');
      runFfmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=black:s=64x64:d=0.2',
        '-an',
        '-c:v',
        'libx264',
        input,
      ]);
      await assert.rejects(
        audio.extractAudio(input, path.join(root, 'no-audio.wav')),
        /不包含音频轨道/,
      );
    },
  );
  console.log(`Audio stream selection: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
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
    fs.rmSync(root, { recursive: true, force: true });
  });
