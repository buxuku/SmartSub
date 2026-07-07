/**
 * 阶段 A 冒烟：驱动产品 tts-worker.js（worker_threads 协议往返）。
 * 模型用探索期已解包的 kokoro（node_modules/.cache/tts-smoke），不触网。
 *
 * 用法: node scripts/tts-runtime-smoke.mjs
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(root, 'extraResources', 'sherpa', 'native', platformKey);
const workerPath = path.join(root, 'extraResources', 'sherpa', 'worker', 'tts-worker.js');
const modelDir = path.join(
  root,
  'node_modules',
  '.cache',
  'tts-smoke',
  'kokoro-int8-multi-lang-v1_1',
);

if (!fs.existsSync(path.join(libDir, 'sherpa-onnx.node'))) {
  console.error(`native lib not found: ${libDir}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(modelDir, 'model.int8.onnx'))) {
  console.error(`kokoro model missing: ${modelDir}`);
  console.error('请在应用「引擎与模型」页下载 Kokoro TTS 模型，或手动解压到上述目录');
  process.exit(1);
}

const req = {
  modelFamily: 'kokoro',
  files: {
    model: path.join(modelDir, 'model.int8.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
    voices: path.join(modelDir, 'voices.bin'),
    dataDir: path.join(modelDir, 'espeak-ng-data'),
    lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
      .map((f) => path.join(modelDir, f))
      .join(','),
    ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
      .map((f) => path.join(modelDir, f))
      .join(','),
  },
  numThreads: 2,
};

const w = new Worker(workerPath, {
  env: { ...process.env, SHERPA_ONNX_LIB_DIR: libDir },
});

const waiters = new Map();
let readyWaiter = null;
w.on('message', (msg) => {
  if (msg.type === 'ready') return readyWaiter?.(msg);
  const cb = waiters.get(msg.id);
  if (cb) {
    waiters.delete(msg.id);
    cb(msg);
  }
});
w.on('error', (e) => {
  console.error('worker error:', e);
  process.exit(1);
});

function load() {
  return new Promise((res) => {
    readyWaiter = res;
    w.postMessage({ type: 'load', ...req });
  });
}
function synth(id, text, sid, speed = 1.0) {
  return new Promise((res) => {
    waiters.set(id, res);
    w.postMessage({ type: 'synthesize', id, text, sid, speed, ...req });
  });
}

const t0 = Date.now();
const meta = await load();
console.log(
  `[1] load ok in ${Date.now() - t0}ms: numSpeakers=${meta.numSpeakers} sampleRate=${meta.sampleRate}`,
);
if (meta.numSpeakers !== 103 || meta.sampleRate !== 24000) {
  console.error('FAIL: unexpected meta');
  process.exit(1);
}

function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav data chunk missing');
}

function loadWorkerPcm(msg) {
  const samples = readWavPcm(msg.wavPath);
  try {
    fs.unlinkSync(msg.wavPath);
  } catch {
    /* ignore */
  }
  return { samples, sampleRate: msg.sampleRate };
}

const cue = '大家好,欢迎收看本期节目,今天聊聊本地语音合成。';
const r1 = await synth('s1', cue, 10);
if (r1.type !== 'done') {
  console.error('FAIL: synthesize error:', r1.message);
  process.exit(1);
}
const pcm1 = loadWorkerPcm(r1);
const dur1 = pcm1.samples.length / pcm1.sampleRate;
console.log(
  `[2] synthesize ok: ${dur1.toFixed(2)}s PCM(Float32Array=${pcm1.samples.constructor.name})`,
);
if (!(dur1 > 2 && dur1 < 10) || !(pcm1.samples instanceof Float32Array)) {
  console.error('FAIL: duration/type out of range');
  process.exit(1);
}

w.postMessage({ type: 'cancel', id: 's2' });
const r2 = await synth('s2', '这句应当被取消。', 10);
console.log(`[3] pre-cancel: type=${r2.type} code=${r2.code ?? ''}`);
if (r2.type !== 'error' || r2.code !== 'cancelled') {
  console.error('FAIL: pre-cancel not honored');
  process.exit(1);
}

const longText =
  '这是一个特别长的句子,用来验证在合成过程中间发出的取消信号能否让底层推理提前终止,'.repeat(
    3,
  );
const p3 = synth('s3', longText, 10);
setTimeout(() => w.postMessage({ type: 'cancel', id: 's3' }), 150);
const r3 = await p3;
console.log(`[4] mid-cancel: type=${r3.type} code=${r3.code ?? ''}`);
if (r3.type !== 'error' || r3.code !== 'cancelled') {
  console.error('FAIL: mid-cancel not honored');
  process.exit(1);
}

const r4 = await synth('s4', cue, 10, 1.3);
const pcm4 = loadWorkerPcm(r4);
const dur4 = pcm4.samples.length / pcm4.sampleRate;
console.log(`[5] speed=1.3: ${dur4.toFixed(2)}s (1.0x was ${dur1.toFixed(2)}s)`);
if (!(dur4 < dur1)) {
  console.error('FAIL: speed param ineffective');
  process.exit(1);
}

console.log('ALL PASS');
await w.terminate();
process.exit(0);
