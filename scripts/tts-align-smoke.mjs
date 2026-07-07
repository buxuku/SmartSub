/**
 * 时长对齐可听化冒烟：调用产品 `dubbingAlignment` 规划 + sherpa 本地合成 + ffmpeg atempo。
 * 用于对照听感与零重叠断言（探索期脚本已归档，本脚本走产品代码路径）。
 *
 * 用法:
 *   node scripts/tts-align-smoke.mjs [--engine=kokoro|aishell3]
 *
 * 模型目录: node_modules/.cache/tts-smoke/{kokoro-int8-multi-lang-v1_1|vits-icefall-zh-aishell3}
 * （可通过应用内下载后复制，或沿用历史探索缓存）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
process.env.SHERPA_ONNX_LIB_DIR = path.join(
  root,
  'extraResources',
  'sherpa',
  'native',
  platformKey,
);
const sherpa = require(
  path.join(root, 'extraResources', 'sherpa', 'vendor', 'sherpa-onnx.js'),
);
const ffmpegPath = require(path.join(root, 'node_modules', 'ffmpeg-static'));

const engine = process.argv.includes('--engine=kokoro') ? 'kokoro' : 'aishell3';
const cacheDir = path.join(root, 'node_modules', '.cache', 'tts-smoke');
const outDir = path.join(cacheDir, 'out');
const alignOutDir = path.join(root, 'node_modules', '.cache', 'tts-align-smoke');
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-align-'));

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
  placedCuesToSrt,
} = compileAlignment();

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

function buildConfig() {
  if (engine === 'kokoro') {
    const dir = path.join(cacheDir, 'kokoro-int8-multi-lang-v1_1');
    return {
      model: {
        kokoro: {
          model: path.join(dir, 'model.int8.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
            .map((f) => path.join(dir, f))
            .join(','),
        },
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
      ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
        .map((f) => path.join(dir, f))
        .join(','),
      maxNumSentences: 1,
    };
  }
  const dir = path.join(cacheDir, 'vits-icefall-zh-aishell3');
  return {
    model: {
      vits: {
        model: path.join(dir, 'model.onnx'),
        lexicon: path.join(dir, 'lexicon.txt'),
        tokens: path.join(dir, 'tokens.txt'),
      },
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
    ruleFsts: ['phone.fst', 'date.fst', 'number.fst']
      .map((f) => path.join(dir, f))
      .join(','),
    maxNumSentences: 1,
  };
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
  throw new Error('wav: data chunk not found');
}

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

function atempo(samples, sr, factor, tag) {
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

const voiceSid = engine === 'kokoro' ? 10 : 0;
console.log(`engine=${engine} · Pass1 sherpa 合成(speed=1.0)+trim+normalize…`);
const tts = new sherpa.OfflineTts(buildConfig());
const sr = tts.sampleRate;
const t0 = Date.now();
const segments = CUES.map((cue, i) => {
  // enableExternalBuffer:true 在单进程冒烟中可用；产品 worker 走 wav 路径协议
  const audio = tts.generate({
    text: cue.text,
    sid: voiceSid,
    speed: 1.0,
    enableExternalBuffer: true,
  });
  const trimmed = trimSilence(audio.samples, sr);
  const normalized = normalizeSegmentRms(trimmed);
  const dur = normalized.length / sr;
  console.log(`  cue#${i + 1} dur=${dur.toFixed(2)}s`);
  return { samples: normalized, dur };
});
console.log(`  合成耗时 ${Date.now() - t0}ms`);

const placements = planDubbingTimeline(
  CUES,
  segments.map((s) => s.dur),
  'balanced',
);
const report = analyzePlacements(placements);
console.log(
  `Pass2 product plan: overlap=${report.overlapTotalSec.toFixed(4)}s maxDrift=${report.maxStartDriftSec.toFixed(3)}s`,
);

const processed = placements.map((p, i) => {
  const seg = segments[p.index];
  if (p.atempoFactor <= 1.001) return seg.samples;
  return atempo(seg.samples, sr, p.atempoFactor, String(i));
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

const outFile = path.join(outDir, `dubbed-track-${engine}-aligned.wav`);
writeWav(track, sr, outFile);
const srtFile = path.join(outDir, `dubbed-track-${engine}-aligned.srt`);
fs.writeFileSync(srtFile, placedCuesToSrt(placements), 'utf-8');
console.log(`Wrote ${outFile} (${(track.length / sr).toFixed(2)}s)`);
console.log(`Wrote ${srtFile}`);

for (const [i, p] of placements.entries()) {
  const drift = p.start - p.cue.start;
  console.log(
    `cue#${i + 1} [${p.start.toFixed(2)} → ${(p.start + p.durationSec).toFixed(2)}] drift+${drift.toFixed(2)}s atempo=${p.atempoFactor.toFixed(3)}`,
  );
}

if (report.overlapTotalSec > 0.001) {
  console.error(`FAIL: overlap ${report.overlapTotalSec}s`);
  process.exit(1);
}
if (!report.monotonic) {
  console.error('FAIL: non-monotonic timeline');
  process.exit(1);
}
console.log('ALL PASS');
