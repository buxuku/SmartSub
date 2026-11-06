import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {
  WaveformAccumulator,
  extractWaveform,
  loadProofreadWaveform,
  cancelProofreadWaveforms,
} from '../main/helpers/proofreadWaveform';
import {
  snapToSilence,
  timelineSplitPoint,
  validCueRange,
} from '../renderer/lib/waveformEditing';

async function main() {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-waveform-unit-'),
  );
  const file = path.join(output, 'peaks.wav');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=8000:duration=3',
    '-af',
    "volume=0:enable='between(t,1,2)'",
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  const data = await extractWaveform(file);
  assert.equal(data.duration, 3);
  assert.equal(data.peaks.length, 150);
  assert.ok(data.peaks[20] > 0.1);
  assert.equal(data.peaks[75], 0);
  assert.ok(data.silenceEdges.some((edge) => Math.abs(edge - 1) < 0.15));
  assert.ok(data.silenceEdges.some((edge) => Math.abs(edge - 2) < 0.15));
  assert.equal(
    await extractWaveform(file),
    data,
    'unchanged files reuse the envelope',
  );
  await assert.rejects(extractWaveform(path.join(output, 'missing.wav')));
  await assert.rejects(extractWaveform(output));
  await assert.rejects(extractWaveform('https://example.com/audio.wav'));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(extractWaveform(file, abort.signal));
  const pending = loadProofreadWaveform(10, 'cancel-me', file);
  cancelProofreadWaveforms(11, 'cancel-me');
  assert.equal((await pending).duration, 3, 'another window cannot cancel');
  const cancelled = loadProofreadWaveform(10, 'cancel-me', file);
  cancelProofreadWaveforms(10, 'cancel-me');
  await assert.rejects(cancelled);
  const noAudio = path.join(output, 'silent-video.mp4');
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=black:s=64x64:d=1',
    '-an',
    noAudio,
  ]);
  await assert.rejects(extractWaveform(noAudio), /audio|stream|matches/i);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=8000:cl=mono',
    '-t',
    '1',
    file,
  ]);
  const replaced = await extractWaveform(file);
  assert.equal(replaced.duration, 1);
  assert.deepEqual(replaced.silenceEdges, [0, 1]);
  assert.ok(replaced.peaks.every((peak) => peak === 0));
  const samples = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++)
    samples.writeInt16LE(i < 4000 ? 16384 : -8192, i * 2);
  const accumulator = new WaveformAccumulator();
  for (let i = 0; i < samples.length; i += 13)
    accumulator.add(samples.subarray(i, i + 13));
  const reduced = accumulator.finish();
  assert.equal(reduced.duration, 1);
  assert.equal(reduced.peaks.length, 50);
  assert.equal(reduced.peaks[0], 0.5);
  assert.equal(reduced.peaks.at(-1), 0.25);
  const partial = new WaveformAccumulator();
  partial.add(Buffer.from([1]));
  assert.throws(() => partial.finish(), /INVALID_PCM/);
  assert.throws(() => new WaveformAccumulator().finish(), /NO_AUDIO/);
  assert.equal(snapToSilence(0.94, [1, 2], 0.1), 1);
  assert.equal(snapToSilence(1.5, [1, 2], 0.1), 1.5);
  assert.equal(snapToSilence(2.04, [1, 2], 0.1), 2);
  assert.equal(timelineSplitPoint('abcd', 0.5), 2);
  assert.equal(timelineSplitPoint('a', 0.5), null);
  assert.equal(timelineSplitPoint('abcd', 0), null);
  assert.equal(timelineSplitPoint('abcd', 1), null);
  assert.equal(timelineSplitPoint('abcd', NaN), null);
  assert.equal(timelineSplitPoint('a\u0301bc', 0.3), 2);
  assert.ok(validCueRange(0, 0.001));
  for (const [start, end] of [
    [-1, 2],
    [1, Infinity],
    [NaN, 1],
    [1, 1.0001],
    [2, 1],
  ])
    assert.equal(validCueRange(start, end), false);
  console.log(
    `Waveform: real FFmpeg envelope, silence, cache, ownership/cancellation, PCM chunk boundaries and edit math passed. ${output}`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
