/**
 * SIGTRAP 复现/验证：用 demo.mp4 的真实建议选区做参考,合成 demo.zh.srt 的
 * 逐行文本(@ speed 0.6 跨语言补偿),对比「整行直合 vs 切块合成」的峰值 RSS。
 * 用法: node scripts/voice-clone/crash-repro.mjs [--chunk]
 */
import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

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
// 模拟用户音色:demo.mp4 真实推荐选区(0–12.5s,经 demo-suggest.ts 产出)
const REF = {
  wav: path.join(outDir, 'demo-suggested-ref.wav'),
  text: "I'm going to talk to you about some stuff that's in this book of mine that I hope will resonate with other things that you've already heard, and I'll try to make some connections myself in case you miss them.",
};
const CUES = [
  '我要和你谈谈我这本书里的一些东西',
  '我希望这能与你已经听到的其他事情产生共鸣 我会尝试',
  '为了自己建立一些联系 以防你错过 但我想开始',
  '如果你信奉什么教条，我称之为官方教条？',
  '所有西方工业社会的官方教条',
  '官方的教条是这样的',
  '如果我们有兴趣最大限度地利用油井',
];

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
  console.error('worker error:', e);
  process.exit(1);
});
function synth(payload) {
  const id = `s${++seq}`;
  const promise = new Promise((res, rej) =>
    pending.set(id, { resolve: res, reject: rej }),
  );
  worker.postMessage({
    type: 'synthesize',
    id,
    model,
    sid: 0,
    speed: 0.6,
    ...payload,
  });
  return promise;
}

let peakRss = 0;
const rssTimer = setInterval(() => {
  // worker 与主线程同进程,process.memoryUsage.rss 即全进程。
  const rss = process.memoryUsage.rss();
  if (rss > peakRss) peakRss = rss;
}, 50);

for (const [i, text] of CUES.entries()) {
  const t = Date.now();
  const r = await synth({
    text,
    outWavPath: path.join(outDir, `repro-cue${i}.wav`),
    generationConfig: { refWavPath: REF.wav, refText: REF.text },
  });
  console.log(
    `cue${i} (${text.length} chars) → ${(r.durationMs / 1000).toFixed(2)}s 合成${Date.now() - t}ms 峰值RSS=${Math.round(peakRss / 1048576)}MB`,
  );
}
clearInterval(rssTimer);
console.log(`\n最终峰值 RSS = ${Math.round(peakRss / 1048576)}MB`);
await worker.terminate();
