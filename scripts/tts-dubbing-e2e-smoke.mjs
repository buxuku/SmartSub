/**
 * 阶段 C 端到端冒烟：SRT 台词 → Kokoro 合成 → 对齐引擎 → atempo → 整轨 wav。
 * 调用产品 dubbingAlignment 纯函数；合成走 tts-worker.js（与 tts-runtime-smoke 相同）。
 * 断言：整轨零重叠。
 *
 * 用法:
 *   node scripts/tts-dubbing-e2e-smoke.mjs          # 合成 PCM，验证对齐+atempo+零重叠
 *   node scripts/tts-dubbing-e2e-smoke.mjs --live   # 真实 Kokoro 合成（需模型，内存充足）
 */
import { Worker } from 'node:worker_threads';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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
const ffmpegPath = require(path.join(root, 'node_modules', 'ffmpeg-static'));
const cacheOut = path.join(root, 'node_modules', '.cache', 'tts-smoke', 'out');
const alignOutDir = path.join(root, 'node_modules', '.cache', 'tts-dubbing-e2e');

function compileAlignment() {
  fs.mkdirSync(alignOutDir, { recursive: true });
  execSync(
    [
      'npx tsc',
      path.join(root, 'main/helpers/dubbingAlignment.ts'),
      '--outDir',
      alignOutDir,
      '--module commonjs',
      '--moduleResolution node',
      '--target es2019',
      '--esModuleInterop',
      '--skipLibCheck',
    ].join(' '),
    { cwd: root, stdio: 'pipe' },
  );
  return require(path.join(alignOutDir, 'dubbingAlignment.js'));
}

const {
  trimSilence,
  normalizeSegmentRms,
  planDubbingTimeline,
  analyzePlacements,
} = compileAlignment();
function writeWav(samples, sampleRate, outPath) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(outPath, buf);
}

function readWav(file) {
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

function atempo(samples, sr, factor, tmpDir, tag) {
  const inFile = path.join(tmpDir, `in-${tag}.wav`);
  const outFile = path.join(tmpDir, `out-${tag}.wav`);
  writeWav(samples, sr, inFile);
  execFileSync(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inFile,
    '-filter:a',
    `atempo=${factor.toFixed(4)}`,
    '-c:a',
    'pcm_s16le',
    '-y',
    outFile,
  ]);
  return readWav(outFile);
}

if (!fs.existsSync(path.join(libDir, 'sherpa-onnx.node'))) {
  console.error(`native lib not found: ${libDir}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(modelDir, 'model.int8.onnx'))) {
  console.error(`kokoro model missing: ${modelDir}`);
  process.exit(1);
}

const CUES = [
  { start: 0.5, end: 5.0, text: '大家好,欢迎收看本期节目,今天我们请到了一位特别嘉宾。' },
  { start: 5.2, end: 9.5, text: '主持人好,观众朋友们大家好,很高兴来到这里。' },
  { start: 9.8, end: 14.5, text: '听说你们的软件把语音合成也做成了完全本地运行?' },
  {
    start: 14.7,
    end: 17.2,
    text: '是的,转写、翻译、校对、配音,全流程都不需要把文件上传到云端,隐私完全无忧。',
  },
  { start: 17.6, end: 21.0, text: '那我们马上开始今天的正式话题吧。' },
];

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

const LIVE = process.argv.includes('--live');

function synthMock(durationSec, sr) {
  const n = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  return out;
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

async function runLiveSynth(w, modelReq, cues, waiters, setReadyWaiter) {
  function load() {
    return new Promise((res) => {
      setReadyWaiter(res);
      w.postMessage({ type: 'load', ...modelReq });
    });
  }
  function synth(id, text, sid) {
    return new Promise((res) => {
      waiters.set(id, res);
      w.postMessage({ type: 'synthesize', id, text, sid, speed: 1.0, ...modelReq });
    });
  }
  const ready = await load();
  const sampleRate = ready.sampleRate;
  const segments = [];
  for (let i = 0; i < cues.length; i++) {
    const msg = await synth(`s${i}`, cues[i].text, i % 2 === 0 ? 10 : 80);
    if (msg.type !== 'done') throw new Error(msg.message || 'synth failed');
    const pcm = loadWorkerPcm(msg);
    const trimmed = trimSilence(pcm.samples, pcm.sampleRate);
    const normalized = normalizeSegmentRms(trimmed);
    segments.push({
      samples: normalized,
      dur: normalized.length / sampleRate,
    });
    console.log(`  cue#${i + 1} dur=${segments[segments.length - 1].dur.toFixed(2)}s`);
  }
  return { segments, sampleRate };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-dub-e2e-'));
fs.mkdirSync(cacheOut, { recursive: true });

const MOCK_DURS = [4.2, 3.8, 4.5, 5.6, 2.9];
let segments = [];
let sr = 24_000;

if (LIVE) {
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
  console.log('Pass1 (live): Kokoro synthesize + trim + normalize…');
  const live = await runLiveSynth(w, req, CUES, waiters, (fn) => {
    readyWaiter = fn;
  });
  segments = live.segments;
  sr = live.sampleRate;
  w.terminate();
} else {
  console.log('Pass1 (mock): synthetic PCM segments…');
  for (let i = 0; i < CUES.length; i++) {
    const samples = synthMock(MOCK_DURS[i], sr);
    const trimmed = trimSilence(samples, sr);
    const normalized = normalizeSegmentRms(trimmed);
    segments.push({
      samples: normalized,
      dur: normalized.length / sr,
    });
    console.log(`  cue#${i + 1} dur=${segments[i].dur.toFixed(2)}s`);
  }
}

const speechDurations = segments.map((s) => s.dur);
const placements = planDubbingTimeline(CUES, speechDurations, 'balanced');
const report = analyzePlacements(placements);
console.log(
  `Pass2: plan speed factor≈${placements[0]?.atempoFactor?.toFixed(3) ?? 1}, overlap=${report.overlapTotalSec.toFixed(4)}s`,
);

const processed = placements.map((p, i) => {
  const seg = segments[p.index];
  if (p.atempoFactor <= 1.001) return seg.samples;
  return atempo(seg.samples, sr, p.atempoFactor, tmpDir, String(i));
});

const last = placements[placements.length - 1];
const totalSec = Math.max(last.start + last.durationSec, CUES.at(-1).end) + 0.3;
const track = new Float32Array(Math.ceil(totalSec * sr));
for (let pi = 0; pi < placements.length; pi++) {
  const p = placements[pi];
  const off = Math.round(p.start * sr);
  const samples = processed[pi];
  for (let j = 0; j < samples.length && off + j < track.length; j++) {
    track[off + j] = samples[j];
  }
}

const outFile = path.join(cacheOut, 'dubbed-track-product-pipeline.wav');
writeWav(track, sr, outFile);
console.log(`Wrote ${outFile} (${(track.length / sr).toFixed(2)}s)`);

if (report.overlapTotalSec > 0.001) {
  console.error(`FAIL: overlap ${report.overlapTotalSec}s`);
  process.exit(1);
}
if (!report.monotonic) {
  console.error('FAIL: non-monotonic timeline');
  process.exit(1);
}

console.log('ALL PASS (zero overlap, monotonic timeline)');
fs.rmSync(tmpDir, { recursive: true, force: true });
