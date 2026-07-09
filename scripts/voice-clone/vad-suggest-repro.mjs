/**
 * 应用路径复现：silero VAD(经 ASR worker,与应用一致)取语音段 →
 * 新旧打分策略对比(纯占比 vs 能量感知)。定位「2.4h 课录选段落在微弱区」。
 * 用法: node scripts/voice-clone/vad-suggest-repro.mjs <16k单声道wav>
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
const vadModel = path.join(root, 'extraResources/sherpa/vad/silero_vad.onnx');

const wav = process.argv[2];
if (!wav) {
  console.error('usage: vad-suggest-repro <16k-mono-wav>');
  process.exit(1);
}

const worker = new Worker(asrWorkerFile, {
  env: {
    ...process.env,
    SHERPA_ONNX_LIB_DIR: libDir,
    PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
  },
});
const segments = await new Promise((resolve, reject) => {
  worker.on('message', (msg) => {
    if (msg.type === 'done') resolve(msg.segments);
    else if (msg.type === 'error') reject(new Error(msg.message));
  });
  worker.on('error', reject);
  worker.postMessage({
    type: 'detectSpeech',
    id: 'v1',
    audioFile: wav,
    vadModel,
    params: {
      vad_threshold: 0.5,
      vad_min_silence_duration_ms: 300,
      vad_min_speech_duration_ms: 200,
      vad_max_speech_duration_s: 0,
    },
  });
});
await worker.terminate();
const segMs = segments.map((s) => ({
  startMs: Math.round(s.start * 1000),
  endMs: Math.round(s.end * 1000),
}));
console.log(`silero VAD segments = ${segMs.length}`);
console.log(
  '前 10 段:',
  segMs
    .slice(0, 10)
    .map(
      (s) => `${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)}`,
    )
    .join(' '),
);

// 帧分析(直接读 wav,与管线同法)。
const fs = require('fs');
const { readWavInfo } = require(
  path.join(
    root,
    'node_modules/.cache/voice-clone-tests/main/helpers/dubbing/audioPipeline.js',
  ),
);
const ra = require(
  path.join(
    root,
    'node_modules/.cache/voice-clone-tests/main/helpers/voiceClone/referenceAudio.js',
  ),
);
const { CLONE_TARGET_RANGES } = require(
  path.join(root, 'node_modules/.cache/voice-clone-tests/types/voiceClone.js'),
);
const info = readWavInfo(wav);
const buf = fs.readFileSync(wav);
const count = Math.floor(info.dataBytes / 2);
const samples = new Float32Array(count);
for (let i = 0; i < count; i += 1) {
  samples[i] = buf.readInt16LE(info.dataOffset + i * 2) / 32768;
}
const durationMs = Math.round((count / info.sampleRate) * 1000);
const frames = ra.analyzeSampleFrames(samples, info.sampleRate);

const target = CLONE_TARGET_RANGES.zipvoice;
const plain = ra.suggestCloneSegment(segMs, durationMs, target);
const energyAware = ra.suggestCloneSegment(segMs, durationMs, target, frames);
function describe(label, s) {
  if (!s) {
    console.log(`${label}: null`);
    return;
  }
  const clipped = ra.clipSegmentsToRange(segMs, s.startMs, s.endMs);
  const wf = ra.sliceFrameAnalysis(frames, s.startMs, s.endMs);
  const db = ra.speechRmsDb(wf, clipped, s.startMs);
  console.log(
    `${label}: ${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)}s score=${s.score} 语音电平=${db.toFixed(1)}dB`,
  );
}
console.log(
  `全文件语音电平 90 分位 = ${ra.speechLevelReferenceDb(frames, segMs).toFixed(1)}dB`,
);
describe('纯占比打分(旧)', plain);
describe('能量感知打分(新)', energyAware);
