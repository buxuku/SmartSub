/**
 * gtcrn 本地降噪冒烟：干净语音 + 白噪声混合 → sherpa-worker denoise 消息 →
 * 用质检管线的 SNR 估算对比降噪前后。用法: node scripts/voice-clone/denoise-smoke.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(root, 'extraResources/sherpa/native', platformKey);
const asrWorkerFile = path.join(
  root,
  'extraResources/sherpa/worker/sherpa-worker.js',
);
const denoiseModel = path.join(
  root,
  'extraResources/sherpa/denoise/gtcrn_simple.onnx',
);
const vadModel = path.join(root, 'extraResources/sherpa/vad/silero_vad.onnx');
const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');
const cleanWav = path.join(
  root,
  'node_modules/.cache/tts-smoke/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia/test_wavs/leijun-1.wav',
);

fs.mkdirSync(outDir, { recursive: true });
const noisyWav = path.join(outDir, 'denoise-noisy.wav');
const denoisedWav = path.join(outDir, 'denoise-out.wav');

// 干净语音 + 白噪（-25dB 量级）混合成嘈杂样本（16k mono）。
execFileSync(FFMPEG, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  cleanWav,
  '-f',
  'lavfi',
  '-i',
  'anoisesrc=color=white:amplitude=0.03:duration=15',
  '-filter_complex',
  '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[out]',
  '-map',
  '[out]',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'pcm_s16le',
  '-y',
  noisyWav,
]);

const worker = new Worker(asrWorkerFile, {
  env: {
    ...process.env,
    SHERPA_ONNX_LIB_DIR: libDir,
    PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
  },
});
function call(payload) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (msg.id !== payload.id) return;
      worker.removeListener('message', onMsg);
      msg.type === 'done' ? resolve(msg) : reject(new Error(msg.message));
    };
    worker.on('message', onMsg);
    worker.postMessage(payload);
  });
}

const t = Date.now();
await call({
  type: 'denoise',
  id: 'd1',
  audioFile: noisyWav,
  denoiseModel,
  outFile: denoisedWav,
});
console.log(`降噪耗时 ${Date.now() - t}ms`);

// SNR 前后对比（silero 段 + 质检管线估算，与应用同法）。
const ra = require(
  path.join(
    root,
    'node_modules/.cache/voice-clone-tests/main/helpers/voiceClone/referenceAudio.js',
  ),
);
const { readWavInfo } = require(
  path.join(
    root,
    'node_modules/.cache/voice-clone-tests/main/helpers/dubbing/audioPipeline.js',
  ),
);
async function measure(wav) {
  const segments = (
    await call({
      type: 'detectSpeech',
      id: `v-${path.basename(wav)}`,
      audioFile: wav,
      vadModel,
      params: {
        vad_threshold: 0.5,
        vad_min_silence_duration_ms: 300,
        vad_min_speech_duration_ms: 200,
        vad_max_speech_duration_s: 0,
      },
    })
  ).segments.map((s) => ({
    startMs: Math.round(s.start * 1000),
    endMs: Math.round(s.end * 1000),
  }));
  const info = readWavInfo(wav);
  const buf = fs.readFileSync(wav);
  const count = Math.floor(info.dataBytes / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1)
    samples[i] = buf.readInt16LE(info.dataOffset + i * 2) / 32768;
  const frames = ra.analyzeSampleFrames(samples, info.sampleRate);
  const durationMs = Math.round((count / info.sampleRate) * 1000);
  return ra.estimateSnrDb(frames, segments, 0);
}
const snrBefore = await measure(noisyWav);
const snrAfter = await measure(denoisedWav);
console.log(
  `SNR: 加噪样本 ${snrBefore.toFixed(1)}dB → 降噪后 ${snrAfter.toFixed(1)}dB`,
);
if (snrAfter <= snrBefore) {
  console.error('降噪未提升 SNR');
  process.exit(1);
}
console.log('denoise smoke OK');
await worker.terminate();
