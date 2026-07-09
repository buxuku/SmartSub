/**
 * 闭环矫正验证（镜像生产路径）：speed=1 合成 → 实测 CJK 字符速率 →
 * >6.5 字/秒判「跨语言压缩」→ ffmpeg atempo 慢放到 4.5 字/秒（线性精确；
 * 模型 speed 参数实测悬崖式过冲不可用，见 git 历史 pass2 数据）。
 * 参考:demo.mp4 真实推荐选区(12.5s,存量超长参考,切块 limit=10 生效)。
 * 用法: node scripts/voice-clone/closed-loop-test.mjs
 */
import path from 'node:path';
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
const workerFile = path.join(
  root,
  'extraResources/sherpa/worker/tts-worker.js',
);
const smokeDir = path.join(root, 'node_modules/.cache/tts-smoke');
const modelDir = path.join(
  smokeDir,
  'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
);
const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');

const model = {
  modelType: 'zipvoice',
  encoder: path.join(modelDir, 'encoder.int8.onnx'),
  decoder: path.join(modelDir, 'decoder.int8.onnx'),
  vocoder: path.join(smokeDir, 'vocos_24khz.onnx'),
  tokens: path.join(modelDir, 'tokens.txt'),
  dataDir: path.join(modelDir, 'espeak-ng-data'),
  lexicon: path.join(modelDir, 'lexicon.txt'),
  numThreads: 4,
};
const REF = {
  wav: path.join(outDir, 'demo-suggested-ref.wav'),
  text: "I'm going to talk to you about some stuff that's in this book of mine that I hope will resonate with other things that you've already heard, and I'll try to make some connections myself in case you miss them.",
};
const CUES = [
  '我要和你谈谈我这本书里的一些东西',
  '我希望这能与你已经听到的其他事情产生共鸣 我会尝试',
  '为了自己建立一些联系 以防你错过 但我想开始',
  '如果你信奉什么教条，我称之为官方教条？',
  '官方的教条是这样的',
];
const MAX_CPS = 6.5;
const TARGET_CPS = 4.5;
const MIN_SPEED = 0.35;

function cjk(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) n += 1;
  }
  return n;
}

const worker = new Worker(workerFile, {
  env: {
    ...process.env,
    SHERPA_ONNX_LIB_DIR: libDir,
    PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
  },
});
const pending = new Map();
let seq = 0;
worker.on('message', (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.type === 'done' ? p.resolve(msg) : p.reject(new Error(msg.message));
});
worker.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
function synth(payload) {
  const id = `s${++seq}`;
  const promise = new Promise((res, rej) =>
    pending.set(id, { resolve: res, reject: rej }),
  );
  worker.postMessage({ type: 'synthesize', id, model, sid: 0, ...payload });
  return promise;
}

/** atempo 链分解（单级 [0.5,2]，与 audioPipeline.buildAtempoChain 同逻辑）。 */
function atempoChain(factor) {
  const chain = [];
  let f = factor;
  while (f > 2) {
    chain.push(2);
    f /= 2;
  }
  while (f < 0.5) {
    chain.push(0.5);
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-3 || chain.length === 0) chain.push(f);
  return chain;
}

for (const [i, text] of CUES.entries()) {
  const chars = cjk(text);
  const pass1 = path.join(outDir, `cl-cue${i}-pass1.wav`);
  const r1 = await synth({
    text,
    speed: 1,
    outWavPath: pass1,
    generationConfig: { refWavPath: REF.wav, refText: REF.text },
  });
  const rate1 = chars / (r1.durationMs / 1000);
  let line = `cue${i} (${chars}字) pass1: ${(r1.durationMs / 1000).toFixed(2)}s ${rate1.toFixed(1)}字/s`;
  if (rate1 > MAX_CPS) {
    const factor = Math.max(MIN_SPEED, TARGET_CPS / rate1);
    const corrected = path.join(outDir, `cl-cue${i}-corrected.wav`);
    const filters = atempoChain(factor)
      .map((v) => `atempo=${v}`)
      .join(',');
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      pass1,
      '-af',
      filters,
      '-c:a',
      'pcm_s16le',
      '-y',
      corrected,
    ]);
    const durSec = r1.durationMs / 1000 / factor;
    line += ` → atempo ${factor.toFixed(2)} → ${durSec.toFixed(2)}s ${(chars / durSec).toFixed(1)}字/s → ${path.basename(corrected)}`;
  }
  console.log(line);
}
console.log('\n请试听 cl-cue*-corrected.wav 与 cl-cue*-pass1.wav 对比清晰度');
await worker.terminate();
